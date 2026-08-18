import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs, parsePiJson, READ_ONLY_TOOLS } from "../lib/pi.mjs";
import { buildAgyArgs, parseAgyStream } from "../lib/agy.mjs";
import { buildCodexArgs, parseCodexJson } from "../lib/codex.mjs";
import { buildCopilotArgs, parseCopilotJson } from "../lib/copilot.mjs";
import {
  CODEX_SUCCESS,
  CODEXThreadId,
  CODEXText,
  CODEXUsage,
  CODEX_ERROR,
} from "./codex-fixtures.mjs";
import {
  COPILOT_SUCCESS,
  COPILOTSessionId,
  COPILOTUsage,
  COPILOT_QUOTA_ERROR,
  COPILOT_QuotaError,
  COPILOT_QuotaSnapshots,
} from "./copilot-fixtures.mjs";

test("buildPiArgs: defaults disable extensions and keep write tools", () => {
  const a = buildPiArgs({ prompt: "hi", sessionId: "SID" });
  assert.deepEqual(a.slice(0, 6), ["--mode", "json", "--session-id", "SID", "-p", "hi"]);
  assert.ok(a.includes("--no-extensions"));
  assert.ok(!a.includes("--tools"));
  assert.ok(!a.includes("-a"));
});

test("buildPiArgs: read_only restricts tools; extensions opt-in; approve/model", () => {
  const a = buildPiArgs({
    prompt: "p",
    sessionId: "s",
    readOnly: true,
    model: "sonnet",
    approveProject: true,
    enableExtensions: true,
  });
  assert.ok(!a.includes("--no-extensions"));
  const ti = a.indexOf("--tools");
  assert.equal(a[ti + 1], READ_ONLY_TOOLS);
  assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  assert.ok(a.includes("-a"));
});

test("buildPiArgs: prompt with shell metacharacters stays a single argv element", () => {
  const nasty = 'a"; rm -rf / #`$(whoami)';
  const a = buildPiArgs({ prompt: nasty, sessionId: "s" });
  assert.ok(a.includes(nasty)); // passed verbatim, never concatenated into a shell string
});

test("parsePiJson: extracts session id, last assistant text, tool calls, usage", () => {
  const lines = [
    { type: "session", id: "sess-1", cwd: "x" },
    { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a.ts" } },
    { type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "final answer" },
        ],
        usage: { totalTokens: 42 },
      },
    },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
  const r = parsePiJson(lines);
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.text, "final answer");
  assert.equal(r.usage.totalTokens, 42);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "read");
  assert.equal(r.hadError, false);
});

test("parsePiJson: ignores non-JSON noise lines and flags tool errors", () => {
  const out =
    "[auto-annotate] Extension loading...\n" +
    JSON.stringify({ type: "tool_execution_start", toolCallId: "9", toolName: "bash" }) +
    "\n" +
    JSON.stringify({ type: "tool_execution_end", toolCallId: "9", toolName: "bash", isError: true }) +
    "\n";
  const r = parsePiJson(out);
  assert.equal(r.hadError, true);
  assert.equal(r.toolCalls[0].isError, true);
});

test("buildAgyArgs: defaults; no dangerous flag; print-timeout derived", () => {
  const a = buildAgyArgs({ prompt: "hi", timeoutMs: 60000 });
  assert.deepEqual(a.slice(0, 4), ["-p", "hi", "--output-format", "stream-json"]);
  assert.ok(!a.includes("--dangerously-skip-permissions"));
  assert.ok(!a.includes("--sandbox"));
  assert.equal(a[a.indexOf("--print-timeout") + 1], "55s");
});

test("buildAgyArgs: conversation/model/effort/sandbox/dangerous flags", () => {
  const a = buildAgyArgs({
    prompt: "p",
    conversationId: "CID",
    model: "gemini-x",
    effort: "high",
    sandbox: true,
    dangerouslyAllowAll: true,
  });
  assert.equal(a[a.indexOf("--conversation") + 1], "CID");
  assert.equal(a[a.indexOf("--model") + 1], "gemini-x");
  assert.equal(a[a.indexOf("--effort") + 1], "high");
  assert.ok(a.includes("--sandbox"));
  assert.ok(a.includes("--dangerously-skip-permissions"));
});

test("parseAgyStream: pulls conversation_id, status, response, usage from result", () => {
  const out = [
    { event: "init", conversation_id: "c-1", init: { tools: [] } },
    { event: "step_update", step_update: { conversation_id: "c-1", step_type: "agent_response", text_delta: "PO" } },
    {
      event: "result",
      result: { conversation_id: "c-1", status: "SUCCESS", response: "PONG\n", num_turns: 1, usage: { total_tokens: 5 } },
    },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
  const r = parseAgyStream(out);
  assert.equal(r.conversationId, "c-1");
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.response, "PONG\n");
  assert.equal(r.numTurns, 1);
  assert.equal(r.usage.total_tokens, 5);
});

test("parseAgyStream: records non-trivial tool steps for audit", () => {
  const out = [
    { event: "step_update", step_update: { step_type: "run_command", state: "DONE", command: "git status" } },
    { event: "result", result: { status: "ERROR", error: "boom" } },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
  const r = parseAgyStream(out);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].type, "run_command");
  assert.equal(r.status, "ERROR");
  assert.equal(r.error, "boom");
});

