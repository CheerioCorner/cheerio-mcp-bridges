import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAskCodexHandler } from "../lib/codex-handler.mjs";
import { createAvailabilityStore } from "../lib/availability.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempDir() {
  return join(tmpdir(), "bridge-test-" + randomUUID().slice(0, 8));
}

function makeStore(dir, opts = {}) {
  const stateFile = join(dir, "availability.json");
  const lockDir = join(dir, "availability.lock");
  return createAvailabilityStore({ stateFile, lockDir, ...opts });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FAKE_OK = {
  threadId: "t-123",
  text: "Hello from codex",
  usage: { input_tokens: 10, output_tokens: 20 },
  exitCode: 0,
  timedOut: false,
  hadError: false,
  stdout: '{"type":"thread.started","thread_id":"t-123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Hello from codex"}}\n',
  stderr: "",
  durationMs: 100,
};

const FAKE_RATE_LIMITED = {
  threadId: "t-456",
  text: "",
  usage: null,
  exitCode: 1,
  timedOut: false,
  hadError: true,
  stdout: '{"type":"thread.failed","error":"rate limit"}\n',
  stderr: "429 Too Many Requests\nRetry-After: 3600",
  durationMs: 50,
};

const FAKE_TIMEOUT_ERR = {
  threadId: null,
  text: "",
  usage: null,
  exitCode: 1,
  timedOut: true,
  hadError: true,
  stdout: "",
  stderr: "process timed out after 300s",
  durationMs: 300000,
};

// ── State ───────────────────────────────────────────────────────────────────

let dir;
let store;
let auditCalls;

function setup() {
  dir = tempDir();
  store = makeStore(dir);
  auditCalls = [];
}

async function cleanup() {
  await rm(dir, { recursive: true, force: true });
}

function fakeAudit(kind, record) {
  auditCalls.push({ kind, ...record });
}

function handler(opts = {}) {
  return createAskCodexHandler({
    run: opts.run ?? (async () => FAKE_OK),
    audit: opts.audit ?? fakeAudit,
    checkAvailability: opts.checkAvailability ?? store.checkAvailability,
    recordBlocked: opts.recordBlocked ?? store.recordBlocked,
    clearBlocked: opts.clearBlocked ?? store.clearBlocked,
    // Default to the test's own temp-dir store, NOT the production singleton
    // (defaultResetProbe), so a test that forgets to override this can't
    // accidentally mutate the real state/availability.json on disk.
    resetProbeClaimedUntil: opts.resetProbeClaimedUntil ?? store.resetProbeClaimedUntil,
  });
}

test.beforeEach(() => setup());
test.afterEach(() => cleanup());

// ── Tests ───────────────────────────────────────────────────────────────────

test("blocked state -> run() not called, returns cli_unavailable", async () => {
  await store.recordBlocked("codex:default", {
    reason: "rate limited",
    confidence: "estimated",
    blockedUntil: "2099-01-01T00:00:00Z",
    recordedBy: "test",
  });

  let runCalled = false;
  const h = handler({ run: async () => { runCalled = true; return FAKE_OK; } });
  const result = await h({ prompt: "hi", model: undefined });

  assert.equal(runCalled, false, "run() should not be called when blocked");
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("cli_unavailable"));
  const info = JSON.parse(result.content[0].text.replace("CLI unavailable:\n", ""));
  assert.equal(new Date(info.blocked_until).getTime(), new Date("2099-01-01T00:00:00Z").getTime());
  assert.equal(info.reason, "rate limited");
  assert.equal(info.confidence, "estimated");
  // Audit should record the block.
  assert.ok(auditCalls.some((a) => a.blocked === true));
});

