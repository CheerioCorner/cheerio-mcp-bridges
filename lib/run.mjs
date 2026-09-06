import { spawn } from "node:child_process";
import { buildInvocation } from "./cli-entry.mjs";
import { codePageToLabel, decodeChildOutput, detectConsoleCodePage } from "./console-encoding.mjs";

/**
 * 子行程輸出的解碼方式（Windows 的 console code page）。
 *
 * 一支 CLI 在 Windows 上噴的錯誤可能來自兩個地方：CLI 自己（UTF-8）或
 * cmd.exe / Win32（console 的 OEM code page，這台機器是 CP950）。`toString()`
 * 一律 UTF-8，所以後者會整段變成 `�` —— 2026-09-06 doctor 就是這樣把一則講得
 * 很清楚的錯誤印成亂碼的。讀不懂的 stderr 跟被吞掉的 stderr 差不了多少，而
 * 「stderr 被吞掉」正是 2026-09-05 那 3 小時的成因。
 *
 * 探測只做一次，而且是在 spawn 之前就發動、在子行程結束時才 await —— 它跟 CLI
 * 平行跑，實務上早就回來了；就算沒有，它自己有 4 秒上限。失敗回 null＝維持
 * 純 UTF-8 解碼，也就是修好之前的行為。
 */
let oemLabelPromise = null;

function consoleOemLabel() {
  oemLabelPromise ??= detectConsoleCodePage()
    .then(codePageToLabel)
    .catch(() => null);
  return oemLabelPromise;
}

/**
 * Read a required environment variable or fail loudly.
 *
 * Bridges spawn CLIs pinned to paths (a workspace directory, a binary's
 * install location) that are inherently machine/user-specific. Baking any
 * one person's path in as a silent fallback means a teammate's
 * misconfigured (or unconfigured) server quietly runs against the wrong —
 * or a nonexistent — directory or binary. Failing at startup instead
 * surfaces the problem immediately, in the MCP connection status, instead
 * of letting it masquerade as a working server pointed at the wrong place.
 *
 * @param {string} name  Environment variable name.
 * @returns {string}
 */
export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This bridge has no built-in default — set ${name} in this ` +
        `MCP server's "env" block (see .mcp.json) to the absolute path for your machine.`
    );
  }
  return v;
}

/**
 * Proxy-related environment variable keys (both casings) that cause child
 * processes to route traffic through a proxy. When BRIDGE_BYPASS_PROXY is
 * active (the default), these are stripped from the child env so that the
 * CLI tools connect directly — avoiding issues where a corporate proxy's
 * egress IP is not on the target service's allow-list.
 *
 * NO_PROXY / no_proxy are intentionally excluded: they are exclusion lists
 * and do not cause traffic to be redirected.
 */
export const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

/**
 * Build the env object for a child process.
 *
 * 1. Always starts from a shallow copy of process.env (never a reference).
 * 2. Merges envOverride on top (callers can inject extra vars as before).
 * 3. Unless BRIDGE_BYPASS_PROXY is explicitly "false", strips all proxy keys
 *    so child CLIs connect directly.
 *
 * CRITICAL: this function must never mutate process.env. The copy-then-delete
 * pattern ensures the parent process's real environment is untouched.
 *
 * @param {object} [envOverride]  Extra env vars merged over process.env.
 * @returns {object} A fresh object safe to pass as spawn()'s env option.
 */
export function buildChildEnv(envOverride) {
  // Shallow copy — callers' overrides go on top of the copy, never on process.env.
  const merged = { ...process.env, ...(envOverride || {}) };

  // BRIDGE_BYPASS_PROXY: strip proxy vars by default. Only set to the literal
  // string "false" to disable stripping (let the child inherit the parent's proxy).
  const bypassProxy = process.env.BRIDGE_BYPASS_PROXY !== "false";

  if (bypassProxy) {
    for (const key of PROXY_KEYS) {
      delete merged[key];
    }
  }

  return merged;
}

/**
 * Absolute path to Windows' taskkill.
 *
 * Deliberately NOT resolved through PATH: some Node 24 builds fail the PATH
 * lookup for a bare "taskkill" and report it asynchronously as an 'error'
 * event, which is easy to miss and leaves the child alive. %SystemRoot% is
 * where Windows itself keeps it; C:\Windows is the fallback for the (rare)
 * case where the variable is missing.
 *
 * @param {object} [env]
 * @returns {string}
 */
export function taskkillPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return `${root}\\System32\\taskkill.exe`;
}

