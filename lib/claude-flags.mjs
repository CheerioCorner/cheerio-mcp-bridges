/**
 * What THIS machine's `claude` actually understands.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * lib/claude.mjs's flags were verified against @anthropic-ai/claude-code
 * 2.1.263. On 2026-09-06 a machine running 2.1.258 failed every claude call
 * with `unknown option '--permission-prompts'` — five patch releases apart was
 * enough. A CLI we do not ship is a moving target: pinning our argv to one
 * version of it guarantees this recurs.
 *
 * So we ask the binary. `--help` costs nothing (no API credits, no login) and
 * lists both the flags and, for a few of them, the allowed values. Anything it
 * does not list, we drop — LOUDLY, with a warning the caller must surface,
 * because silently dropping `--permission-prompts none` would quietly change
 * the permission posture of a headless run.
 *
 * Detection failing is not the same as a flag being absent: when the probe
 * itself fails we return null, and `adaptClaudeArgs` then changes nothing.
 */

/** Flags we emit that consume the NEXT argv element. */
const VALUE_FLAGS = new Set([
  "--output-format",
  "--resume",
  "--session-id",
  "--permission-prompts",
  "--permission-mode",
  "--model",
  "--effort",
  "--max-budget-usd",
]);

/**
 * Preference order for --permission-mode when the mode we asked for is not in
 * this version's choices. Ordered by how close each one is to "read freely,
 * deny anything that would prompt": older builds have no `manual`/`dontAsk`,
 * and there `default` is the match — headless, a prompt it cannot show is a
 * denial. `plan` sits below it because it changes what the model DOES, not
 * just what it is allowed to do.
 */
const PERMISSION_MODE_FALLBACKS = ["manual", "dontAsk", "default", "plan", "acceptEdits"];

/**
 * Parse `claude --help` into the capabilities we care about.
 *
 * Only the flag names at the START of an option line count. Flags mentioned
 * inside a description ("only works with --print") are not evidence that the
 * flag exists — commander happily describes flags from other modes.
 *
 * @param {string} helpText  stdout (+stderr) of `claude --help`.
 * @returns {{flags: Set<string>, permissionModes: Set<string>}}
 */
export function parseClaudeCapabilities(helpText) {
  const flags = new Set();
  const permissionModes = new Set();

  for (const rawLine of String(helpText || "").split(/\r?\n/)) {
    // An option line: 2-6 spaces of indent, then a dash. Descriptions are
    // indented much further, and wrapped continuation lines never start with -.
    const m = /^ {2,6}(-[^\s].*)$/.exec(rawLine);
    if (!m) continue;
    // The flag cluster ends at the first placeholder or the 2+ spaces before
    // the description: "  --plugin-dir <path>   Load a plugin..."
    const cluster = m[1].split(/\s{2,}|\s[<[]/)[0];
    for (const token of cluster.split(/,\s*/)) {
      const f = token.trim();
      if (f.startsWith("--")) flags.add(f);
    }
  }

  // choices: "acceptEdits", "auto", "bypassPermissions", "manual", ...
  const pm = /--permission-mode[\s\S]{0,600}?choices:([^)]*)\)/.exec(String(helpText || ""));
  if (pm) for (const c of pm[1].matchAll(/"([^"]+)"/g)) permissionModes.add(c[1]);

  return { flags, permissionModes };
}

/**
 * Drop or substitute the parts of an argv this claude build cannot parse.
 *
 * @param {string[]} args  argv from buildClaudeArgs.
 * @param {{flags: Set<string>, permissionModes: Set<string>}|null} caps
 * @returns {{args: string[], warnings: string[]}}
 */
export function adaptClaudeArgs(args, caps) {
  const warnings = [];
  if (!caps || !caps.flags || caps.flags.size === 0) return { args: [...args], warnings };

  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    // Everything after a bare `--` is the prompt. Never touch it.
    if (a === "--") {
      out.push(...args.slice(i));
      break;
    }

    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }

    const takesValue = VALUE_FLAGS.has(a);
    const value = takesValue ? args[i + 1] : undefined;

    if (!caps.flags.has(a)) {
      warnings.push(`這個版本的 claude 不認得 ${a}${takesValue ? ` ${value}` : ""}，已略過`);
      if (takesValue) i++;
      continue;
    }

    if (a === "--permission-mode" && caps.permissionModes.size > 0 && !caps.permissionModes.has(value)) {
      const replacement = PERMISSION_MODE_FALLBACKS.find((m) => caps.permissionModes.has(m));
      if (replacement) {
        warnings.push(`這個版本的 claude 沒有 --permission-mode ${value}，改用 ${replacement}`);
        out.push(a, replacement);
      } else {
        warnings.push(`這個版本的 claude 的 --permission-mode 沒有任何我們認得的模式（可用：${[...caps.permissionModes].join(", ")}），已略過`);
      }
      i++;
      continue;
    }

    out.push(a);
    if (takesValue) {
      out.push(value);
      i++;
    }
  }

  return { args: out, warnings };
}
