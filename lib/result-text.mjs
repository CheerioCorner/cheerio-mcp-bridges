/**
 * Turning a CLI run into the text an orchestrating agent actually sees.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The 2026-09-05 pi outage was invisible for ~3 hours not because the error
 * was missing, but because it was DISCARDED. spawnCapture() captured stderr,
 * the handler had it in `result.stderr`, and then built its reply as
 *
 *     (result.text || "(pi returned no text)")
 *
 * so the caller saw "pi returned no text" while the real cause
 * (ERR_MODULE_NOT_FOUND: @earendil-works/pi-server) sat unread in a variable.
 *
 * Rule encoded here: if the CLI produced no text AND the run failed, the
 * failure evidence goes into the reply. A silent failure is a bug.
 */

/** Max stderr characters surfaced in a reply / audit record. */
export const STDERR_SNIPPET_MAX = 2000;

/**
 * Truncate keeping the HEAD — a crash's first lines are the useful ones.
 *
 * @param {string|null|undefined} s
 * @param {number} [maxLen]
 * @returns {string|null}
 */
export function truncate(s, maxLen = STDERR_SNIPPET_MAX) {
  if (!s || s.length <= maxLen) return s || null;
  return s.slice(0, maxLen) + "... (truncated)";
}

/**
 * Did this run fail, as far as the OS is concerned?
 *
 * `exitCode === null` means the child was killed by a signal — a failure.
 * `undefined` means the runner never reported one, which is not evidence of
 * anything, so it is not treated as a failure on its own.
 *
 * @param {{exitCode?: number|null, timedOut?: boolean}} o
 * @returns {boolean}
 */
export function runFailed({ exitCode, timedOut }) {
  if (timedOut === true) return true;
  if (exitCode === undefined) return false;
  return exitCode !== 0;
}

/**
 * The human-visible part of a reply: the CLI's own answer when it produced
 * one, otherwise an explicit statement of how it failed plus its stderr.
 *
 * @param {object} o
 * @param {string} o.cli                "pi" | "agy" | "codex" | "copilot"
 * @param {string|null} [o.text]        The CLI's parsed answer, if any.
 * @param {string|null} [o.stderr]      Raw stderr (truncated here).
 * @param {number|null} [o.exitCode]
 * @param {boolean} [o.timedOut]
 * @returns {string}
 */
export function buildPrimaryText({ cli, text, stderr, exitCode, timedOut }) {
  const answer = typeof text === "string" ? text.trim() : "";
  if (answer) return answer;

  if (!runFailed({ exitCode, timedOut })) return `(${cli} returned no text)`;

  const why = timedOut
    ? "timed out"
    : exitCode === null
      ? "killed by signal"
      : `exit code ${exitCode}`;
  const snippet = truncate(stderr);
  if (!snippet) {
    return `(${cli} produced no output — ${why}; no stderr was captured either)`;
  }
  return `(${cli} produced no output — ${why})\n\n${cli} stderr:\n${snippet}`;
}

/**
 * Full reply body: primary text plus the one-line bridge metadata footer that
 * every bridge appends.
 *
 * @param {object} o  buildPrimaryText's options, plus:
 * @param {object} o.meta  Serialisable metadata object.
 * @returns {string}
 */
export function buildResultBody({ cli, text, stderr, exitCode, timedOut, meta }) {
  return (
    buildPrimaryText({ cli, text, stderr, exitCode, timedOut }) +
    "\n\n---\n" +
    `${cli}-bridge metadata: ` +
    JSON.stringify(meta)
  );
}