test("estimated probe -> a concurrent second call arriving while the probe is in flight is blocked", async () => {
  // Set up an estimated block that's already expired.
  const pastStore = makeStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await pastStore.recordBlocked("codex:default", {
    reason: "old block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });

  // Handler with "now" at 08:01 -- expired, should allow probe.
  // The CLI call is deliberately slow so a second request can arrive while
  // the first probe is still in flight (i.e. before clearBlocked() runs).
  const nowStore = makeStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") });
  let runCount = 0;
  const h = handler({
    run: async () => {
      runCount++;
      await new Promise((r) => setTimeout(r, 50));
      return FAKE_OK;
    },
    checkAvailability: nowStore.checkAvailability,
    recordBlocked: nowStore.recordBlocked,
    clearBlocked: nowStore.clearBlocked,
    resetProbeClaimedUntil: nowStore.resetProbeClaimedUntil,
  });

  // Fire both concurrently. Only the one that wins the probe claim should
  // actually invoke the CLI; the other must see probe_claimed_until still
  // held and get rejected outright.
  const [r1, r2] = await Promise.all([
    h({ prompt: "probe test" }),
    (async () => {
      await new Promise((r) => setTimeout(r, 5)); // let the first call claim the probe first
      return h({ prompt: "second call" });
    })(),
  ]);

  assert.equal(runCount, 1, "only the probe-claiming call should run the CLI");
  assert.equal(r1.isError, false, "the probing call should succeed");
  assert.equal(r2.isError, true, "the concurrent call should be rejected while the probe is in flight");
  assert.ok(r2.content[0].text.includes("cli_unavailable"));
});

test("estimated probe -> after a successful probe completes, the next sequential call runs normally (fully recovered)", async () => {
  // Set up an estimated block that's already expired.
  const pastStore = makeStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await pastStore.recordBlocked("codex:default", {
    reason: "old block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });

  const nowStore = makeStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") });
  let runCount = 0;
  const h = handler({
    run: async () => { runCount++; return FAKE_OK; },
    checkAvailability: nowStore.checkAvailability,
    recordBlocked: nowStore.recordBlocked,
    clearBlocked: nowStore.clearBlocked,
    resetProbeClaimedUntil: nowStore.resetProbeClaimedUntil,
  });

  // First call -> probe, succeeds, entry fully cleared.
  const r1 = await h({ prompt: "probe test" });
  assert.equal(runCount, 1, "first call should run CLI (probe)");
  assert.equal(r1.isError, false);

  // Second call, arriving AFTER the first has fully completed -> the block
  // is gone, so this must run the CLI directly, with no probe semantics.
  const r2 = await h({ prompt: "second call" });
  assert.equal(runCount, 2, "second call should run the CLI normally — the CLI has recovered");
  assert.equal(r2.isError, false);
});

test("CLI returns rate limit -> recordBlocked called", async () => {
  let recordCalled = false;
  const h = handler({
    run: async () => FAKE_RATE_LIMITED,
    recordBlocked: async (name, opts) => { recordCalled = true; return store.recordBlocked(name, opts); },
  });

  await h({ prompt: "trigger rate limit" });
  assert.equal(recordCalled, true, "recordBlocked should be called on rate limit detection");

  // Verify the entry was written.
  const raw = JSON.parse(await readFile(join(dir, "availability.json"), "utf8"));
  const entry = raw.entries["codex:default"];
  assert.ok(entry);
  assert.equal(entry.confidence, "exact"); // "Retry-After: 3600" -> exact
  // extractReason returns the first matching line only
  assert.ok(entry.reason.includes("429 Too Many Requests"));
});

test("probe success (non-rate-limit OK) -> clearBlocked called, entry fully removed", async () => {
  // Set up expired estimated block.
  const pastStore = makeStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await pastStore.recordBlocked("codex:default", {
    reason: "old block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });

  let clearCalled = false;
  let resetCalled = false;
  const nowStore = makeStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") });
  const h = handler({
    run: async () => FAKE_OK, // success, no rate limit
    checkAvailability: nowStore.checkAvailability,
    recordBlocked: nowStore.recordBlocked,
    clearBlocked: async (name) => { clearCalled = true; return nowStore.clearBlocked(name); },
    resetProbeClaimedUntil: async (name) => { resetCalled = true; return nowStore.resetProbeClaimedUntil(name); },
  });

  await h({ prompt: "probe success" });
  assert.equal(clearCalled, true, "clearBlocked should be called on genuine probe success (CLI healthy again)");
  assert.equal(resetCalled, false, "resetProbeClaimedUntil should NOT be called on genuine success");

  // Entry should be fully gone — a healthy CLI must not stay throttled forever.
  const raw = JSON.parse(await readFile(join(dir, "availability.json"), "utf8"));
  assert.equal(raw.entries["codex:default"], undefined, "entry should be fully removed after successful probe");

  // A subsequent call must run completely normally, with no probe semantics.
  let runCount = 0;
  const h2 = handler({
    run: async () => { runCount++; return FAKE_OK; },
    checkAvailability: nowStore.checkAvailability,
    recordBlocked: nowStore.recordBlocked,
    clearBlocked: nowStore.clearBlocked,
    resetProbeClaimedUntil: nowStore.resetProbeClaimedUntil,
  });
  const r2 = await h2({ prompt: "post-recovery call" });
  assert.equal(runCount, 1, "post-recovery call should run the CLI directly, not be treated as another probe");
  assert.equal(r2.isError, false);
});

test("probe fails for a non-rate-limit reason -> resetProbeClaimedUntil called, entry kept", async () => {
  // Set up expired estimated block.
  const pastStore = makeStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await pastStore.recordBlocked("codex:default", {
    reason: "old block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });

  let clearCalled = false;
  let resetCalled = false;
  const nowStore = makeStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") });
  const h = handler({
    run: async () => FAKE_TIMEOUT_ERR, // fails, but not a rate-limit signal
    checkAvailability: nowStore.checkAvailability,
    recordBlocked: nowStore.recordBlocked,
    clearBlocked: async (name) => { clearCalled = true; return nowStore.clearBlocked(name); },
    resetProbeClaimedUntil: async (name) => { resetCalled = true; return nowStore.resetProbeClaimedUntil(name); },
  });

  await h({ prompt: "probe fails, unrelated error" });
  assert.equal(clearCalled, false, "clearBlocked should NOT be called — we don't know the CLI is actually healthy");
  assert.equal(resetCalled, true, "resetProbeClaimedUntil should be called so a future request can retry the probe");

  // Entry should still exist (still estimated-blocked), but the claim is released.
  const raw = JSON.parse(await readFile(join(dir, "availability.json"), "utf8"));
  assert.ok(raw.entries["codex:default"], "entry should still exist after a non-rate-limit probe failure");
  assert.equal(raw.entries["codex:default"].probe_claimed_until, null);
});

test("non-rate-limit error -> no recordBlocked, no clearBlocked", async () => {
  let recordCalled = false;
  let clearCalled = false;
  const h = handler({
    run: async () => FAKE_TIMEOUT_ERR,
    recordBlocked: async (name, opts) => { recordCalled = true; return store.recordBlocked(name, opts); },
    clearBlocked: async (name) => { clearCalled = true; return store.clearBlocked(name); },
  });

  await h({ prompt: "timeout error" });
  // No rate limit detected, no probe -> neither should be called.
  assert.equal(recordCalled, false);
  assert.equal(clearCalled, false);
});

test("blocked response includes blocked_until, reason, confidence", async () => {
  await store.recordBlocked("codex:default", {
    reason: "quota exceeded",
    confidence: "human-reported",
    blockedUntil: null,
    recordedBy: "human",
  });

  const h = handler();
  const result = await h({ prompt: "hi" });
  const info = JSON.parse(result.content[0].text.replace("CLI unavailable:\n", ""));
  assert.equal(info.blocked_until, null);
  assert.equal(info.reason, "quota exceeded");
  assert.equal(info.confidence, "human-reported");
  assert.equal(info.recorded_by, "human");
});

test("specific model key is used (codex:o3 vs codex:default)", async () => {
  await store.recordBlocked("codex:o3", {
    reason: "o3 blocked",
    confidence: "estimated",
    blockedUntil: "2099-01-01T00:00:00Z",
    recordedBy: "test",
  });

  // codex:o3 -> blocked
  const h = handler();
  const r1 = await h({ prompt: "hi", model: "o3" });
  assert.equal(r1.isError, true);

  // codex:default -> allowed
  let runCalled = false;
  const h2 = handler({ run: async () => { runCalled = true; return FAKE_OK; } });
  const r2 = await h2({ prompt: "hi", model: undefined });
  assert.equal(runCalled, true);
});

test("spawn error with rate-limit text -> recordBlocked called", async () => {
  let recordCalled = false;
  const h = handler({
    run: async () => { throw new Error("quota exceeded for this account"); },
    recordBlocked: async (name, opts) => { recordCalled = true; return store.recordBlocked(name, opts); },
  });

  const result = await h({ prompt: "trigger spawn error" });
  assert.equal(result.isError, true);
  assert.equal(recordCalled, true, "recordBlocked should fire on spawn error with rate-limit text");
});

test("spawn error without rate-limit text -> no recordBlocked", async () => {
  let recordCalled = false;
  const h = handler({
    run: async () => { throw new Error("ENOENT: no such file"); },
    recordBlocked: async (name, opts) => { recordCalled = true; return store.recordBlocked(name, opts); },
  });

  await h({ prompt: "spawn error no rl" });
  assert.equal(recordCalled, false);
});