/**
 * Kill a child process AND everything it spawned.
 *
 * On POSIX, child.kill() signals the child; a well-behaved CLI passes it on.
 * On Windows there are no process groups to signal: child.kill() terminates
 * ONLY the direct child, and grandchildren are re-parented and keep running.
 * That matters here because pi 0.85 spawns its own server / session-worker
 * children — a timed-out run used to leave those orphaned, holding ports and
 * state until someone noticed.
 *
 * `taskkill /T` walks the tree; `/F` is unconditional (there is no graceful
 * step for a whole tree), so on Windows both the soft and hard attempts are
 * the same call. Failures fall back to child.kill() rather than throwing:
 * this runs from a timer, and an exception here would be unhandled.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {object} [o]
 * @param {string} [o.signal]      POSIX signal for the non-Windows path.
 * @param {string} [o.platform]    Override for tests.
 * @param {Function} [o.spawnFn]   Override for tests.
 * @param {object} [o.env]         Override for tests.
 * @returns {string} What was attempted: "taskkill" | "signal" | "noop".
 */
export function killProcessTree(
  child,
  { signal = "SIGTERM", platform = process.platform, spawnFn = spawn, env = process.env } = {}
) {
  const fallback = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process is already gone — nothing left to do.
    }
  };

  if (platform !== "win32") {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
    return "signal";
  }

  if (!child.pid) return "noop";

  let killer;
  try {
    killer = spawnFn(taskkillPath(env), ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
  } catch {
    fallback();
    return "taskkill";
  }
  // A failed spawn on Windows surfaces here, asynchronously — without this
  // handler it would become an uncaught 'error' event and crash the bridge.
  killer.on?.("error", fallback);
  return "taskkill";
}

/**
 * Spawn a child process WITHOUT a shell (shell:false) and capture output.
 *
 * shell:false is a deliberate security choice: because no shell interprets the
 * argument list, arbitrary prompt text passed as an argv element cannot break
 * out into command injection. Callers therefore never need to escape prompts.
 *
 * `command` goes through buildInvocation first, for two reasons. A `.cmd`/
 * `.bat` shim — which is what `where codex` and `where copilot` return on a
 * default Windows npm install — CANNOT be started by CreateProcess, so without
 * this every one of those bridges dies at spawn with EINVAL. And routing it
 * here means the cmd.exe escaping lives in exactly one place: `shell: true`,
 * whose unquoted argv concatenation was both the 2026-09-06 smoke failure and
 * an injection hole for prompt text, appears nowhere in this repo.
 * buildInvocation is idempotent for a plain executable, so callers that
 * already resolved their own entry (pi passes process.execPath) are unaffected.
 *
 * @param {string} command  Absolute path to an executable (node.exe / agy.exe / a .cmd shim).
 * @param {string[]} args   Argument vector. Prompt content is safe here.
 * @param {object} opts
 * @param {string} opts.cwd            Fixed working directory (pinned by server).
 * @param {number} [opts.timeoutMs]    Kill the child after this many ms.
 * @param {object} [opts.env]          Extra env vars merged over process.env.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number}>}
 */
export function spawnCapture(command, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timedOut = false;
    const inv = buildInvocation(command, args);
    // 先發動 code page 探測，讓它跟 CLI 平行跑。
    const oemLabel = consoleOemLabel();
    const child = spawn(inv.command, inv.args, {
      cwd,
      shell: false,
      windowsVerbatimArguments: !!inv.windowsVerbatimArguments,
      env: buildChildEnv(env),
      windowsHide: true,
      // stdin='ignore': both CLIs read piped stdin as extra context and would
      // otherwise BLOCK waiting for EOF on an open pipe. We only drive them via
      // argv, so give them a closed stdin.
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 收 Buffer、最後才解碼：一個多位元組字元可能被切在兩個 chunk 中間，
    // 逐塊 toString() 會把它拆壞 —— 而「這串位元組是不是合法 UTF-8」正是我們
    // 用來分辨 CLI 輸出與 cmd.exe 錯誤的依據，拆壞就判錯了。
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (c) => outChunks.push(Buffer.from(c)));
    child.stderr.on("data", (c) => errChunks.push(Buffer.from(c)));

    let timer = null;
    let hardTimer = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child, { signal: "SIGTERM" });
        // Escalate if it is still alive: SIGKILL on POSIX, a second tree kill
        // on Windows (where the first attempt may have raced process startup).
        hardTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killProcessTree(child, { signal: "SIGKILL" });
          }
        }, 3000);
        hardTimer.unref?.();
      }, timeoutMs);
    }

    child.on("error", (err) => {
      clearTimers();
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimers();
      // 先量時間再等解碼，不要把探測的等待算進 CLI 的耗時。
      const durationMs = Date.now() - started;
      oemLabel.then((label) => {
        resolve({
          code,
          signal,
          stdout: decodeChildOutput(Buffer.concat(outChunks), label),
          stderr: decodeChildOutput(Buffer.concat(errChunks), label),
          timedOut,
          durationMs,
        });
      });
    });
  });
}
