/**
 * ask_claude end-to-end behaviour, driven exactly as the MCP server drives it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskClaudeHandler } from "../lib/claude-handler.mjs";

const BASE = {
  sessionId: "sid",
  text: "the answer",
  sawResultEvent: true,
  toolCalls: [],
  usage: { input_tokens: 1 },
  modelUsage: null,
  costUsd: 0.01,
  numTurns: 1,
  stopReason: "end_turn",
  terminalReason: "completed",
  apiErrorStatus: null,
  permissionDenials: [],
  rateLimitInfo: null,
  unparsedLines: 0,
  exitCode: 0,
  timedOut: false,
  hadError: false,
  stdout: "",
  stderr: "",
  durationMs: 100,
};

function deps(result, spy = {}) {
  return {
    run: async () => (typeof result === "function" ? result() : result),
    audit: async (kind, record) => ((spy.audits ||= []).push(record)),
    checkAvailability: async () => ({ allowed: true, probe: false, entry: null }),
    recordBlocked: async (name, o) => ((spy.blocked ||= []).push({ name, ...o })),
    clearBlocked: async () => ((spy.cleared = true)),
    resetProbeClaimedUntil: async () => ((spy.probeReset = true)),
    newSessionId: () => "generated-id",
  };
}
const parts = (res) => res.content[0].text.split("\n\n---\n");
const metaOf = (res) => JSON.parse(parts(res)[1].slice(parts(res)[1].indexOf("{")));

test("a clean run returns the answer and a metadata footer", async () => {
  const res = await createAskClaudeHandler(deps(BASE))({ prompt: "hi" });
  assert.equal(res.isError, false);
  assert.equal(parts(res)[0], "the answer");
  const meta = metaOf(res);
  assert.equal(meta.session_id, "sid");
  assert.equal(meta.cost_usd, 0.01);
  assert.deepEqual(meta.permission_denials, []);
});

test("denied tool calls are called out in the REPLY, not just the metadata", async () => {
  // The silent failure this bridge is built to prevent: exit 0, is_error false,
  // a confident answer — describing an edit that was blocked.
  const spy = {};
  const res = await createAskClaudeHandler(
    deps(
      {
        ...BASE,
        text: "I updated config.json for you.",
        permissionDenials: [
          { tool_name: "Write", tool_use_id: "t1", tool_input: { file_path: "config.json" } },
          { tool_name: "Write", tool_use_id: "t2", tool_input: { file_path: "other.json" } },
        ],
      },
      spy
    )
  )({ prompt: "edit config" });

  const body = parts(res)[0];
  assert.match(body, /DENIED/, "the caller must be told the work did not happen");
  assert.match(body, /Write/);
  assert.match(body, /2 tool call/);
  assert.match(body, /allow_edits:true/, "and told how to fix it");
  assert.ok(body.startsWith("I updated config.json for you."), "the answer itself is preserved");
  // Deduplicated tool names in metadata, full records in the audit log.
  assert.deepEqual(metaOf(res).permission_denials, ["Write"]);
  assert.equal(spy.audits.at(-1).permissionDenials.length, 2);
});

test("no denials means no note — a clean reply stays clean", async () => {
  const res = await createAskClaudeHandler(deps(BASE))({ prompt: "hi" });
  assert.ok(!parts(res)[0].includes("claude-bridge]"));
});

test("a crash with no text surfaces stderr, like every other bridge", async () => {
  const res = await createAskClaudeHandler(
    deps({ ...BASE, text: "", exitCode: 1, hadError: true, stderr: "ENOENT: no such file" })
  )({ prompt: "hi" });

  assert.equal(res.isError, true);
  assert.match(parts(res)[0], /ENOENT/);
  assert.match(parts(res)[0], /exit code 1/);
});

test("a structured rate_limit_event records an EXACT block, no text matching", async () => {
  const spy = {};
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  await createAskClaudeHandler(
    deps(
      {
        ...BASE,
        hadError: true,
        exitCode: 1,
        rateLimitInfo: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      },
      spy
    )
  )({ prompt: "hi" });

  assert.equal(spy.blocked.length, 1);
  assert.equal(spy.blocked[0].confidence, "exact");
  assert.equal(spy.blocked[0].recordedBy, "claude-bridge");
  assert.ok(spy.blocked[0].blockedUntil);
});

test("a healthy rate_limit_event never locks the CLI out", async () => {
  const spy = {};
  await createAskClaudeHandler(
    deps(
      { ...BASE, rateLimitInfo: { status: "allowed", overageStatus: "rejected", resetsAt: 1 } },
      spy
    )
  )({ prompt: "hi" });

  assert.equal(spy.blocked, undefined, "status:'allowed' must win over overageStatus:'rejected'");
});

test("a blocked CLI is refused before spawning anything", async () => {
  let spawned = false;
  const handler = createAskClaudeHandler({
    ...deps(BASE),
    run: async () => ((spawned = true), BASE),
    checkAvailability: async () => ({
      allowed: false,
      probe: false,
      entry: { blocked_until: "2026-01-01T00:00:00Z", reason: "rate limited", confidence: "exact" },
    }),
  });
  const res = await handler({ prompt: "hi" });

  assert.equal(spawned, false);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cli_unavailable/);
});

test("a spawn failure is reported as such, with the reason", async () => {
  const handler = createAskClaudeHandler({
    ...deps(BASE),
    run: async () => {
      throw new Error("spawn claude ENOENT");
    },
  });
  const res = await handler({ prompt: "hi" });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Failed to launch claude/);
  assert.match(res.content[0].text, /ENOENT/);
});

test("the permission flags reach the runner unchanged", async () => {
  let seen;
  const handler = createAskClaudeHandler({
    ...deps(BASE),
    run: async (o) => ((seen = o), BASE),
  });
  await handler({
    prompt: "hi",
    read_only: true,
    allow_edits: false,
    model: "haiku",
    effort: "high",
    max_budget_usd: 0.25,
    timeout_ms: 60000,
  });

  assert.equal(seen.readOnly, true);
  assert.equal(seen.allowEdits, false);
  assert.equal(seen.model, "haiku");
  assert.equal(seen.effort, "high");
  assert.equal(seen.maxBudgetUsd, 0.25);
  assert.equal(seen.timeoutMs, 60000);
});
