import { randomUUID } from "node:crypto";
import { spawnCapture, requireEnv } from "./run.mjs";

// ENTRY is resolvable at deploy time via env vars; the default targets this
// machine's install location. CWD has no default — see requireEnv in run.mjs.
export const PI_ENTRY =
  process.env.PI_BRIDGE_ENTRY ||
  "C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
export const PI_CWD = requireEnv("PI_BRIDGE_CWD");
export const PI_TIMEOUT_MS = Number(process.env.PI_BRIDGE_TIMEOUT_MS || 300000);

// Read-only built-in tool allowlist (no edit/write/bash).
export const READ_ONLY_TOOLS = "read,grep,find,ls";

/**
 * Build the argv for a headless pi run. No shell is involved, so `prompt`
 * is safe as a plain argv element regardless of its content.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.sessionId          Caller-supplied or generated UUID.
 * @param {boolean} [o.readOnly]        Restrict to read-only built-in tools.
 * @param {string} [o.model]            Model pattern/id override.
 * @param {boolean} [o.approveProject]  Trust project-local resources (pi -a).
 * @param {boolean} [o.enableExtensions] Load pi extensions (default OFF).
 * @returns {string[]}
 */
export function buildPiArgs({ prompt, sessionId, readOnly, model, approveProject, enableExtensions }) {
  const args = ["--mode", "json", "--session-id", sessionId, "-p", prompt];
  // Extensions are disabled by default: interactive/UI extensions such as
  // auto-annotate (plannotator) HANG a headless run because they wait on a UI
  // that never appears. Callers can opt back in with enableExtensions.
  if (!enableExtensions) args.push("--no-extensions");
  if (readOnly) args.push("--tools", READ_ONLY_TOOLS);
  if (model) args.push("--model", model);
  if (approveProject) args.push("-a"); // otherwise falls back to defaultProjectTrust (conservative)
  return args;
}

/**
 * Parse pi's `--mode json` NDJSON output stream.
 * @param {string} stdout
 * @returns {{sessionId:string|null, text:string, toolCalls:Array, usage:object|null, hadError:boolean}}
 */
export function parsePiJson(stdout) {
  let sessionId = null;
  let text = "";
  let usage = null;
  let hadError = false;
  const toolStarts = new Map();
  const toolCalls = [];

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
      case "session":
        sessionId = o.id ?? sessionId;
        break;
      case "tool_execution_start":
        toolStarts.set(o.toolCallId, { name: o.toolName, args: summariseArgs(o.args) });
        break;
      case "tool_execution_end": {
        const started = toolStarts.get(o.toolCallId) || { name: o.toolName };
        const rec = { name: started.name, args: started.args, isError: !!o.isError };
        if (o.isError) hadError = true;
        toolCalls.push(rec);
        break;
      }
      case "message_end":
        if (o.message?.role === "assistant") {
          // Last assistant message wins; concatenate its text blocks (skip thinking).
          text = (o.message.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (o.message.usage) usage = o.message.usage;
        }
        break;
      case "agent_end": {
        const last = (o.messages || []).filter((m) => m.role === "assistant").at(-1);
        if (last) {
          const t2 = (last.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (t2) text = t2;
          if (last.usage) usage = last.usage;
        }
        break;
      }
    }
  }
  return { sessionId, text, toolCalls, usage, hadError };
}

function summariseArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return undefined;
  }
}

/**
 * Run pi once in headless JSON mode and return a normalised result.
 * @param {object} o  See buildPiArgs, plus optional sessionId/timeoutMs.
 */
export async function runPi(o) {
  const sessionId = o.sessionId || randomUUID();
  const args = buildPiArgs({ ...o, sessionId });
  const res = await spawnCapture(process.execPath, [PI_ENTRY, ...args], {
    cwd: o.cwd || PI_CWD,
    timeoutMs: o.timeoutMs || PI_TIMEOUT_MS,
  });
  const parsed = parsePiJson(res.stdout);
  return {
    sessionId: parsed.sessionId || sessionId,
    text: parsed.text,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    exitCode: res.code,
    timedOut: res.timedOut,
    hadError: parsed.hadError || res.code !== 0 || res.timedOut,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}