// ─── codex ───────────────────────────────────────────────────────────────────

test("buildCodexArgs: new session defaults; --json --skip-git-repo-check; sandbox read-only", () => {
  const { entry, args } = buildCodexArgs({ prompt: "hi" });
  assert.ok(entry.endsWith("codex.exe") || entry.endsWith("codex"));
  assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(args.includes("hi"));
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("-s"));
});

test("buildCodexArgs: resume with session_id uses 'exec resume <id>'", () => {
  const { args } = buildCodexArgs({ prompt: "continue", sessionId: "abc-123" });
  assert.deepEqual(args.slice(0, 4), ["exec", "resume", "abc-123", "--json"]);
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.includes("continue"));
});

test("buildCodexArgs: model and sandbox flags", () => {
  const { args } = buildCodexArgs({ prompt: "p", model: "o3", sandbox: "workspace-write" });
  assert.equal(args[args.indexOf("-m") + 1], "o3");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
});

test("buildCodexArgs: prompt with shell metacharacters stays a single argv element", () => {
  const nasty = 'a"; rm -rf / #`$(whoami)';
  const { args } = buildCodexArgs({ prompt: nasty });
  assert.ok(args.includes(nasty));
});

test("parseCodexJson: extracts thread_id, text, usage from real fixture", () => {
  const r = parseCodexJson(CODEX_SUCCESS);
  assert.equal(r.threadId, CODEXThreadId);
  assert.equal(r.text, CODEXText);
  assert.deepEqual(r.usage, CODEXUsage);
  assert.equal(r.hadError, false);
});

test("parseCodexJson: flags error on thread.failed event", () => {
  const r = parseCodexJson(CODEX_ERROR);
  assert.equal(r.hadError, true);
  assert.equal(r.threadId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("parseCodexJson: ignores non-JSON noise lines", () => {
  const noisy = "Reading additional input from stdin...\n" + CODEX_SUCCESS;
  const r = parseCodexJson(noisy);
  assert.equal(r.threadId, CODEXThreadId);
  assert.equal(r.text, CODEXText);
});

// ─── copilot ─────────────────────────────────────────────────────────────────

test("buildCopilotArgs: defaults include --output-format json and --allow-all-tools", () => {
  const a = buildCopilotArgs({ prompt: "hi" });
  assert.deepEqual(a.slice(0, 4), ["-p", "hi", "--output-format", "json"]);
  assert.ok(a.includes("--allow-all-tools"));
  assert.ok(!a.includes("--allow-all"));
  assert.ok(!a.includes("--model"));
  assert.ok(!a.includes("--effort"));
  assert.ok(!a.includes("--session-id"));
});

test("buildCopilotArgs: session/model/effort/max-ai-credits flags", () => {
  const a = buildCopilotArgs({
    prompt: "p",
    sessionId: "SID",
    model: "claude-haiku-4.5",
    effort: "high",
    maxAiCredits: 5.0,
  });
  assert.equal(a[a.indexOf("--session-id") + 1], "SID");
  assert.equal(a[a.indexOf("--model") + 1], "claude-haiku-4.5");
  assert.equal(a[a.indexOf("--effort") + 1], "high");
  assert.equal(a[a.indexOf("--max-ai-credits") + 1], "5");
});

test("buildCopilotArgs: dangerously_allow_all adds --allow-all (not just --allow-all-tools)", () => {
  const a = buildCopilotArgs({ prompt: "p", dangerouslyAllowAll: true });
  assert.ok(a.includes("--allow-all"));
  assert.ok(a.includes("--allow-all-tools"));
});

test("buildCopilotArgs: prompt with shell metacharacters stays a single argv element", () => {
  const nasty = 'a"; rm -rf / #`$(whoami)';
  const a = buildCopilotArgs({ prompt: nasty });
  assert.ok(a.includes(nasty));
});

test("parseCopilotJson: extracts session_id, usage from result event", () => {
  const r = parseCopilotJson(COPILOT_SUCCESS);
  assert.equal(r.sessionId, COPILOTSessionId);
  assert.deepEqual(r.usage, COPILOTUsage);
  assert.equal(r.hadError, false);
  assert.equal(r.error, null);
});

test("parseCopilotJson: captures quota error and quotaSnapshots", () => {
  const r = parseCopilotJson(COPILOT_QUOTA_ERROR);
  assert.equal(r.hadError, true);
  assert.equal(r.error, COPILOT_QuotaError);
  assert.deepEqual(r.quotaSnapshots, COPILOT_QuotaSnapshots);
  assert.equal(r.sessionId, COPILOTSessionId);
});

test("parseCopilotJson: ignores MCP server status noise", () => {
  const noisy =
    JSON.stringify({ type: "session.mcp_server_status_changed", data: { serverName: "playwright", status: "connected" } }) +
    "\n" +
    COPILOT_SUCCESS;
  const r = parseCopilotJson(noisy);
  assert.equal(r.sessionId, COPILOTSessionId);
  assert.equal(r.hadError, false);
});
