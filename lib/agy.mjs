import { spawnCapture, requireEnv } from "./run.mjs";

export const AGY_ENTRY =
  process.env.AGY_BRIDGE_ENTRY || "C:/Users/User/AppData/Local/agy/bin/agy.exe";
export const AGY_CWD = requireEnv("AGY_BRIDGE_CWD");
export const AGY_TIMEOUT_MS = Number(process.env.AGY_BRIDGE_TIMEOUT_MS || 300000);

/**
 * Build the argv for a headless agy run. shell:false => prompt is a safe argv element.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.conversationId]      Resume a specific prior conversation.
 * @param {string} [o.model]
 * @param {"low"|"medium"|"high"} [o.effort]
 * @param {boolean} [o.sandbox=true]       Run with terminal sandbox restrictions by default.
 * @param {boolean} [o.dangerouslyAllowAll=true] Auto-approve ALL tool permissions by default.
 * @param {number} [o.timeoutMs]           Also passed to agy as --print-timeout.
 * @returns {string[]}
 */
export function buildAgyArgs({
  prompt,
  conversationId,
  model,
  effort,
  sandbox,
  dangerouslyAllowAll,
  timeoutMs,
}) {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  if (conversationId) args.push("--conversation", conversationId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (sandbox !== false) args.push("--sandbox");
  if (dangerouslyAllowAll !== false) args.push("--dangerously-skip-permissions");
  // Give agy's own wait a little more room than our hard kill so we get a clean result event.
  const secs = Math.max(30, Math.floor((timeoutMs || AGY_TIMEOUT_MS) / 1000) - 5);
  args.push("--print-timeout", `${secs}s`);
  return args;
}

/**
 * Parse agy's `--output-format stream-json` NDJSON output.
 * @param {string} stdout
 * @returns {{conversationId:string|null, status:string|null, response:string, toolCalls:Array, usage:object|null, numTurns:number|null, error:string|null}}
 */
export function parseAgyStream(stdout) {
  let conversationId = null;
  let status = null;
  let response = "";
  let usage = null;
  let numTurns = null;
  let error = null;
  const toolCalls = [];

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.event === "init") {
      conversationId = o.conversation_id ?? conversationId;
    } else if (o.event === "step_update") {
      const s = o.step_update || {};
      conversationId = s.conversation_id ?? conversationId;
      // Record anything that looks like a tool/command step for the audit trail.
      const tt = s.step_type;
      if (tt && tt !== "user_input" && tt !== "agent_response" && tt !== "checkpoint" && tt !== "unknown") {
        toolCalls.push({
          type: tt,
          state: s.state,
          info: s.tool_info || s.command || s.tool_name || undefined,
        });
      }
    } else if (o.event === "result") {
      const r = o.result || {};
      conversationId = r.conversation_id ?? conversationId;
      status = r.status ?? status;
      if (typeof r.response === "string") response = r.response;
      usage = r.usage ?? usage;
      numTurns = r.num_turns ?? numTurns;
      error = r.error ?? error;
    }
  }
  return { conversationId, status, response, toolCalls, usage, numTurns, error };
}

/** agy print-mode terminal statuses; only SUCCESS is a clean success. */
export const AGY_TERMINAL_STATUSES = [
  "SUCCESS",
  "ERROR",
  "WAITING",
  "INTERRUPTED",
  "CANCELED",
  "INVALID",
];

export async function runAgy(o) {
  const args = buildAgyArgs(o);
  const res = await spawnCapture(AGY_ENTRY, args, {
    cwd: o.cwd || AGY_CWD,
    timeoutMs: o.timeoutMs || AGY_TIMEOUT_MS,
  });
  const parsed = parseAgyStream(res.stdout);
  const ok = parsed.status === "SUCCESS" && res.code === 0 && !res.timedOut;
  return {
    conversationId: parsed.conversationId,
    status: parsed.status,
    response: parsed.response,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    numTurns: parsed.numTurns,
    error: parsed.error,
    exitCode: res.code,
    timedOut: res.timedOut,
    hadError: !ok,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}
