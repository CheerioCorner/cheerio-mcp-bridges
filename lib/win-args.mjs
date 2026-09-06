/**
 * Running a Windows `.cmd` / `.bat` shim WITHOUT `shell: true`.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `spawn(cmd, args, { shell: true })` does not quote `args` — it concatenates
 * them onto the command line with spaces and hands the result to cmd.exe. Node
 * says so itself (DEP0190). So a prompt like
 *
 *     Reply with exactly the two characters: ok
 *
 * reaches codex as SIX arguments, and codex answers
 * `unexpected argument 'with' found`. That is the entire reason codex-bridge
 * and copilot-bridge failed their smoke test on 2026-09-06 — nothing was
 * uninstalled and nobody was logged out.
 *
 * It is also an injection hole: a prompt containing `& del /q ...` would be
 * run by cmd.exe as a second command. The bridges pass user-authored prompts.
 *
 * The fix is to stop asking Node to build the command line. We build it
 * ourselves — the same two-layer escaping npm's own `cross-spawn` uses — and
 * spawn cmd.exe directly with `windowsVerbatimArguments`, so Node passes our
 * string through untouched.
 *
 * TWO PARSERS, TWO LAYERS
 *   1. The CHILD parses its command line with CommandLineToArgvW: an argument
 *      is wrapped in double quotes, an embedded quote becomes \", and any
 *      backslashes immediately before a quote (or at the very end) are doubled.
 *   2. cmd.exe sees the line FIRST and would eat `" ( ) % ! ^ < > & |` on the
 *      way past, so every one of those — including the quotes layer 1 just
 *      added — is prefixed with `^`.
 */

// Everything cmd.exe treats as special. The quotes from layer 1 are in here on
// purpose: cmd must pass them through literally for layer 2 to see them.
const CMD_METACHARACTERS = /[()%!^"<>&|]/g;

/**
 * Escape one argument so it survives cmd.exe and arrives at the child intact.
 * @param {string} arg
 * @returns {string}
 */
export function quoteForCmd(arg) {
  let s = String(arg);
  // Layer 1 — CommandLineToArgvW.
  s = s.replace(/(\\*)"/g, '$1$1\\"'); // double the backslashes running into a quote, escape the quote
  s = s.replace(/(\\*)$/, "$1$1"); // trailing backslashes would escape our closing quote
  s = `"${s}"`;
  // Layer 2 — cmd.exe.
  return s.replace(CMD_METACHARACTERS, "^$&");
}

/**
 * Build a `cmd.exe /d /s /c "..."` invocation for a .cmd/.bat shim.
 *
 * `/d` skips AutoRun registry commands, `/s` makes cmd strip exactly the outer
 * quote pair and leave the rest alone — which is what makes the `^` escaping
 * above predictable.
 *
 * @param {string} entry  Path to the .cmd/.bat file.
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.comspec]  Override cmd.exe's path (tests).
 * @returns {{command:string, args:string[], shell:false, windowsVerbatimArguments:true}}
 */
export function buildCmdInvocation(entry, args, { comspec } = {}) {
  const shell = comspec || process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const line = [entry, ...args].map(quoteForCmd).join(" ");
  return {
    command: shell,
    args: ["/d", "/s", "/c", `"${line}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
