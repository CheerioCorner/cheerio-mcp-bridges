/**
 * Claude Code bridge: argv construction and stream parsing.
 *
 * Every fixture and flag here was taken from the REAL binary
 * (@anthropic-ai/claude-code 2.1.263), not from documentation — including the
 * awkward parts: `subtype` stays "success" on an API error, a rate_limit_event
 * carries `status:"allowed"` next to `overageStatus:"rejected"`, and a bad
 * --model prints a non-JSON line before the stream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// lib/claude.mjs calls requireEnv() at module level (same as the other four
// wrappers), so dummy env vars go in before the dynamic import. Nothing here
// touches the filesystem — these are pure functions. See REVIEW.md §2.2 for the
// standing proposal to move requireEnv out of module scope.
const DUMMY = "/tmp/dummy";
process.env.CLAUDE_BRIDGE_ENTRY = process.env.CLAUDE_BRIDGE_ENTRY || DUMMY;
process.env.CLAUDE_BRIDGE_CWD = process.env.CLAUDE_BRIDGE_CWD || DUMMY;

const { buildClaudeArgs, parseClaudeStream } = await import("../lib/claude.mjs");
const { claudeRateLimitFromEvent, CLAUDE_RATE_LIMIT_BLOCKED_STATUSES } = await import(
  "../lib/rate-limit.mjs"
);

// ── argv ─────────────────────────────────────────────────────────────────────

function argsFor(o) {
  return buildClaudeArgs({ prompt: "hello", ...o });
}
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("the prompt is positional, last, and behind a bare --", () => {
  const args = argsFor({});
  assert.equal(args.at(-1), "hello");
  assert.equal(args.at(-2), "--");
  // -p/--print is a BOOLEAN flag for this CLI (unlike pi/agy/copilot, where -p
  // takes the prompt as its value). The token after it must be another flag.
  assert.ok(args.includes("--print"));
  assert.notEqual(args[args.indexOf("--print") + 1], "hello");
  assert.match(args[args.indexOf("--print") + 1], /^--/);
});

test("a prompt that starts with a dash cannot be parsed as a flag", () => {
  const args = buildClaudeArgs({ prompt: "--version is not a question" });
  assert.equal(args.at(-1), "--version is not a question");
  assert.equal(args.at(-2), "--");
  // Everything before the separator is ours; nothing after it is.
  assert.equal(args.slice(0, -2).includes("--version is not a question"), false);
});

test("the three load-bearing isolation flags are always present", () => {
  const args = argsFor({});
  // Without this, claude loads the operator's MCP servers — which are these bridges.
  assert.ok(args.includes("--strict-mcp-config"));
  // --safe-mode not --bare: --bare refuses OAuth/keychain auth and breaks subscription logins.
  assert.ok(args.includes("--safe-mode"));
  assert.ok(!args.includes("--bare"));
  // Headless nobody can approve; "none" denies instead of hanging.
  assert.equal(flagValue(args, "--permission-prompts"), "none");
});

test("stream-json + verbose, so tool calls and rate_limit_event are visible", () => {
  const args = argsFor({});
  assert.equal(flagValue(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"));
});

test("default permission posture is read-only: manual, and no --restricted unless asked", () => {
  const args = argsFor({});
  assert.equal(flagValue(args, "--permission-mode"), "manual");
  assert.ok(!args.includes("--restricted"));
});

test("read_only adds --restricted; allow_edits and dangerously_allow_all escalate in order", () => {
  assert.ok(argsFor({ readOnly: true }).includes("--restricted"));
  assert.equal(flagValue(argsFor({ allowEdits: true }), "--permission-mode"), "acceptEdits");
  assert.equal(
    flagValue(argsFor({ dangerouslyAllowAll: true }), "--permission-mode"),
    "bypassPermissions"
  );
  // dangerously_allow_all wins over allow_edits — one mode flag, never two.
  const both = argsFor({ allowEdits: true, dangerouslyAllowAll: true });
  assert.equal(both.filter((a) => a === "--permission-mode").length, 1);
  assert.equal(flagValue(both, "--permission-mode"), "bypassPermissions");
});

test("a new session gets --session-id; resuming gets --resume, never both", () => {
  const fresh = argsFor({ sessionId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(flagValue(fresh, "--session-id"), "11111111-1111-1111-1111-111111111111");
  assert.ok(!fresh.includes("--resume"));

  const resumed = argsFor({ sessionId: "new-id", resumeSessionId: "old-id" });
  assert.equal(flagValue(resumed, "--resume"), "old-id");
  assert.ok(!resumed.includes("--session-id"));
});

test("optional knobs only appear when asked for", () => {
  const bare = argsFor({});
  for (const f of ["--model", "--effort", "--max-budget-usd"]) {
    assert.ok(!bare.includes(f), `${f} should be absent by default`);
  }
  const full = argsFor({ model: "haiku", effort: "high", maxBudgetUsd: 0.5 });
  assert.equal(flagValue(full, "--model"), "haiku");
  assert.equal(flagValue(full, "--effort"), "high");
  assert.equal(flagValue(full, "--max-budget-usd"), "0.5");
});

// ── stream parsing ───────────────────────────────────────────────────────────

const SID = "44841f04-6ef8-4f96-8469-260608488f75";

function line(o) {
  return JSON.stringify(o);
}
const INIT = line({ type: "system", subtype: "init", session_id: SID, tools: ["Read", "Bash"] });
const ASSISTANT_TEXT = line({
  type: "assistant",
  session_id: SID,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
});
const RESULT_OK = line({
  type: "result",
  subtype: "success",
  session_id: SID,
  result: "ok",
  is_error: false,
  num_turns: 1,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  api_error_status: null,
  permission_denials: [],
  total_cost_usd: 0.0165,
  usage: { input_tokens: 10, output_tokens: 3 },
});

test("a clean run yields the result text, the session id and the usage", () => {
  const p = parseClaudeStream([INIT, ASSISTANT_TEXT, RESULT_OK].join("\n"));
  assert.equal(p.text, "ok");
  assert.equal(p.sessionId, SID);
  assert.equal(p.hadError, false);
  assert.equal(p.sawResultEvent, true);
  assert.equal(p.numTurns, 1);
  assert.equal(p.costUsd, 0.0165);
  assert.deepEqual(p.usage, { input_tokens: 10, output_tokens: 3 });
});

test("tool_use blocks become tools_used, deduplicated by id", () => {
  const withTools = line({
    type: "assistant",
    session_id: SID,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Read" },
        { type: "tool_use", id: "toolu_2", name: "Grep" },
      ],
    },
  });
  // The same block can be re-emitted across streaming updates.
  const p = parseClaudeStream([INIT, withTools, withTools, ASSISTANT_TEXT, RESULT_OK].join("\n"));
  assert.deepEqual(
    p.toolCalls.map((t) => t.name),
    ["Read", "Grep"]
  );
});

test("a non-JSON prefix line is skipped and counted, not treated as failure", () => {
  // Real output for an unknown --model: a bracketed diagnostic before the stream.
  const noise = '[claude-code:unrecognized_model] {"model":"nope","query_source":"sdk"}';
  const p = parseClaudeStream([noise, INIT, ASSISTANT_TEXT, RESULT_OK].join("\n"));
  assert.equal(p.text, "ok");
  assert.equal(p.unparsedLines, 1);
});

test("is_error true is an error even though subtype still says success", () => {
  // Verified shape: a 404 on an unknown model reports subtype "success".
  const bad = line({
    type: "result",
    subtype: "success",
    session_id: SID,
    result: "There's an issue with the selected model (nope).",
    is_error: true,
    api_error_status: 404,
    terminal_reason: "api_error",
    permission_denials: [],
  });
  const p = parseClaudeStream([INIT, bad].join("\n"));
  assert.equal(p.hadError, true, "is_error must win over subtype");
  assert.equal(p.apiErrorStatus, 404);
  assert.equal(p.terminalReason, "api_error");
});

test("permission denials are captured — the quietest failure this CLI has", () => {
  // Real shape: the write was denied, yet is_error is false and the exit code is 0.
  const denied = line({
    type: "result",
    subtype: "success",
    session_id: SID,
    result: "denied",
    is_error: false,
    num_turns: 2,
    permission_denials: [
      { tool_name: "Write", tool_use_id: "toolu_x", tool_input: { file_path: "/tmp/x" } },
    ],
  });
  const p = parseClaudeStream([INIT, denied].join("\n"));
  assert.equal(p.permissionDenials.length, 1);
  assert.equal(p.permissionDenials[0].tool_name, "Write");
  assert.equal(p.hadError, false, "a denial is not an error — which is exactly why it must be reported");
});

test("a run killed before the result event still returns the partial answer", () => {
  // agy throws its partial response away in this situation; this one keeps it.
  const partial = line({
    type: "assistant",
    session_id: SID,
    message: { role: "assistant", content: [{ type: "text", text: "half an ans" }] },
  });
  const p = parseClaudeStream([INIT, partial].join("\n"));
  assert.equal(p.text, "half an ans");
  assert.equal(p.sawResultEvent, false);
});

test("thinking blocks never leak into the answer", () => {
  const thinking = line({
    type: "assistant",
    session_id: SID,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        { type: "text", text: "ok" },
      ],
    },
  });
  const p = parseClaudeStream([INIT, thinking, RESULT_OK].join("\n"));
  assert.equal(p.text, "ok");
  assert.ok(!p.text.includes("secret"));
});

test("empty stdout parses to an empty answer rather than throwing", () => {
  const p = parseClaudeStream("");
  assert.equal(p.text, "");
  assert.equal(p.sessionId, null);
  assert.equal(p.hadError, false);
});

// ── rate limiting ────────────────────────────────────────────────────────────

// The literal event emitted by a HEALTHY account. Note status:"allowed" sitting
// right next to overageStatus:"rejected".
const HEALTHY_RATE_LIMIT = {
  status: "allowed",
  resetsAt: 1788684000,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.21, resetsAt: 1788684000 },
    seven_day: { utilization: 0.33, resetsAt: 1788674400 },
  },
};

test("a healthy account is NOT locked out by the 'rejected' in overageStatus", () => {
  // This is the W-2026-08-086 disease: a loose match on the wrong field.
  const r = claudeRateLimitFromEvent(HEALTHY_RATE_LIMIT);
  assert.equal(r.limited, false);
  assert.equal(r.blockedUntil, null);
});

test("a real rejection yields an EXACT block window from resetsAt", () => {
  const now = 1788680000_000;
  const r = claudeRateLimitFromEvent(
    { ...HEALTHY_RATE_LIMIT, status: "rejected" },
    now
  );
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "exact", "resetsAt is a real timestamp — no guessing needed");
  assert.equal(r.blockedUntil, new Date(1788684000_000).toISOString());
  assert.equal(r.retryAfterSeconds, 4000);
  assert.equal(r.source, "rate_limit_event");
  assert.match(r.reason, /five_hour/);
});

test("a rejection whose reset time has already passed downgrades to estimated", () => {
  const r = claudeRateLimitFromEvent({ status: "blocked", resetsAt: 1 }, Date.now());
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "estimated");
  assert.equal(r.blockedUntil, null);
});

test("missing or malformed rate-limit info is simply 'not limited'", () => {
  for (const info of [null, undefined, {}, { status: 42 }, { status: "unknown_new_value" }]) {
    assert.equal(claudeRateLimitFromEvent(info).limited, false);
  }
});

test("the blocked-status list is an allow-list of rejections, not a catch-all", () => {
  assert.ok(!CLAUDE_RATE_LIMIT_BLOCKED_STATUSES.includes("allowed"));
  assert.ok(CLAUDE_RATE_LIMIT_BLOCKED_STATUSES.includes("rejected"));
});

test("the event is picked up from the stream", () => {
  const rl = line({ type: "rate_limit_event", session_id: SID, rate_limit_info: HEALTHY_RATE_LIMIT });
  const p = parseClaudeStream([INIT, rl, ASSISTANT_TEXT, RESULT_OK].join("\n"));
  assert.equal(p.rateLimitInfo.status, "allowed");
  assert.equal(p.rateLimitInfo.rateLimitType, "five_hour");
});
