/**
 * Session-id honesty across the five bridges.
 *
 * The rule: the id a bridge hands back must be one the CLI actually
 * acknowledged, or the one the caller supplied to resume. Never a UUID the
 * bridge invented and the CLI never saw — that id looks resumable, isn't, and
 * sends the caller into a loop against a session that does not exist.
 *
 * codex and copilot both violated this until now. It only showed up when the
 * CLI died before announcing a session — i.e. exactly the 2026-09-05 shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskCodexHandler } from "../lib/codex-handler.mjs";
import { createAskCopilotHandler } from "../lib/copilot-handler.mjs";
import { createAskClaudeHandler } from "../lib/claude-handler.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deps(run, seen = {}) {
  return {
    run: async (o) => {
      seen.runArgs = o;
      return run(o);
    },
    audit: async (kind, record) => ((seen.audits ||= []).push(record)),
    checkAvailability: async () => ({ allowed: true, probe: false, entry: null }),
    recordBlocked: async () => {},
    clearBlocked: async () => {},
    resetProbeClaimedUntil: async () => {},
  };
}

function metaOf(res) {
  const footer = res.content[0].text.split("\n\n---\n")[1];
  return JSON.parse(footer.slice(footer.indexOf("{")));
}

// ── codex ────────────────────────────────────────────────────────────────────

const CODEX_CRASHED = {
  threadId: null,
  text: "",
  usage: null,
  exitCode: 1,
  timedOut: false,
  hadError: true,
  stdout: "",
  stderr: "ERR_MODULE_NOT_FOUND",
  durationMs: 5,
};

test("codex: a crash before thread.started reports NO thread id, not a made-up one", async () => {
  const handler = createAskCodexHandler(deps(async () => CODEX_CRASHED));
  const meta = metaOf(await handler({ prompt: "hi" }));

  assert.equal(meta.thread_id, null);
  assert.ok(!UUID_RE.test(String(meta.thread_id)), "must not be a fabricated UUID");
});

test("codex: the real thread id is reported when codex announces one", async () => {
  const handler = createAskCodexHandler(
    deps(async () => ({ ...CODEX_CRASHED, threadId: "real-thread", hadError: false, exitCode: 0, text: "hi" }))
  );
  assert.equal(metaOf(await handler({ prompt: "hi" })).thread_id, "real-thread");
});

test("codex: a caller-supplied id survives a crash, so the caller can retry it", async () => {
  const handler = createAskCodexHandler(deps(async () => CODEX_CRASHED));
  assert.equal(metaOf(await handler({ prompt: "hi", session_id: "caller-thread" })).thread_id, "caller-thread");
});

test("codex: only a caller-supplied id is passed to the CLI, never an invented one", async () => {
  const seen = {};
  const handler = createAskCodexHandler(deps(async () => CODEX_CRASHED, seen));
  await handler({ prompt: "hi" });
  assert.equal(seen.runArgs.sessionId, undefined, "a new run must not resume anything");
});

// ── copilot ──────────────────────────────────────────────────────────────────

const COPILOT_CRASHED = {
  sessionId: null,
  response: "",
  usage: null,
  error: null,
  quotaSnapshots: null,
  exitCode: 1,
  timedOut: false,
  hadError: true,
  stdout: "",
  stderr: "boom",
  durationMs: 5,
};

test("copilot: a crash before the result event reports NO session id", async () => {
  const handler = createAskCopilotHandler(deps(async () => COPILOT_CRASHED));
  const meta = metaOf(await handler({ prompt: "hi" }));

  assert.equal(meta.session_id, null);
  assert.ok(!UUID_RE.test(String(meta.session_id)));
});

test("copilot: the real session id is reported when copilot returns one", async () => {
  const handler = createAskCopilotHandler(
    deps(async () => ({ ...COPILOT_CRASHED, sessionId: "real-session", hadError: false, exitCode: 0, response: "hi" }))
  );
  assert.equal(metaOf(await handler({ prompt: "hi" })).session_id, "real-session");
});

// ── claude ───────────────────────────────────────────────────────────────────
// claude is the one CLI where --session-id lets us assign the id up front, so
// here a generated UUID IS legitimate: the CLI was told to use it.

const CLAUDE_CRASHED = {
  sessionId: null,
  text: "",
  sawResultEvent: false,
  toolCalls: [],
  usage: null,
  modelUsage: null,
  costUsd: null,
  numTurns: null,
  stopReason: null,
  terminalReason: null,
  apiErrorStatus: null,
  permissionDenials: [],
  rateLimitInfo: null,
  unparsedLines: 0,
  exitCode: 1,
  timedOut: false,
  hadError: true,
  stdout: "",
  stderr: "boom",
  durationMs: 5,
};

test("claude: the generated id is actually PASSED to the CLI, so reporting it is honest", async () => {
  const seen = {};
  const handler = createAskClaudeHandler({
    ...deps(async (o) => ({ ...CLAUDE_CRASHED, sessionId: o.sessionId }), seen),
    newSessionId: () => "generated-id",
  });
  const meta = metaOf(await handler({ prompt: "hi" }));

  assert.equal(seen.runArgs.sessionId, "generated-id", "must be handed to --session-id");
  assert.equal(seen.runArgs.resumeSessionId, null);
  assert.equal(meta.session_id, "generated-id");
});

test("claude: a caller-supplied id resumes instead of assigning a new one", async () => {
  const seen = {};
  const handler = createAskClaudeHandler({
    ...deps(async () => ({ ...CLAUDE_CRASHED, sessionId: "old-id" }), seen),
    newSessionId: () => "should-not-be-used",
  });
  await handler({ prompt: "hi", session_id: "old-id" });

  assert.equal(seen.runArgs.resumeSessionId, "old-id");
  assert.equal(seen.runArgs.sessionId, null, "never assign a new id while resuming");
});
