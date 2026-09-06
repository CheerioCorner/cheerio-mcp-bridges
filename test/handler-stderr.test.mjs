/**
 * End-to-end regression test for the 2026-09-05 pi outage.
 *
 * The failure was not "pi broke" — it was "pi broke and the bridge told the
 * caller nothing". These tests drive each handler exactly as the MCP server
 * does, with a runner that reproduces the crash, and assert that the text the
 * ORCHESTRATING AGENT sees names the actual cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskPiHandler } from "../lib/pi-handler.mjs";
import { createAskAgyHandler } from "../lib/agy-handler.mjs";
import { createAskCodexHandler } from "../lib/codex-handler.mjs";
import { createAskCopilotHandler } from "../lib/copilot-handler.mjs";

const CRASH_STDERR =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server' " +
  "imported from ...\\pi-coding-agent\\dist\\cli.js";

/** Availability/audit stubs: always allowed, record nothing we care about. */
function deps(run, audits = []) {
  return {
    run,
    audit: async (kind, record) => audits.push({ kind, record }),
    checkAvailability: async () => ({ allowed: true, probe: false, entry: null }),
    recordBlocked: async () => {},
    clearBlocked: async () => {},
    resetProbeClaimedUntil: async () => {},
  };
}

/** What each handler factory needs, and how each shapes a crashed run. */
const BRIDGES = [
  {
    cli: "pi",
    create: createAskPiHandler,
    crashed: {
      sessionId: "s1",
      text: "",
      toolCalls: [],
      usage: null,
      exitCode: 1,
      timedOut: false,
      hadError: true,
      stdout: "",
      stderr: CRASH_STDERR,
      durationMs: 40,
    },
  },
  {
    cli: "agy",
    create: createAskAgyHandler,
    crashed: {
      conversationId: null,
      status: null,
      response: "",
      toolCalls: [],
      usage: null,
      numTurns: null,
      error: null,
      exitCode: 1,
      timedOut: false,
      hadError: true,
      stdout: "",
      stderr: CRASH_STDERR,
      durationMs: 40,
    },
  },
  {
    cli: "codex",
    create: createAskCodexHandler,
    crashed: {
      threadId: null,
      text: "",
      usage: null,
      exitCode: 1,
      timedOut: false,
      hadError: true,
      stdout: "",
      stderr: CRASH_STDERR,
      durationMs: 40,
    },
  },
  {
    cli: "copilot",
    create: createAskCopilotHandler,
    crashed: {
      sessionId: null,
      response: "",
      usage: null,
      error: null,
      quotaSnapshots: null,
      exitCode: 1,
      timedOut: false,
      hadError: true,
      stdout: "",
      stderr: CRASH_STDERR,
      durationMs: 40,
    },
  },
];

for (const { cli, create, crashed } of BRIDGES) {
  test(`${cli}: a crashed CLI surfaces stderr instead of "returned no text"`, async () => {
    const handler = create(deps(async () => crashed));
    const res = await handler({ prompt: "hello" });

    const text = res.content[0].text;
    assert.equal(res.isError, true);
    assert.ok(text.includes("ERR_MODULE_NOT_FOUND"), `${cli}: cause must be in the reply`);
    assert.ok(text.includes("pi-server"), `${cli}: the missing package must be named`);
    assert.ok(
      !text.includes(`(${cli} returned no text)`),
      `${cli}: the old useless message must be gone`
    );
  });

  test(`${cli}: the crash is written to the audit log too`, async () => {
    const audits = [];
    const handler = create(deps(async () => crashed, audits));
    await handler({ prompt: "hello" });

    const logged = audits.map((a) => JSON.stringify(a.record)).join("\n");
    assert.ok(logged.includes("ERR_MODULE_NOT_FOUND"), `${cli}: stderr must reach the audit log`);
  });

  test(`${cli}: a healthy run is unchanged — no stderr noise in the reply`, async () => {
    const ok = {
      ...crashed,
      exitCode: 0,
      hadError: false,
      stderr: "(node:1) ExperimentalWarning: blah",
      text: "the answer",
      response: "the answer",
    };
    const handler = create(deps(async () => ok));
    const res = await handler({ prompt: "hello" });

    const [primary] = res.content[0].text.split("\n\n---\n");
    assert.equal(res.isError, false);
    assert.equal(primary, "the answer");
    assert.ok(!primary.includes("ExperimentalWarning"));
  });
}

test("pi: a timeout says it timed out, and still shows whatever stderr there was", async () => {
  const handler = createAskPiHandler(
    deps(async () => ({
      sessionId: "s1",
      text: "",
      toolCalls: [],
      usage: null,
      exitCode: null,
      timedOut: true,
      hadError: true,
      stdout: "",
      stderr: "still waiting on the model",
      durationMs: 300000,
    }))
  );
  const text = (await handler({ prompt: "hi" })).content[0].text;
  assert.match(text, /timed out/);
  assert.match(text, /still waiting on the model/);
});

test("pi: no text, no stderr, non-zero exit — says so rather than going quiet", async () => {
  const handler = createAskPiHandler(
    deps(async () => ({
      sessionId: "s1",
      text: "",
      toolCalls: [],
      usage: null,
      exitCode: 3,
      timedOut: false,
      hadError: true,
      stdout: "",
      stderr: "",
      durationMs: 10,
    }))
  );
  const text = (await handler({ prompt: "hi" })).content[0].text;
  assert.match(text, /exit code 3/);
  assert.match(text, /no stderr was captured/);
});
