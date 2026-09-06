/**
 * Testable handler factory for the Claude Code bridge.
 *
 * Separated from src/claude-bridge.mjs so that tests can import this module
 * without triggering the top-level requireEnv() calls in lib/claude.mjs.
 * All dependencies are explicit — no hidden imports.
 */

import { randomUUID } from "node:crypto";
import { availabilityKey } from "./availability.mjs";
import { claudeRateLimitFromEvent, detectRateLimit } from "./rate-limit.mjs";
import { buildResultBody, truncate } from "./result-text.mjs";

/**
 * Create a testable askClaude handler.
 *
 * @param {object} opts
 * @param {Function} opts.run              CLI runner (e.g. runClaude).
 * @param {Function} opts.audit            Audit logger.
 * @param {Function} opts.checkAvailability
 * @param {Function} opts.recordBlocked
 * @param {Function} opts.clearBlocked
 * @param {Function} opts.resetProbeClaimedUntil
 * @param {Function} [opts.newSessionId]   Injected for deterministic tests.
 * @returns {Function} askClaude handler
 */
export function createAskClaudeHandler({
  run,
  audit,
  checkAvailability,
  recordBlocked,
  clearBlocked,
  resetProbeClaimedUntil,
  newSessionId = randomUUID,
}) {
  return async function askClaude({
    prompt,
    session_id,
    read_only,
    allow_edits,
    dangerously_allow_all,
    model,
    effort,
    max_budget_usd,
    timeout_ms,
  }) {
    // Unlike codex/copilot we CAN mint the id ourselves: --session-id assigns a
    // caller-supplied UUID to a new session (verified against the real binary),
    // so the id we report is one Claude actually used — never a fabrication.
    const resumeSessionId = session_id || null;
    const newId = resumeSessionId ? null : newSessionId();
    const availabilityName = availabilityKey("claude", model);

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
      await audit("claude", {
        sessionId: resumeSessionId,
        prompt,
        read_only: !!read_only,
        model,
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
        sessionId: newId,
        resumeSessionId,
        readOnly: read_only,
        allowEdits: allow_edits,
        dangerouslyAllowAll: dangerously_allow_all,
        model,
        effort,
        maxBudgetUsd: max_budget_usd,
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
          recordedBy: "claude-bridge",
        });
      }
      await audit("claude", {
        sessionId: resumeSessionId || newId,
        prompt,
        read_only: !!read_only,
        model,
        availabilityName,
        availabilityProbe: probe,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch claude: ${err?.message || err}` }],
      };
    }

    // ── Rate-limit detection ───────────────────────────────────────────────
    // The structured `rate_limit_event` wins outright when it says we are
    // blocked: it carries an exact resetsAt, so no guessing and no text
    // matching. Only when it is silent do we fall back to the shared regex
    // detector the other four bridges use.
    const structured = claudeRateLimitFromEvent(result.rateLimitInfo);
    const rateLimit = structured.limited
      ? structured
      : detectRateLimit({
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
        recordedBy: "claude-bridge",
      });
    } else if (probe) {
      if (!result.hadError) {
        await clearBlocked(availabilityName);
      } else {
        await resetProbeClaimedUntil(availabilityName);
      }
    }

    const stderrSnippet = truncate(result.stderr);
    const deniedTools = [...new Set((result.permissionDenials || []).map((d) => d.tool_name))];

    await audit("claude", {
      sessionId: result.sessionId,
      prompt,
      read_only: !!read_only,
      allow_edits: !!allow_edits,
      dangerously_allow_all: !!dangerously_allow_all,
      model,
      effort,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      stderr: stderrSnippet,
      toolCalls: result.toolCalls,
      permissionDenials: result.permissionDenials,
      usage: result.usage,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      terminalReason: result.terminalReason,
      apiErrorStatus: result.apiErrorStatus,
      unparsedLines: result.unparsedLines,
      durationMs: result.durationMs,
      availabilityName,
      availabilityProbe: probe,
      rateLimited: rateLimit.limited,
      rateLimitConfidence: rateLimit.confidence,
      rateLimitSource: rateLimit.source,
      rateLimitStatus: result.rateLimitInfo?.status ?? null,
    });

    const meta = {
      session_id: result.sessionId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      tools_used: result.toolCalls.map((t) => t.name),
      permission_denials: deniedTools,
      num_turns: result.numTurns,
      stop_reason: result.stopReason,
      terminal_reason: result.terminalReason,
      api_error_status: result.apiErrorStatus,
      cost_usd: result.costUsd,
      usage: result.usage,
      rate_limit_status: result.rateLimitInfo?.status ?? null,
      stderr: stderrSnippet,
    };

    // A denied tool call is the quietest failure this CLI has: permission_denials
    // is populated, is_error stays false, and the exit code stays 0 — so the
    // caller reads a confident answer describing work that never happened.
    // Same disease as the outage; say it out loud.
    const denialNote = deniedTools.length
      ? `\n\n[claude-bridge] ${result.permissionDenials.length} tool call(s) were DENIED by the ` +
        `permission mode (${deniedTools.join(", ")}). The answer above may describe work that did ` +
        `not actually happen. Re-run with allow_edits:true if it should be allowed to act.`
      : "";

    const body = buildResultBody({
      cli: "claude",
      text: result.text ? result.text + denialNote : denialNote.trim(),
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      meta,
    });

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  };
}
