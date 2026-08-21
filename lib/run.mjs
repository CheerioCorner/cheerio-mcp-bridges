import { spawn } from "node:child_process";

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
 * Spawn a child process WITHOUT a shell (shell:false) and capture output.
 *
 * shell:false is a deliberate security choice: because no shell interprets the
 * argument list, arbitrary prompt text passed as an argv element cannot break
 * out into command injection. Callers therefore never need to escape prompts.
 *
 * @param {string} command  Absolute path to an executable (node.exe / agy.exe).
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
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: buildChildEnv(env),
      windowsHide: true,
      // stdin='ignore': both CLIs read piped stdin as extra context and would
      // otherwise BLOCK waiting for EOF on an open pipe. We only drive them via
      // argv, so give them a closed stdin.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Hard-kill shortly after if it ignores SIGTERM.
        setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
