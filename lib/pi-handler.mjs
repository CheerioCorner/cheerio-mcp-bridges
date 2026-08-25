/**
 * Testable handler factory for the pi bridge.
 *
 * Separated from src/pi-bridge.mjs so that tests can import this module
 * without triggering the top-level requireEnv() calls in lib/pi.mjs.
 * All dependencies are explicit — no hidden imports.
 */

import { randomUUID } from "node:crypto";
import { availabilityKey } from "./availability.mjs";
import { detectRateLimit } from "./rate-limit.mjs";

/**
 * Create a testable askPi handler.
 *
 * @param {object} opts
 * @param {Function} opts.run              CLI runner (e.g. runPi).
 * @param {Function} opts.audit            Audit logger (e.g. appendAudit).
 * @param {Function} opts.checkAvailability  Availability checker.
 * @param {Function} opts.recordBlocked    Block recorder.
 * @param {Function} opts.clearBlocked     Block clearer.
 * @returns {Function} askPi handler
 */
export function createAskPiHandler({
  run,
  audit,
  checkAvailability,
  recordBlocked,
  clearBlocked,
  resetProbeClaimedUntil,
}) {
  return async function askPi({ prompt, session_id, read_only, model, approve_project, enable_extensions, timeout_ms }) {
    const sessionId = session_id || randomUUID();
    const availabilityName = availabilityKey("pi", model);

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
      await audit("pi", {
        sessionId,
        prompt,
        read_only: !!read_only,
        model,
        approve_project: !!approve_project,
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
        sessionId,
        readOnly: read_only,
        model,
        approveProject: approve_project,
        enableExtensions: enable_extensions,
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
          recordedBy: "pi-bridge",
        });
      }
      await audit("pi", {
        sessionId,
        prompt,
        read_only: !!read_only,
        model,
        approve_project: !!approve_project,
        availabilityName,
        availabilityProbe: probe,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch pi: ${err?.message || err}` }],
      };
    }

    // ── Post-flight rate-limit detection ───────────────────────────────────
    // Pi may wrap provider errors in assistant text or JSON session events,
    // so we scan both text and stderr.
    //
    // result.hadError is forced true whenever result.timedOut is true (see
    // runPi), so it conflates "the CLI reported an error" with "we killed it
    // after our own timeout". Only the former is real evidence of anything —
    // a bare timeout is not a rate-limit report (W-2026-08-086). Un-fold it
    // here: hadError passed to detectRateLimit means "confirmed CLI error",
    // timedOut is passed separately so it can restrict scan breadth instead.
    const rateLimit = detectRateLimit({
      stdout: result.stdout,
      stderr: result.stderr,
      text: result.text,
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
        recordedBy: "pi-bridge",
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

    await audit("pi", {
      sessionId: result.sessionId,
      prompt,
      read_only: !!read_only,
      model,
      approve_project: !!approve_project,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      toolCalls: result.toolCalls,
      usage: result.usage,
      durationMs: result.durationMs,
      availabilityName,
      availabilityProbe: probe,
      rateLimited: rateLimit.limited,
      rateLimitConfidence: rateLimit.confidence,
    });

    const meta = {
      session_id: result.sessionId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      tools_used: result.toolCalls.map((t) => t.name),
      usage: result.usage,
    };
    const body =
      (result.text || "(pi returned no text)") +
      "\n\n---\n" +
      "pi-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  };
}
