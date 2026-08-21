import { spawnCapture, requireEnv } from "./run.mjs";

export const CODEX_ENTRY = requireEnv("CODEX_BRIDGE_ENTRY");
export const CODEX_CWD = requireEnv("CODEX_BRIDGE_CWD");
export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS || 300000);

/**
 * Build the argv for a headless codex exec run. shell:false => prompt is a safe argv element.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.sessionId]   Resume a specific prior session (uses `codex exec resume`).
 * @param {string} [o.model]       Model override (-m).
 * @param {"read-only"|"workspace-write"|"danger-full-access"} [o.sandbox]  Sandbox policy (-s).
 * @param {number} [o.cwdIndex]    Not used; cwd is passed to spawnCapture.
 * @returns {{entry:string, args:string[]}}
 */
export function buildCodexArgs({ prompt, sessionId, model, sandbox }) {
  if (sessionId) {
    // Resume an existing session.
    const args = ["exec", "resume", sessionId, "--json", "--skip-git-repo-check", prompt];
    if (model) args.push("-m", model);
    if (sandbox) args.push("-s", sandbox);
    return { entry: CODEX_ENTRY, args };
  }
  // New session.
  const args = ["exec", "--json", "--skip-git-repo-check", prompt];
  if (model) args.push("-m", model);
  if (sandbox) args.push("-s", sandbox);
  return { entry: CODEX_ENTRY, args };
}

/**
 * Parse codex's `--json` NDJSON output stream.
 *
 * Known event types (from real output):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,...}}
 *
 * @param {string} stdout
 * @returns {{threadId:string|null, text:string, usage:object|null, hadError:boolean}}
 */
export function parseCodexJson(stdout) {
  let threadId = null;
  let text = "";
  let usage = null;
  let hadError = false;

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue; // ignore any non-JSON noise
    }
    switch (o.type) {
      case "thread.started":
        threadId = o.thread_id ?? threadId;
        break;
      case "item.completed":
        if (o.item?.type === "agent_message" && typeof o.item.text === "string") {
          text = o.item.text;
        }
        break;
      case "turn.completed":
        if (o.usage) usage = o.usage;
        break;
      case "thread.failed":
      case "error":
        hadError = true;
        break;
    }
  }
  return { threadId, text, usage, hadError };
}

/**
 * Run codex once in headless JSON mode and return a normalised result.
 * @param {object} o  See buildCodexArgs, plus optional cwd/timeoutMs.
 */
export async function runCodex(o) {
  const { entry, args } = buildCodexArgs(o);
  const res = await spawnCapture(entry, args, {
    cwd: o.cwd || CODEX_CWD,
    timeoutMs: o.timeoutMs || CODEX_TIMEOUT_MS,
  });
  const parsed = parseCodexJson(res.stdout);
  return {
    threadId: parsed.threadId,
    text: parsed.text,
    usage: parsed.usage,
    exitCode: res.code,
    timedOut: res.timedOut,
    hadError: parsed.hadError || res.code !== 0 || res.timedOut,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}
