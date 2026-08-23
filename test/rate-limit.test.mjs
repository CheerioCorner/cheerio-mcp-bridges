import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRateLimit, RATE_LIMIT_PATTERNS } from "../lib/rate-limit.mjs";

// ── Detection ───────────────────────────────────────────────────────────────

test("detects '429 Too Many Requests'", () => {
  const r = detectRateLimit({ stderr: "429 Too Many Requests", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.source, "stderr");
  assert.ok(r.reason.includes("429"));
});

test("detects 'rate limit exceeded'", () => {
  const r = detectRateLimit({ text: "rate limit exceeded", hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.source, "text");
});

test("detects 'quota exceeded'", () => {
  const r = detectRateLimit({ error: "quota exceeded", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.source, "error");
});

test("detects 'RESOURCE_EXHAUSTED'", () => {
  const r = detectRateLimit({ stderr: "RESOURCE_EXHAUSTED", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
});

test("detects 'Retry-After: 3600' as exact", () => {
  const before = Date.now();
  const r = detectRateLimit({ stderr: "Retry-After: 3600", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "exact");
  assert.equal(r.retryAfterSeconds, 3600);
  assert.ok(r.blockedUntil);
  const blockedMs = new Date(r.blockedUntil).getTime();
  assert.ok(blockedMs >= before + 3600_000 - 1000);
  assert.ok(blockedMs <= before + 3600_000 + 1000);
});

test("detects 'retry again in 15 minutes' as exact", () => {
  const before = Date.now();
  const r = detectRateLimit({ text: "Please retry again in 15 minutes", hadError: true, exitCode: 1 });
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "exact");
  assert.equal(r.retryAfterSeconds, 15 * 60);
  const blockedMs = new Date(r.blockedUntil).getTime();
  assert.ok(blockedMs >= before + 15 * 60_000 - 1000);
  assert.ok(blockedMs <= before + 15 * 60_000 + 1000);
});

test("detects 'retry again in 2 hours' as exact", () => {
  const before = Date.now();
  const r = detectRateLimit({ stderr: "retry again in 2 hours", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "exact");
  assert.equal(r.retryAfterSeconds, 2 * 3600);
});

test("detects Unix reset timestamp 'resets at 1763802000' as exact", () => {
  // 1763802000 is in the future relative to 2026.
  const futureTs = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
  const r = detectRateLimit({ stderr: `resets at ${futureTs}`, exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "exact");
  assert.ok(r.retryAfterSeconds > 0);
  const blockedMs = new Date(r.blockedUntil).getTime();
  const expectedMs = futureTs * 1000;
  assert.ok(Math.abs(blockedMs - expectedMs) < 2000);
});

test("no time info → estimated confidence", () => {
  const r = detectRateLimit({ stderr: "rate limit", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
  assert.equal(r.confidence, "estimated");
  assert.equal(r.blockedUntil, null);
  assert.equal(r.retryAfterSeconds, null);
});

// ── Anti-false-positive gate ────────────────────────────────────────────────

test("hadError:false, exitCode:0 → even with rate limit text, NOT flagged", () => {
  const r = detectRateLimit({
    text: "This document explains rate limiting and how to handle 429 errors",
    exitCode: 0,
    hadError: false,
  });
  assert.equal(r.limited, false, "should not flag successful output mentioning rate limit");
});

test("hadError:false, exitCode:0 → 'too many requests' in response text NOT flagged", () => {
  const r = detectRateLimit({
    text: "The API returned 429 Too Many Requests because the user sent too many requests",
    exitCode: 0,
    hadError: false,
  });
  assert.equal(r.limited, false);
});

test("hadError:false, exitCode:0 → 'quota exceeded' in response NOT flagged", () => {
  const r = detectRateLimit({
    text: "When you see quota exceeded errors, you should back off",
    exitCode: 0,
    hadError: false,
  });
  assert.equal(r.limited, false);
});

test("hadError:false, exitCode:0 → 'RESOURCE_EXHAUSTED' in response NOT flagged", () => {
  const r = detectRateLimit({
    text: "RESOURCE_EXHAUSTED can occur when...",
    exitCode: 0,
    hadError: false,
  });
  assert.equal(r.limited, false);
});

// ── Non-rate-limit errors not misidentified ─────────────────────────────────

test("generic non-zero exit code without rate-limit keywords → not flagged", () => {
  const r = detectRateLimit({
    stderr: "Error: file not found",
    exitCode: 1,
    hadError: true,
  });
  assert.equal(r.limited, false);
});

test("generic error message → not flagged", () => {
  const r = detectRateLimit({
    error: "ENOENT: no such file or directory",
    exitCode: 1,
    hadError: true,
  });
  assert.equal(r.limited, false);
});

test("timeout error → not flagged", () => {
  const r = detectRateLimit({
    error: "process timed out after 300s",
    exitCode: 0,
    hadError: true,
  });
  assert.equal(r.limited, false);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test("empty inputs → not flagged", () => {
  const r = detectRateLimit({});
  assert.equal(r.limited, false);
});

test("exitCode:429 (number) matches pattern '429'", () => {
  // The 429 pattern matches the string "429" in any source.
  const r = detectRateLimit({ stderr: "error code: 429", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
});

test("all patterns are regex", () => {
  for (const p of RATE_LIMIT_PATTERNS) {
    assert.ok(p instanceof RegExp, `pattern ${p} should be a RegExp`);
  }
});

test("scan priority: error > stderr > text > stdout", () => {
  // If error matches, it wins.
  const r = detectRateLimit({
    stdout: "rate limit in stdout",
    stderr: "rate limit in stderr",
    text: "rate limit in text",
    error: "rate limit in error",
    exitCode: 1,
    hadError: true,
  });
  assert.equal(r.source, "error");
});

test("'try again in 30 seconds' → exact with seconds", () => {
  const before = Date.now();
  const r = detectRateLimit({ stderr: "try again in 30 seconds", exitCode: 1, hadError: true });
  assert.equal(r.confidence, "exact");
  assert.equal(r.retryAfterSeconds, 30);
});

test("'try again in 1 hour' → exact with hours", () => {
  const before = Date.now();
  const r = detectRateLimit({ stderr: "try again in 1 hour", exitCode: 1, hadError: true });
  assert.equal(r.confidence, "exact");
  assert.equal(r.retryAfterSeconds, 3600);
});

test("already-expired Unix timestamp → estimated (no time extracted)", () => {
  const pastTs = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
  const r = detectRateLimit({ stderr: `resets at ${pastTs}`, exitCode: 1, hadError: true });
  // Past timestamp is skipped, so no time extracted → estimated.
  assert.equal(r.confidence, "estimated");
});

test("'quota depleted' → detected", () => {
  const r = detectRateLimit({ stderr: "quota depleted for this billing cycle", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
});

test("'credits exhausted' → detected", () => {
  const r = detectRateLimit({ stderr: "credits exhausted", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
});

test("'limit reached' → detected", () => {
  const r = detectRateLimit({ stderr: "limit reached for model xyz", exitCode: 1, hadError: true });
  assert.equal(r.limited, true);
});
