/**
 * Testable handler factory for the agy (Gemini) bridge.
 *
 * Separated from src/agy-bridge.mjs so that tests can import this module
 * without triggering the top-level requireEnv() calls in lib/agy.mjs.
 * All dependencies are explicit — no hidden imports.
 */

import { availabilityKey } from "./availability.mjs";
import { detectRateLimit } from "./rate-limit.mjs";

/**
 * Create a testable askAgy handler.
 *
 * @param {object} opts
 * @param {Function} opts.run              CLI runner (e.g. runAgy).
 * @param {Function} opts.audit            Audit logger (e.g. appendAudit).
 * @param {Function} opts.checkAvailability  Availability checker.
 * @param {Function} opts.recordBlocked    Block recorder.
 * @param {Function} opts.clearBlocked     Block clearer.
 * @returns {Function} askAgy handler
 */
export function createAskAgyHandler({
  run,
  audit,
  checkAvailability,
  recordBlocked,
  clearBlocked,
  resetProbeClaimedUntil,
}) {
  return async function askAgy({ prompt, conversation_id, model, effort, sandbox, dangerously_allow_all, timeout_ms }) {
    const effectiveSandbox = sandbox !== false;
    const effectiveDangerouslyAllowAll = dangerously_allow_all !== false;
    const availabilityName = availabilityKey("agy", model);

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
      await audit("agy", {
        conversationId: conversation_id,
        prompt,
        sandbox: effectiveSandbox,
        dangerously_allow_all: effectiveDangerouslyAllowAll,
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
        conversationId: conversation_id,
        model,
        effort,
        sandbox,
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
          recordedBy: "agy-bridge",
        });
      }
      await audit("agy", {
        conversationId: conversation_id,
        prompt,
        sandbox: effectiveSandbox,
        dangerously_allow_all: effectiveDangerouslyAllowAll,
        availabilityName,
        availabilityProbe: probe,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch agy: ${err?.message || err}` }],
      };
    }

    // ── Post-flight rate-limit detection ───────────────────────────────────
    const rateLimit = detectRateLimit({
      stdout: result.stdout,
      stderr: result.stderr,
      text: result.response,
      error: result.error,
      exitCode: result.exitCode,
      hadError: result.hadError,
    });

    if (rateLimit.limited) {
      await recordBlocked(availabilityName, {
        reason: rateLimit.reason,
        confidence: rateLimit.confidence,
        blockedUntil: rateLimit.blockedUntil,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        recordedBy: "agy-bridge",
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

    await audit("agy", {
      conversationId: result.conversationId,
      prompt,
      sandbox: effectiveSandbox,
      dangerously_allow_all: effectiveDangerouslyAllowAll,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      toolCalls: result.toolCalls,
      numTurns: result.numTurns,
      usage: result.usage,
      durationMs: result.durationMs,
      stderr: stderrSnippet,
      availabilityName,
      availabilityProbe: probe,
      rateLimited: rateLimit.limited,
      rateLimitConfidence: rateLimit.confidence,
    });

    const meta = {
      conversation_id: result.conversationId,
      status: result.status,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      num_turns: result.numTurns,
      tools_used: result.toolCalls,
      usage: result.usage,
      stderr: stderrSnippet,
    };
    const body =
      (result.response?.trim() || result.error || "(agy returned no text)") +
      "\n\n---\n" +
      "agy-bridge metadata: " +
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
