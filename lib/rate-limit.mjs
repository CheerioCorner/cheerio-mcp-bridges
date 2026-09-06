/**
 * Rate-limit detection for CLI output.
 *
 * Only fires when the CLI itself reported an error (hadError / exitCode !== 0).
 * If the CLI succeeded, we never flag rate-limiting even if the response text
 * coincidentally contains the word "rate limit" (e.g. user asked Codex to
 * write an essay about rate limiting).
 */

// ── Pattern list ────────────────────────────────────────────────────────────
// Generic HTTP/LLM-API rate-limit vocabulary (429, "quota exceeded", "retry-after", ...),
// not yet cross-checked against a corpus of real pi/agy/codex/copilot error output.
// If a CLI's actual wording doesn't match, its rate-limit hits just won't get
// auto-recorded (no worse than pre-W-072 behavior) — tighten these as real
// unrecognized error text turns up in logs/.

export const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /rate[\s_-]?limited/i,
  /too many requests/i,
  /quota\s+(exceeded|depleted|exhausted)/i,
  /usage\s+(limit|exceeded|exhausted)/i,
  /credits?\s+(exceeded|depleted|exhausted)/i,
  /limit\s+reached/i,
  /resource[\s_-]?exhausted/i,
  // Word-bounded: bare `/429/` would also match the digits "429" anywhere
  // they happen to appear inside a larger number — a token count of 14293,
  // a millisecond timestamp, a tool-call id, etc. — which is exactly what
  // caused normal NDJSON stream content (thinking_end / tool_call / read
  // output) to be misread as a rate-limit report (W-2026-08-086).
  /\b429\b/,
  /retry[- ]after/i,
  /try\s+again\s+(in|after)/i,
  /(?:x-ratelimit-reset|reset(?:s)?)[^0-9]{0,20}\d{10}/i,
];

// ── Time extraction patterns (ordered by priority) ──────────────────────────

const TIME_PATTERNS = [
  // HTTP retry-after seconds: "Retry-After: 3600" or "retry-after: 3600 seconds"
  {
    regex: /\bretry[- ]after\s*:?\s*(\d+)\s*(seconds?|secs?)?\b/i,
    unit: "seconds",
  },
  // "try/retry again in N seconds"
  {
    regex: /\b(?:try|retry)\s+(?:again\s+)?(?:in|after)\s+(\d+)\s*seconds?\b/i,
    unit: "seconds",
  },
  // Minutes: "retry again in 15 minutes" / "try again in 5 minutes"
  {
    regex: /\b(?:try|retry)\s+(?:again\s+)?(?:in|after)\s+(\d+)\s*minutes?\b/i,
    unit: "minutes",
  },
  // Hours: "retry again in 2 hours"
  {
    regex: /\b(?:try|retry)\s+(?:again\s+)?(?:in|after)\s+(\d+)\s*hours?\b/i,
    unit: "hours",
  },
  // Unix reset timestamp (10-digit): "resets at 1763802000"
  {
    regex: /(?:reset|resets|x-ratelimit-reset)[^0-9]{0,20}(\d{10})\b/i,
    unit: "unix",
  },
];

/**
 * Detect rate limiting in CLI output.
 *
 * @param {object} params
 * @param {string}  [params.stdout]   Stdout capture.
 * @param {string}  [params.stderr]   Stderr capture.
 * @param {string}  [params.text]     Parsed response text (e.g. Codex NDJSON text).
 * @param {string}  [params.error]    Structured error field from CLI.
 * @param {number}  [params.exitCode] Process exit code.
 * @param {boolean} [params.hadError] Whether the CLI itself reported an error
 *                                    (a real signal — a failed tool call, a
 *                                    non-zero exit NOT caused by our own
 *                                    timeout kill, an explicit error event).
 *                                    Callers must NOT fold a bare timeout
 *                                    into this flag; pass that via `timedOut`.
 * @param {boolean} [params.timedOut] Whether OUR OWN timeout killed the
 *                                    process. This is not, by itself, evidence
 *                                    of rate limiting — it just means the CLI
 *                                    hadn't finished within our budget (it may
 *                                    have been doing perfectly normal, slow
 *                                    work). See scan-breadth note below.
 * @returns {{ limited: boolean, confidence: string|null, reason: string|null,
 *             blockedUntil: string|null, retryAfterSeconds: number|null, source: string|null }}
 */
