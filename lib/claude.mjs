import { spawnCapture, requireEnv } from "./run.mjs";

export const CLAUDE_ENTRY = requireEnv("CLAUDE_BRIDGE_ENTRY");
export const CLAUDE_CWD = requireEnv("CLAUDE_BRIDGE_CWD");
export const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_BRIDGE_TIMEOUT_MS || 300000);

/**
 * Build the argv for a headless Claude Code run.
 *
 * Everything here was verified against the real binary (@anthropic-ai/claude-code
 * 2.1.263), not inferred from docs. Three of these flags are load-bearing:
 *
 * - `--strict-mcp-config` — without it, `claude` loads the MCP servers from the
 *   user's own config, which is where THESE BRIDGES live. A bridge would spawn
 *   a claude that boots four bridges, each of which can spawn more CLIs.
 * - `--safe-mode` — disables customisations (hooks, plugins, CLAUDE.md, custom
 *   agents) that can hang or derail a headless run, while leaving auth alone.
 *   NOT `--bare`: `--bare` reads auth strictly from ANTHROPIC_API_KEY/apiKeyHelper
 *   and never touches OAuth or the keychain, so it breaks subscription logins.
 * - `--permission-prompts none` — headless there is nobody to approve anything.
 *   "none" denies instead of waiting, which is the difference between a bounded
 *   failure and a hang.
 *
 * The prompt goes LAST, after a bare `--`. `-p/--print` is a BOOLEAN flag here
 * (unlike pi/agy/copilot where -p takes the prompt), so the prompt is a
 * positional argument — and without `--` a prompt starting with a dash would be
 * parsed as an option. Verified: `-- "--version is not a real question..."`
 * reaches the model as text.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.sessionId]          UUID to assign a NEW session (honoured; verified).
 * @param {string} [o.resumeSessionId]    Resume an existing session instead.
 * @param {boolean} [o.readOnly]          Add --restricted (no Bash/REPL/WebFetch).
 * @param {boolean} [o.allowEdits]        --permission-mode acceptEdits.
 * @param {boolean} [o.dangerouslyAllowAll] --permission-mode bypassPermissions.
 * @param {string} [o.model]
 * @param {string} [o.effort]             low|medium|high|xhigh|max
 * @param {number} [o.maxBudgetUsd]       --max-budget-usd (print mode only).
 * @returns {string[]}
 */
export function buildClaudeArgs({
  prompt,
  sessionId,
  resumeSessionId,
  readOnly,
  allowEdits,
  dangerouslyAllowAll,
  model,
  effort,
  maxBudgetUsd,
}) {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];

  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else if (sessionId) args.push("--session-id", sessionId);

  args.push("--strict-mcp-config", "--safe-mode", "--permission-prompts", "none");

  // Permission posture. Default is the most conservative one the CLI offers
  // short of --restricted: reads run, anything that would prompt is denied.
  if (dangerouslyAllowAll) args.push("--permission-mode", "bypassPermissions");
  else if (allowEdits) args.push("--permission-mode", "acceptEdits");
  else args.push("--permission-mode", "manual");

  if (readOnly) args.push("--restricted");
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (maxBudgetUsd != null) args.push("--max-budget-usd", String(maxBudgetUsd));

  args.push("--", prompt);
  return args;
}

/**
 * Parse `--output-format stream-json --verbose` NDJSON.
 *
 * Event types seen from the real binary:
 *   active_goal, autocompact_state, system/init, system/status,
 *   system/commands_changed, stream_event, assistant, rate_limit_event,
 *   system/post_turn_summary, result/success
 *
 * Note the stream can be preceded by NON-JSON lines — an unrecognised --model
 * prints `[claude-code:unrecognized_model] {...}` before the JSON. NDJSON
 * parsing skips those naturally; a single-object --output-format json would
 * have choked on it.
 *
 * @param {string} stdout
 */
export function parseClaudeStream(stdout) {
  let sessionId = null;
  let resultText = null;
  let usage = null;
  let modelUsage = null;
  let costUsd = null;
  let numTurns = null;
  let stopReason = null;
  let terminalReason = null;
  let apiErrorStatus = null;
  let isError = false;
  let rateLimitInfo = null;
  let unparsedLines = 0;
  const permissionDenials = [];
  const toolCalls = [];
  const seenToolIds = new Set();
  const assistantText = [];

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      unparsedLines++;
      continue;
    }
    if (o.session_id) sessionId = o.session_id;

    switch (o.type) {
      case "assistant": {
        for (const block of o.message?.content || []) {
          if (block.type === "text" && typeof block.text === "string") {
            assistantText.push(block.text);
          } else if (block.type === "tool_use") {
            if (block.id && seenToolIds.has(block.id)) break;
            if (block.id) seenToolIds.add(block.id);
            toolCalls.push({ name: block.name, id: block.id });
          }
        }
        break;
      }
      case "rate_limit_event":
        rateLimitInfo = o.rate_limit_info ?? rateLimitInfo;
        break;
      case "result":
        if (typeof o.result === "string") resultText = o.result;
        usage = o.usage ?? usage;
        modelUsage = o.modelUsage ?? modelUsage;
        costUsd = o.total_cost_usd ?? costUsd;
        numTurns = o.num_turns ?? numTurns;
        stopReason = o.stop_reason ?? stopReason;
        terminalReason = o.terminal_reason ?? terminalReason;
        apiErrorStatus = o.api_error_status ?? apiErrorStatus;
        // `subtype` is NOT a reliable error signal: a 404 on an unknown model
        // still reports subtype "success" alongside is_error true. Verified.
        if (o.is_error === true) isError = true;
        if (Array.isArray(o.permission_denials)) permissionDenials.push(...o.permission_denials);
        break;
    }
  }

  // If the run was killed before the `result` event, salvage whatever the
  // assistant had already said rather than reporting nothing — agy loses its
  // partial answer this way and there is no reason to repeat that here.
  const text = resultText ?? (assistantText.length ? assistantText.join("") : "");

  return {
    sessionId,
    text,
    sawResultEvent: resultText !== null,
    toolCalls,
    usage,
    modelUsage,
    costUsd,
    numTurns,
    stopReason,
    terminalReason,
    apiErrorStatus,
    permissionDenials,
    rateLimitInfo,
    unparsedLines,
    hadError: isError || apiErrorStatus != null,
  };
}

/**
 * Run Claude Code once headlessly and return a normalised result.
 * @param {object} o  See buildClaudeArgs, plus optional cwd/timeoutMs.
 */
export async function runClaude(o) {
  const args = buildClaudeArgs(o);
  const res = await spawnCapture(CLAUDE_ENTRY, args, {
    cwd: o.cwd || CLAUDE_CWD,
    timeoutMs: o.timeoutMs || CLAUDE_TIMEOUT_MS,
  });
  const parsed = parseClaudeStream(res.stdout);
  return {
    sessionId: parsed.sessionId || o.resumeSessionId || o.sessionId || null,
    text: parsed.text,
    sawResultEvent: parsed.sawResultEvent,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    modelUsage: parsed.modelUsage,
    costUsd: parsed.costUsd,
    numTurns: parsed.numTurns,
    stopReason: parsed.stopReason,
    terminalReason: parsed.terminalReason,
    apiErrorStatus: parsed.apiErrorStatus,
    permissionDenials: parsed.permissionDenials,
    rateLimitInfo: parsed.rateLimitInfo,
    unparsedLines: parsed.unparsedLines,
    exitCode: res.code,
    timedOut: res.timedOut,
    hadError: parsed.hadError || res.code !== 0 || res.timedOut,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}
