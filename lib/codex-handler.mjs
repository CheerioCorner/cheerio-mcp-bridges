/**
 * Testable handler factory for the codex bridge.
 *
 * Separated from src/codex-bridge.mjs so that tests can import this module
 * without triggering the top-level requireEnv() calls in lib/codex.mjs.
 * All dependencies are explicit — no hidden imports.
 */

import { randomUUID } from "node:crypto";
import { availabilityKey } from "./availability.mjs";
import { detectRateLimit } from "./rate-limit.mjs";

/**
 * Create a testable askCodex handler.
 *
 * @param {object} opts
 * @param {Function} opts.run              CLI runner (e.g. runCodex).
 * @param {Function} opts.audit            Audit logger (e.g. appendAudit).
 * @param {Function} opts.checkAvailability  Availability checker.
 * @param {Function} opts.recordBlocked    Block recorder.
 * @param {Function} opts.clearBlocked     Block clearer.
 * @returns {Function} askCodex handler
 */
export function createAskCodexHandler({
  run,
  audit,
  checkAvailability,
  recordBlocked,
  clearBlocked,
  resetProbeClaimedUntil,
}) {
  return async function askCodex({ prompt, session_id, model, sandbox, timeout_ms }) {
    const threadId = session_id || randomUUID();
    const availabilityName = availabilityKey("codex", model);

    // ── Pre-flight availability check ──────────────────────────────────────
    const availability = await checkAvailability(availabilityName);
    const probe = availability.probe;

    if (!availability.allowed) {
      const entry = availability.entry;
      const blockedInfo = {
        error: "cli_unavailable",
        availability_name: availabilityName,
        blocked_until: entry?.blocked_until ?? null,
        reason: entry?.reason ?? null,
        confidence: entry?.confidence ?? null,
        recorded_by: entry?.recorded_by ?? null,
        recorded_at: entry?.recorded_at ?? null,
      };
      await audit("codex", {
        threadId,
        prompt,
        model,
        sandbox: sandbox || "read-only",
        availabilityName,
        availabilityProbe: probe,
        blocked: true,
        blocked_until: blockedInfo.blocked_until,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `CLI unavailable:\n${JSON.stringify(blockedInfo, null, 2)}` }],
      };
    }

    // ── Spawn CLI ──────────────────────────────────────────────────────────
    let result;
    try {
      result = await run({
        prompt,
        sessionId: session_id || undefined,
        model,
        sandbox: sandbox || "read-only",
        timeoutMs: timeout_ms,
      });
    } catch (err) {
      // Check if the spawn error itself signals rate limiting.
      const errRateLimit = detectRateLimit({
        error: String(err?.message || err),
        hadError: true,
      });
      if (errRateLimit.limited) {
        await recordBlocked(availabilityName, {
          reason: errRateLimit.reason,
          confidence: errRateLimit.confidence,
          blockedUntil: errRateLimit.blockedUntil,
          retryAfterSeconds: errRateLimit.retryAfterSeconds,
          recordedBy: "codex-bridge",
        });
      }
      await audit("codex", {
        threadId,
        prompt,
        model,
        sandbox: sandbox || "read-only",
        availabilityName,
        availabilityProbe: probe,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch codex: ${err?.message || err}` }],
      };
    }

    // ── Post-flight rate-limit detection ───────────────────────────────────
    const rateLimit = detectRateLimit({
      stdout: result.stdout,
      stderr: result.stderr,
      text: result.text,
      exitCode: result.exitCode,
      hadError: result.hadError,
    });

    if (rateLimit.limited) {
      await recordBlocked(availabilityName, {
        reason: rateLimit.reason,
        confidence: rateLimit.confidence,
        blockedUntil: rateLimit.blockedUntil,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        recordedBy: "codex-bridge",
      });
    } else if (probe) {
      if (!result.hadError) {
        // Probe succeeded and the CLI itself reported success — the block
        // condition is gone, fully clear the entry so future calls run normally.
        await clearBlocked(availabilityName);
      } else {
        // Probe failed for a reason unrelated to rate limiting (e.g. bad args,
        // timeout). Don't declare the CLI healthy, but release the claim so a
        // future request can attempt another probe instead of waiting out the
        // full estimated window again.
        await resetProbeClaimedUntil(availabilityName);
      }
    }

    const stderrSnippet = result.stderr ? truncate(result.stderr, 2000) : null;

    await audit("codex", {
      threadId: result.threadId || threadId,
      prompt,
      model,
      sandbox: sandbox || "read-only",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      stderr: stderrSnippet,
      usage: result.usage,
      durationMs: result.durationMs,
      availabilityName,
      availabilityProbe: probe,
      rateLimited: rateLimit.limited,
      rateLimitConfidence: rateLimit.confidence,
    });

    const meta = {
      thread_id: result.threadId || threadId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      stderr: stderrSnippet,
      usage: result.usage,
    };
    const body =
      (result.text || stderrSnippet || "(codex returned no text)") +
      "\n\n---\n" +
      "codex-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  };
}

/**
 * Truncate a string to maxLen characters, keeping the HEAD (where errors usually are).
 */
function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || null;
  return s.slice(0, maxLen) + "... (truncated)";
}
