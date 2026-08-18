import { spawn } from "node:child_process";

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
      env: env ? { ...process.env, ...env } : process.env,
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
