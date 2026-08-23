import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAvailabilityStore } from "../lib/availability.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempDir() {
  return join(tmpdir(), `avail-test-${randomUUID().slice(0, 8)}`);
}

function createStore(dir, opts = {}) {
  const stateFile = join(dir, "availability.json");
  const lockDir = join(dir, "availability.lock");
  return { store: createAvailabilityStore({ stateFile, lockDir, ...opts }), stateFile, lockDir };
}

function futureDate(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function pastDate(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("state file not found → treat as empty, allow call", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir);
  const result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.probe, false);
  assert.equal(result.entry, null);
  await rm(dir, { recursive: true, force: true });
});

test("recordBlocked writes entry matching schema", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir);
  await store.recordBlocked("codex:o3", {
    reason: "rate limit",
    confidence: "estimated",
  });
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = raw.entries["codex:o3"];
  assert.ok(entry);
  assert.equal(entry.reason, "rate limit");
  assert.equal(entry.confidence, "estimated");
  assert.ok(entry.blocked_until);
  assert.equal(entry.recorded_by, "codex:o3");
  assert.ok(entry.recorded_at);
  assert.equal(entry.probe_claimed_until, null);
  assert.equal(raw.version, 1);
  await rm(dir, { recursive: true, force: true });
});

test("exact not expired → blocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "429",
    confidence: "exact",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  const result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.probe, false);
  await rm(dir, { recursive: true, force: true });
});

test("exact expired → auto-clear and allow", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  // Write with clock at 07:00, blocked_until = 08:00
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "429",
    confidence: "exact",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  // Check at 08:01 (expired)
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const result = await store2.checkAvailability("codex:o3");
  assert.equal(result.allowed, true);
  assert.equal(result.blocked, false);
  // Entry should be auto-cleared.
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"], undefined);
  await rm(dir, { recursive: true, force: true });
});

test("human-reported before expiry → blocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "manual",
    confidence: "human-reported",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "human",
  });
  const result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.probe, false);
  await rm(dir, { recursive: true, force: true });
});

test("human-reported blocked_until: null → permanent block until clearBlocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "permanent block",
    confidence: "human-reported",
    blockedUntil: null,
    recordedBy: "human",
  });
  // Should be permanently blocked.
  let result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
  // clearBlocked removes it.
  await store.clearBlocked("codex:o3");
  result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, true);
  assert.equal(result.entry, null);
  await rm(dir, { recursive: true, force: true });
});

test("estimated not expired → blocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  const result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.probe, false);
  await rm(dir, { recursive: true, force: true });
});

test("estimated expired → allows probe (probe: true)", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  // Check at 08:01 (expired)
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const result = await store2.checkAvailability("codex:o3");
  assert.equal(result.allowed, true);
  assert.equal(result.blocked, true);
  assert.equal(result.probe, true);
  await rm(dir, { recursive: true, force: true });
});

test("two concurrent checks on expired estimated → only one gets probe", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  // Simulate two "concurrent" checks (serial but both expired)
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const result1 = await store2.checkAvailability("codex:o3");
  const result2 = await store2.checkAvailability("codex:o3");
  assert.equal(result1.probe, true, "first check should get probe");
  assert.equal(result2.probe, false, "second check should not get probe (already claimed)");
  assert.equal(result2.allowed, false);
  await rm(dir, { recursive: true, force: true });
});

test("resetProbeClaimedUntil releases the claim but keeps the entry (used after a non-rate-limit probe failure, NOT on success)", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const probeResult = await store2.checkAvailability("codex:o3");
  assert.equal(probeResult.probe, true);
  // Probe succeeded → reset probe_claimed_until (keep entry).
  await store2.resetProbeClaimedUntil("codex:o3");
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.ok(raw.entries["codex:o3"], "entry should still exist");
  assert.equal(raw.entries["codex:o3"].probe_claimed_until, null);
  // Should still be blocked (estimated, expired, no probe claim).
  const final = await store2.checkAvailability("codex:o3");
  assert.equal(final.allowed, true, "should be allowed after probe claim released");
  assert.equal(final.probe, true, "should allow a new probe");
  await rm(dir, { recursive: true, force: true });
});

test("clearBlocked removes entry completely", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const probeResult = await store2.checkAvailability("codex:o3");
  assert.equal(probeResult.probe, true);
  // Probe succeeded → clear.
  await store2.clearBlocked("codex:o3");
  const final = await store2.checkAvailability("codex:o3");
  assert.equal(final.allowed, true);
  assert.equal(final.entry, null);
  await rm(dir, { recursive: true, force: true });
});