export function detectRateLimit({
  stdout = "",
  stderr = "",
  text = "",
  error = "",
  exitCode = 0,
  hadError = false,
  timedOut = false,
} = {}) {
  const result = {
    limited: false,
    confidence: null,
    reason: null,
    blockedUntil: null,
    retryAfterSeconds: null,
    source: null,
  };

  // Gate: only look at anything when the CLI reported an error, or our own
  // timeout killed it. A clean, on-time success never scans.
  if (!hadError && !timedOut && exitCode === 0) {
    return result;
  }

  // Scan breadth depends on WHY we're looking:
  //
  // - hadError (a genuine CLI-reported error): scan everything, including
  //   stdout/text, as before — this is a small, bounded, actually-erroring
  //   payload, and callers do want us to catch e.g. a rate-limit message
  //   embedded in the response text.
  //
  // - timedOut only (no confirmed error): stdout/text at this point is
  //   whatever NDJSON happened to accumulate before we killed the process —
  //   potentially megabytes of completely ordinary streaming content (tool
  //   calls, thinking deltas, token usage counters, ids...). Scanning that
  //   blob with loose keyword patterns is how W-2026-08-086 kept happening:
  //   a normal `thinking_end` event, a `toolcall_start` notification, or a
  //   file-read result got misread as a rate-limit report purely because a
  //   number embedded in it (a token count, an id, a timestamp) happened to
  //   contain a matching substring. A genuine provider/CLI rate-limit signal
  //   is expected to surface on stderr or in a structured error field, not
  //   buried inside otherwise-normal stdout — so on a bare timeout we only
  //   look there.
  const scanBroad = hadError;
  const sources = [
    { label: "error", content: error },
    { label: "stderr", content: stderr },
    ...(scanBroad
      ? [
          { label: "text", content: text },
          { label: "stdout", content: stdout },
        ]
      : []),
  ];

  for (const { label, content } of sources) {
    if (!content) continue;
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(content)) {
        result.limited = true;
        result.source = label;
        result.reason = extractReason(content, pattern);
        break; // found the source, now extract time from ALL sources
      }
    }
    if (result.limited) break;
  }

  if (result.limited) {
    // Scan ALL sources for time information (not just the matched source).
    const combined = sources.map((s) => s.content).filter(Boolean).join("\n");
    const time = extractTime(combined);
    if (time) {
      result.confidence = "exact";
      result.blockedUntil = time.blockedUntil;
      result.retryAfterSeconds = time.retryAfterSeconds;
    } else {
      result.confidence = "estimated";
      result.blockedUntil = null;
      result.retryAfterSeconds = null;
    }
    // Detected only during a bare timeout, with no confirmed CLI-reported
    // error — flag this distinctly in the reason so a state entry never
    // looks indistinguishable from a genuine, confirmed rate-limit report.
    if (!hadError && timedOut) {
      result.reason = `[timeout, unconfirmed] ${result.reason}`;
    }
    return result;
  }

  return result;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function extractReason(content, matchedPattern) {
  // Grab the first line that contains the match.
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (matchedPattern.test(line)) {
      return line.trim().slice(0, 500);
    }
  }
  return content.split(/\r?\n/)[0]?.trim().slice(0, 500) || "rate limit detected";
}

function extractTime(content) {
  const now = Date.now();

  for (const { regex, unit } of TIME_PATTERNS) {
    const m = content.match(regex);
    if (!m) continue;

    const value = parseInt(m[1], 10);
    if (isNaN(value) || value <= 0) continue;

    let retryAfterSeconds;
    let blockedUntil;

    switch (unit) {
      case "seconds":
        retryAfterSeconds = value;
        blockedUntil = new Date(now + value * 1000).toISOString();
        break;
      case "minutes":
        retryAfterSeconds = value * 60;
        blockedUntil = new Date(now + value * 60_000).toISOString();
        break;
      case "hours":
        retryAfterSeconds = value * 3600;
        blockedUntil = new Date(now + value * 3_600_000).toISOString();
        break;
      case "unix": {
        // 10-digit Unix timestamp — interpret as seconds since epoch.
        const resetMs = value * 1000;
        if (resetMs > now) {
          retryAfterSeconds = Math.floor((resetMs - now) / 1000);
          blockedUntil = new Date(resetMs).toISOString();
        }
        // If already in the past, skip this pattern.
        break;
      }
    }

    if (blockedUntil) {
      return { blockedUntil, retryAfterSeconds };
    }
  }

  return null;
}

// ── Claude Code: a structured signal instead of a regex ──────────────────────

/**
 * Statuses in `rate_limit_event.rate_limit_info.status` that mean "this account
 * is currently blocked". Deliberately an ALLOW-list of rejections rather than
 * "anything that isn't allowed": a real event carries BOTH
 * `status: "allowed"` and `overageStatus: "rejected"` at the same time, and a
 * loose match on "rejected" would lock out a perfectly healthy account. That is
 * the W-2026-08-086 failure mode; see test/claude.test.mjs.
 */
export const CLAUDE_RATE_LIMIT_BLOCKED_STATUSES = ["rejected", "blocked", "exceeded"];

/**
 * Turn a `rate_limit_event` into the shape recordBlocked() wants.
 *
 * This is the only bridge with a STRUCTURED rate-limit signal — the other four
 * regex-match error text. `resetsAt` is an exact Unix timestamp, so the block
 * can be recorded with confidence "exact" instead of a guessed one-hour window.
 *
 * @param {object|null} info   rate_limit_info from the event.
 * @param {number} [nowMs]
 * @returns {{limited:boolean, confidence:string|null, reason:string|null,
 *            blockedUntil:string|null, retryAfterSeconds:number|null, source:string|null}}
 */
export function claudeRateLimitFromEvent(info, nowMs = Date.now()) {
  const none = {
    limited: false,
    confidence: null,
    reason: null,
    blockedUntil: null,
    retryAfterSeconds: null,
    source: null,
  };
  if (!info || typeof info.status !== "string") return none;
  if (!CLAUDE_RATE_LIMIT_BLOCKED_STATUSES.includes(info.status)) return none;

  const resetsAtMs = Number(info.resetsAt) * 1000;
  const hasReset = Number.isFinite(resetsAtMs) && resetsAtMs > nowMs;
  return {
    limited: true,
    confidence: hasReset ? "exact" : "estimated",
    reason: `claude rate_limit_event: status=${info.status}${
      info.rateLimitType ? ` type=${info.rateLimitType}` : ""
    }`,
    blockedUntil: hasReset ? new Date(resetsAtMs).toISOString() : null,
    retryAfterSeconds: hasReset ? Math.floor((resetsAtMs - nowMs) / 1000) : null,
    source: "rate_limit_event",
  };
}
