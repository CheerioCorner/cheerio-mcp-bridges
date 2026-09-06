/**
 * The 2026-09-06 regression, at the level it actually happened.
 *
 * `spawn(cmd, args, { shell: true })` concatenates argv onto a command line
 * without quoting it. codex and copilot are reached through .cmd shims, so
 * they got the smoke prompt as six arguments and reported an argument error
 * that reads exactly like a broken install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteForCmd, buildCmdInvocation } from "../lib/win-args.mjs";

// A tiny model of what cmd.exe does to a `/d /s /c "<line>"` string: strip the
// outer quote pair, then consume every ^ as "the next character is literal".
function cmdUnescape(line) {
  let s = line;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "^" && i + 1 < s.length) out += s[++i];
    else out += s[i];
  }
  return out;
}

// A tiny model of CommandLineToArgvW, the parser the CHILD uses.
function argvParse(line) {
  const args = [];
  let cur = "";
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') { cur += "\\".repeat(n >> 1); if (n % 2) { cur += '"'; } else { inQuotes = !inQuotes; } started = true; }
      else { cur += "\\".repeat(n); i--; }
      continue;
    }
    if (c === '"') { inQuotes = !inQuotes; started = true; continue; }
    if (c === " " && !inQuotes) { if (started || cur) { args.push(cur); cur = ""; started = false; } continue; }
    cur += c;
    started = true;
  }
  if (started || cur) args.push(cur);
  return args;
}

/** Full round trip: what the child process actually receives. */
function roundTrip(entry, args) {
  const inv = buildCmdInvocation(entry, args, { comspec: "cmd.exe" });
  return argvParse(cmdUnescape(inv.args[3]));
}

test("the smoke prompt arrives as ONE argument, not six", () => {
  const prompt = "Reply with exactly the two characters: ok";
  assert.deepEqual(roundTrip("C:\\npm\\codex.cmd", ["exec", "--json", prompt]), [
    "C:\\npm\\codex.cmd",
    "exec",
    "--json",
    prompt,
  ]);
});

test("a path with spaces stays one argument", () => {
  const [entry] = roundTrip("C:\\Program Files\\npm\\copilot.cmd", []);
  assert.equal(entry, "C:\\Program Files\\npm\\copilot.cmd");
});

test("cmd metacharacters in a prompt are neutralised, not executed", () => {
  for (const evil of ["a & del x", "a | more", "a > out.txt", "a ^ b", "50%% done", "(paren)", "bang!"]) {
    assert.deepEqual(roundTrip("C:/x.cmd", ["-p", evil]).at(-1), evil, `mangled: ${evil}`);
  }
});

test("quotes and trailing backslashes survive both parsers", () => {
  for (const tricky of ['say "hi"', "C:\\dir\\", 'trailing\\\\', '"leading', 'mid"dle']) {
    assert.deepEqual(roundTrip("C:/x.cmd", [tricky]).at(-1), tricky, `mangled: ${tricky}`);
  }
});

test("no caller is asked to opt into a shell", () => {
  const inv = buildCmdInvocation("C:/x.cmd", ["a"], { comspec: "cmd.exe" });
  assert.equal(inv.shell, false);
  assert.equal(inv.windowsVerbatimArguments, true, "Node must not re-quote what we already escaped");
  assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
});

test("quoteForCmd leaves no metacharacter for cmd.exe to act on", () => {
  const q = quoteForCmd("a&b|c>d<e(f)g^h%i!j\"k");
  // Walk it the way cmd does: ^ swallows the next character. Anything special
  // still standing after that walk would be interpreted, not passed along.
  for (let i = 0; i < q.length; i++) {
    if (q[i] === "^") { i++; continue; }
    assert.ok(!"&|<>()%!^".includes(q[i]), `unescaped ${q[i]} at ${i} in: ${q}`);
  }
});
