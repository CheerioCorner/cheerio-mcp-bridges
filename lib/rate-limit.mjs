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
  /429/,
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
 * @param {boolean} [params.hadError] Whether the CLI reported an error event.
 * @returns {{ limited: boolean, confidence: string|null, reason: string|null,
 *             blockedUntil: string|null, retryAfterSeconds: number|null, source: string|null }}
 */
export function detectRateLimit({ stdout = "", stderr = "", text = "", error = "", exitCode = 0, hadError = false } = {}) {
  const result = {
    limited: false,
    confidence: null,
    reason: null,
    blockedUntil: null,
    retryAfterSeconds: null,
    source: null,
  };

  // Gate: only scan when the CLI actually reported an error.
  if (!hadError && exitCode === 0) {
    return result;
  }

  // Scan sources in priority order.
  const sources = [
    { label: "error", content: error },
    { label: "stderr", content: stderr },
    { label: "text", content: text },
    { label: "stdout", content: stdout },
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