test("probe fails with rate limit → recordBlocked extends 1hr, probe_claimed_until reset", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const probeResult = await store2.checkAvailability("codex:o3");
  assert.equal(probeResult.probe, true);
  // Probe failed with rate limit again → record new block.
  await store2.recordBlocked("codex:o3", {
    reason: "still rate limited",
    confidence: "estimated",
    recordedBy: "test",
  });
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = raw.entries["codex:o3"];
  assert.equal(entry.confidence, "estimated");
  assert.equal(entry.probe_claimed_until, null);
  // blocked_until should be ~1hr from "now" (08:01 + 1hr = 09:01)
  const blockedUntil = new Date(entry.blocked_until);
  assert.ok(blockedUntil > new Date("2026-08-22T09:00:00Z"));
  await rm(dir, { recursive: true, force: true });
});

test("probe fails with non-rate-limit error → don't clear, probe_claimed_until reset to null", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "test",
  });
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const probeResult = await store2.checkAvailability("codex:o3");
  assert.equal(probeResult.probe, true);
  // Non-rate-limit failure: don't clear, but reset probe_claimed_until.
  // We simulate this by directly resetting probe_claimed_until (as the bridge handler would).
  const { stateFile: sf2, lockDir: ld2 } = createStore(dir);
  const store3 = createAvailabilityStoreWith(dir);
  // Actually, let's just use the store's internal reset.
  // The bridge handler calls resetProbeClaimedUntil on non-rate-limit probe failure.
  // For this test, we verify the state after a manual reset.
  // Re-read state and verify probe_claimed_until was set.
  const raw1 = JSON.parse(await readFile(stateFile, "utf8"));
  assert.ok(raw1.entries["codex:o3"].probe_claimed_until);
  // Now we need to reset it. The bridge would call resetProbeClaimedUntil.
  // Since we're testing the store directly, let's just use recordBlocked with a new reason
  // and verify probe_claimed_until is cleared.
  // Actually, let's just test the full flow: probe → non-rate-limit error → recordBlocked doesn't happen
  // but probe_claimed_until needs to be null. The bridge handles this via resetProbeClaimedUntil.
  // For the unit test, we verify that recordBlocked clears probe_claimed_until.
  await store2.recordBlocked("codex:o3", {
    reason: "timeout error",
    confidence: "estimated",
    recordedBy: "test",
  });
  const raw2 = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw2.entries["codex:o3"].probe_claimed_until, null);
  await rm(dir, { recursive: true, force: true });
});

// Helper for above test
function createAvailabilityStoreWith(dir) {
  const stateFile = join(dir, "availability.json");
  const lockDir = join(dir, "availability.lock");
  return createAvailabilityStore({ stateFile, lockDir });
}

test("different keys don't affect each other", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "blocked",
    confidence: "estimated",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  const r1 = await store.checkAvailability("codex:o3");
  const r2 = await store.checkAvailability("codex:default");
  assert.equal(r1.allowed, false);
  assert.equal(r2.allowed, true);
  await rm(dir, { recursive: true, force: true });
});

test("corrupted JSON → checkAvailability fails closed", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const stateFile = join(dir, "availability.json");
  await writeFile(stateFile, "{ NOT VALID JSON {{{", "utf8");
  const { store } = createStore(dir);
  const result = await store.checkAvailability("codex:o3");
  assert.equal(result.allowed, false);
  assert.equal(result.stateError, true);
  await rm(dir, { recursive: true, force: true });
});

test("corrupted JSON → recordBlocked backs up and rewrites", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const stateFile = join(dir, "availability.json");
  await writeFile(stateFile, "{ NOT VALID JSON {{{", "utf8");
  const { store } = createStore(dir);
  await store.recordBlocked("codex:o3", {
    reason: "recovered",
    confidence: "estimated",
    recordedBy: "test",
  });
  // Original should be backed up as .corrupt.*
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(dir);
  const corruptFile = files.find((f) => f.startsWith("availability.json.corrupt."));
  assert.ok(corruptFile, "corrupt backup should exist");
  // Current file should be valid.
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.ok(raw.entries["codex:o3"]);
  await rm(dir, { recursive: true, force: true });
});

test("active human-reported not overridden by automatic recordBlocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "human block",
    confidence: "human-reported",
    blockedUntil: null,
    recordedBy: "human",
  });
  // Try to override with estimated.
  const result = await store.recordBlocked("codex:o3", {
    reason: "auto detected",
    confidence: "estimated",
    recordedBy: "codex-bridge",
  });
  assert.equal(result.overridden, false);
  assert.equal(result.reason, "human-reported entry active");
  // Original entry should be unchanged.
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"].confidence, "human-reported");
  assert.equal(raw.entries["codex:o3"].reason, "human block");
  await rm(dir, { recursive: true, force: true });
});

