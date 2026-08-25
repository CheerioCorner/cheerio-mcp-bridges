/**
 * Testable handler factory for the copilot bridge.
 *
 * Separated from src/copilot-bridge.mjs so that tests can import this module
 * without triggering the top-level requireEnv() calls in lib/copilot.mjs.
 * All dependencies are explicit — no hidden imports.
 */

import { randomUUID } from "node:crypto";
import { availabilityKey } from "./availability.mjs";
import { detectRateLimit } from "./rate-limit.mjs";

/**
 * Create a testable askCopilot handler.
 *
 * @param {object} opts
 * @param {Function} opts.run              CLI runner (e.g. runCopilot).
 * @param {Function} opts.audit            Audit logger (e.g. appendAudit).
 * @param {Function} opts.checkAvailability  Availability checker.
 * @param {Function} opts.recordBlocked    Block recorder.
 * @param {Function} opts.clearBlocked     Block clearer.
 * @returns {Function} askCopilot handler
 */
export function createAskCopilotHandler({
  run,
  audit,
  checkAvailability,
  recordBlocked,
  clearBlocked,
  resetProbeClaimedUntil,
}) {
  return async function askCopilot({ prompt, session_id, model, effort, max_ai_credits, dangerously_allow_all, timeout_ms }) {
    const sessionId = session_id || randomUUID();
    const availabilityName = availabilityKey("copilot", model);

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
      await audit("copilot", {
        sessionId,
        prompt,
        model,
        effort,
        dangerously_allow_all: !!dangerously_allow_all,
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
        effort,
        maxAiCredits: max_ai_credits,
        dangerouslyAllowAll: dangerously_allow_all,
        timeoutMs: timeout_ms,
      });
    } catch (err) {
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
          recordedBy: "copilot-bridge",
        });
      }
      await audit("copilot", {
        sessionId,
        prompt,
        model,
        effort,
        dangerously_allow_all: !!dangerously_allow_all,
        availabilityName,
        availabilityProbe: probe,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch copilot: ${err?.message || err}` }],
      };
    }

    // ── Post-flight rate-limit detection ───────────────────────────────────
    // result.hadError folds in result.timedOut (see runCopilot), so a bare
    // timeout would otherwise look identical to a confirmed CLI error. A
    // timeout alone is not evidence of rate limiting (W-2026-08-086) — pass
    // the two apart so detectRateLimit can restrict scan breadth accordingly.
    const rateLimit = detectRateLimit({
      stdout: result.stdout,
      stderr: result.stderr,
      text: result.response,
      error: result.error,
      exitCode: result.exitCode,
      hadError: result.hadError && !result.timedOut,
      timedOut: result.timedOut,
    });

    if (rateLimit.limited) {
      await recordBlocked(availabilityName, {
        reason: rateLimit.reason,
        confidence: rateLimit.confidence,
        blockedUntil: rateLimit.blockedUntil,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        recordedBy: "copilot-bridge",
      });
    } else if (probe) {
      if (!result.hadError) {
        // Probe succeeded and the CLI itself reported success — the block
        // condition is gone, fully clear the entry so future calls run normally.
        await clearBlocked(availabilityName);
      } else {
        // Probe failed for a reason unrelated to rate limiting. Don't declare
        // the CLI healthy, but release the claim so a future request can
        // attempt another probe instead of waiting out the full window again.
        await resetProbeClaimedUntil(availabilityName);
      }
    }

    const stderrSnippet = result.stderr ? truncate(result.stderr, 2000) : null;

    await audit("copilot", {
      sessionId: result.sessionId || sessionId,
      prompt,
      model,
      effort,
      dangerously_allow_all: !!dangerously_allow_all,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      error: result.error,
      stderr: stderrSnippet,
      usage: result.usage,
      durationMs: result.durationMs,
      quotaSnapshots: result.quotaSnapshots,
      availabilityName,
      availabilityProbe: probe,
      rateLimited: rateLimit.limited,
      rateLimitConfidence: rateLimit.confidence,
    });

    const meta = {
      session_id: result.sessionId || sessionId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      error: result.error,
      stderr: stderrSnippet,
      usage: result.usage,
      quota_snapshots: result.quotaSnapshots,
    };
    const body =
      (result.response?.trim() || result.error || stderrSnippet || "(copilot returned no text)") +
      "\n\n---\n" +
      "copilot-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  };
}

function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || null;
  return s.slice(0, maxLen) + "... (truncated)";
}
