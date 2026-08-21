import { spawnCapture, requireEnv } from "./run.mjs";

export const COPILOT_ENTRY =
  process.env.COPILOT_BRIDGE_ENTRY ||
  "C:/Users/User/AppData/Roaming/npm/copilot.cmd";
export const COPILOT_CWD = requireEnv("COPILOT_BRIDGE_CWD");
export const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_BRIDGE_TIMEOUT_MS || 300000);

/**
 * Build the argv for a headless copilot run. shell:false => prompt is a safe argv element.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.sessionId]       Resume / set a specific session (--session-id).
 * @param {string} [o.model]           Model override (--model).
 * @param {string} [o.effort]          Reasoning effort (--effort).
 * @param {number} [o.maxAiCredits]    Spending cap for this invocation (--max-ai-credits).
 * @param {boolean} [o.dangerouslyAllowAll]  Add --allow-all (includes paths + urls).
 * @param {number} [o.timeoutMs]       Used to derive --print-timeout? No, copilot doesn't have one.
 * @returns {string[]}
 */
export function buildCopilotArgs({
  prompt,
  sessionId,
  model,
  effort,
  maxAiCredits,
  dangerouslyAllowAll,
}) {
  const args = ["-p", prompt, "--output-format", "json", "--allow-all-tools"];
  if (sessionId) args.push("--session-id", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (maxAiCredits != null) args.push("--max-ai-credits", String(maxAiCredits));
  if (dangerouslyAllowAll) args.push("--allow-all");
  return args;
}

/**
 * Parse copilot's `--output-format json` NDJSON output stream.
 *
 * Key event types observed in real output:
 *   {"type":"session.mcp_server_status_changed",...}         (skip)
 *   {"type":"assistant.turn_start","data":{...}}
 *   {"type":"model.call_start","data":{"model":"...",...}}
 *   {"type":"model.call_failure","data":{"statusCode":402,"errorMessage":"...","quotaSnapshots":{...}}}
 *   {"type":"session.error","data":{"errorType":"quota","message":"...",...}}
 *   {"type":"result","sessionId":"...","exitCode":1,"usage":{...}}
 *
 * @param {string} stdout
 * @returns {{sessionId:string|null, response:string, usage:object|null, error:string|null, hadError:boolean, quotaSnapshots:object|null}}
 */
export function parseCopilotJson(stdout) {
  let sessionId = null;
  let response = "";
  let usage = null;
  let error = null;
  let hadError = false;
  let quotaSnapshots = null;

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    switch (o.type) {
      case "result":
        sessionId = o.sessionId ?? sessionId;
        usage = o.usage ?? usage;
        if (o.exitCode && o.exitCode !== 0) hadError = true;
        break;
      case "session.error":
        hadError = true;
        error = o.data?.message ?? o.data?.errorType ?? error;
        break;
      case "model.call_failure":
        // Capture quota snapshots when present (useful for quota reporting).
        if (o.data?.quotaSnapshots) quotaSnapshots = o.data.quotaSnapshots;
        if (o.data?.statusCode && o.data.statusCode >= 400) {
          hadError = true;
          error = o.data?.errorMessage ?? error;
        }
        break;
      case "assistant.text_delta":
        // Streaming text deltas — concatenate if present.
        if (typeof o.data?.text === "string") response += o.data.text;
        break;
      case "assistant.message":
        // Some versions emit the full message at end.
        if (typeof o.data?.content === "string") response = o.data.content;
        break;
      case "assistant.idle":
        // Session is done; no useful data here.
        break;
      // Ignore all other event types (mcp_server_status_changed, skills_loaded, etc.)
    }
  }
  return { sessionId, response, usage, error, hadError, quotaSnapshots };
}

/**
 * Run copilot once in headless JSON mode and return a normalised result.
 * @param {object} o  See buildCopilotArgs, plus optional cwd/timeoutMs.
 */
export async function runCopilot(o) {
  const args = buildCopilotArgs(o);
  const res = await spawnCapture(COPILOT_ENTRY, args, {
    cwd: o.cwd || COPILOT_CWD,
    timeoutMs: o.timeoutMs || COPILOT_TIMEOUT_MS,
  });
  const parsed = parseCopilotJson(res.stdout);
  return {
    sessionId: parsed.sessionId,
    response: parsed.response,
    usage: parsed.usage,
    error: parsed.error,
    exitCode: res.code,
    timedOut: res.timedOut,
    hadError: parsed.hadError || res.code !== 0 || res.timedOut,
    stderr: res.stderr,
    durationMs: res.durationMs,
    quotaSnapshots: parsed.quotaSnapshots,
  };
}