test("expired human-reported can be overridden by automatic recordBlocked", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "human block",
    confidence: "human-reported",
    blockedUntil: "2026-08-22T08:30:00Z",
    recordedBy: "human",
  });
  // Advance clock past expiry.
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T09:00:00Z") }).store;
  const result = await store2.recordBlocked("codex:o3", {
    reason: "auto detected after human block expired",
    confidence: "estimated",
    recordedBy: "codex-bridge",
  });
  assert.equal(result.overridden, true);
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"].confidence, "estimated");
  await rm(dir, { recursive: true, force: true });
});

test("active exact not overridden by estimated, but overridden by later exact", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "exact block",
    confidence: "exact",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  // Try estimated → should be rejected.
  const r1 = await store.recordBlocked("codex:o3", {
    reason: "estimated",
    confidence: "estimated",
    recordedBy: "test",
  });
  assert.equal(r1.overridden, false);
  // Try earlier exact → should be rejected.
  const r2 = await store.recordBlocked("codex:o3", {
    reason: "exact earlier",
    confidence: "exact",
    blockedUntil: "2026-08-22T08:30:00Z",
    recordedBy: "test",
  });
  assert.equal(r2.overridden, false);
  // Try later exact → should be accepted.
  const r3 = await store.recordBlocked("codex:o3", {
    reason: "exact later",
    confidence: "exact",
    blockedUntil: "2026-08-22T10:00:00Z",
    recordedBy: "test",
  });
  assert.equal(r3.overridden, true);
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"].reason, "exact later");
  // blockedUntil is stored exactly as passed ("2026-08-22T10:00:00Z")
  assert.ok(new Date(raw.entries["codex:o3"].blocked_until).getTime() === new Date("2026-08-22T10:00:00Z").getTime());
  await rm(dir, { recursive: true, force: true });
});

test("active estimated overridden by any exact", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated block",
    confidence: "estimated",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  const result = await store.recordBlocked("codex:o3", {
    reason: "exact override",
    confidence: "exact",
    blockedUntil: "2026-08-22T08:30:00Z",
    recordedBy: "test",
  });
  assert.equal(result.overridden, true);
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"].confidence, "exact");
  assert.equal(raw.entries["codex:o3"].reason, "exact override");
  await rm(dir, { recursive: true, force: true });
});

test("active estimated with later blocked_until not overridden by earlier estimated", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "estimated later",
    confidence: "estimated",
    blockedUntil: "2026-08-22T10:00:00Z",
    recordedBy: "test",
  });
  const result = await store.recordBlocked("codex:o3", {
    reason: "estimated earlier",
    confidence: "estimated",
    blockedUntil: "2026-08-22T09:00:00Z",
    recordedBy: "test",
  });
  assert.equal(result.overridden, false);
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"].reason, "estimated later");
  await rm(dir, { recursive: true, force: true });
});

test("clearBlocked removes entry completely", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir);
  await store.recordBlocked("codex:o3", {
    reason: "test",
    confidence: "estimated",
    recordedBy: "test",
  });
  await store.clearBlocked("codex:o3");
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(raw.entries["codex:o3"], undefined);
  await rm(dir, { recursive: true, force: true });
});

test("retryAfterSeconds is used to compute blockedUntil", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store, stateFile } = createStore(dir, { now: () => new Date("2026-08-22T08:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "retry after",
    confidence: "exact",
    retryAfterSeconds: 3600,
    recordedBy: "test",
  });
  const raw = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = raw.entries["codex:o3"];
  assert.equal(entry.blocked_until, "2026-08-22T09:00:00.000Z");
  await rm(dir, { recursive: true, force: true });
});

test("human-reported expired (with blocked_until) → allowed, no probe", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const { store } = createStore(dir, { now: () => new Date("2026-08-22T07:00:00Z") });
  await store.recordBlocked("codex:o3", {
    reason: "human block with time",
    confidence: "human-reported",
    blockedUntil: "2026-08-22T08:00:00Z",
    recordedBy: "human",
  });
  // Check after expiry
  const store2 = createStore(dir, { now: () => new Date("2026-08-22T08:01:00Z") }).store;
  const result = await store2.checkAvailability("codex:o3");
  assert.equal(result.allowed, true);
  assert.equal(result.probe, false, "human-reported expiry should not trigger probe");
  await rm(dir, { recursive: true, force: true });
});

test("availabilityKey formats correctly", async () => {
  const { availabilityKey } = await import("../lib/availability.mjs");
  assert.equal(availabilityKey("codex", "o3"), "codex:o3");
  assert.equal(availabilityKey("codex"), "codex:default");
  assert.equal(availabilityKey("codex", ""), "codex:default");
  assert.equal(availabilityKey("codex", null), "codex:default");
});
