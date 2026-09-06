/**
 * claude's flag names move between patch releases. 2.1.263 has
 * --permission-prompts; 2.1.258, five patches earlier, does not — and every
 * call on that machine died with `unknown option '--permission-prompts'`.
 *
 * These tests use real `claude --help` shapes, because the whole value of the
 * probe is that it reads what the binary actually prints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCapabilities, adaptClaudeArgs } from "../lib/claude-flags.mjs";

// Trimmed from real `claude --help` output (commander's layout).
const HELP_NEW = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow
  --output-format <format>              Output format (only works with --print)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" or "none"
                                        (choices: "host", "none", default:
                                        "host")
  -p, --print                           Print response and exit
  --restricted                          Restricted mode
  --safe-mode                           Start with all customizations disabled
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --verbose                             Override verbose mode
`;

const HELP_OLD = `Usage: claude [options] [command] [prompt]

Options:
  --output-format <format>              Output format (only works with --print)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits",
                                        "bypassPermissions", "default", "plan")
  -p, --print                           Print response and exit
  --restricted                          Restricted mode
  --safe-mode                           Start with all customizations disabled
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --verbose                             Override verbose mode
`;

const WANTED = [
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--safe-mode",
  "--permission-prompts",
  "none",
  "--permission-mode",
  "manual",
  "--",
  "what is 2+2?",
];

// ── parseClaudeCapabilities ──────────────────────────────────────────────────

test("reads the flags and the --permission-mode choices", () => {
  const caps = parseClaudeCapabilities(HELP_NEW);
  assert.ok(caps.flags.has("--permission-prompts"));
  assert.ok(caps.flags.has("--safe-mode"));
  assert.deepEqual([...caps.permissionModes].sort(), [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "manual",
    "plan",
  ]);
});

test("reads both names of an aliased option", () => {
  const caps = parseClaudeCapabilities(HELP_NEW);
  assert.ok(caps.flags.has("--allowedTools"));
  assert.ok(caps.flags.has("--allowed-tools"));
});

test("a flag only MENTIONED in a description is not treated as supported", () => {
  // HELP_OLD's --output-format description says "only works with --print",
  // and --print is real. But nothing there proves --mcp-config exists.
  const caps = parseClaudeCapabilities(HELP_OLD);
  assert.ok(caps.flags.has("--print"));
  assert.ok(!caps.flags.has("--mcp-config"), "descriptions are prose, not evidence");
  assert.ok(!caps.flags.has("--permission-prompts"));
});

test("garbage in gives an empty capability set, which callers read as 'do not adapt'", () => {
  assert.equal(parseClaudeCapabilities("").flags.size, 0);
  assert.equal(parseClaudeCapabilities(null).flags.size, 0);
});

// ── adaptClaudeArgs ──────────────────────────────────────────────────────────

test("a current build gets its argv back untouched", () => {
  const { args, warnings } = adaptClaudeArgs(WANTED, parseClaudeCapabilities(HELP_NEW));
  assert.deepEqual(args, WANTED);
  assert.deepEqual(warnings, []);
});

test("an older build loses the flag it cannot parse — and says so", () => {
  const { args, warnings } = adaptClaudeArgs(WANTED, parseClaudeCapabilities(HELP_OLD));
  assert.ok(!args.includes("--permission-prompts"));
  assert.ok(!args.includes("none"), "the flag's VALUE must go with it");
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => w.length > 0), "a dropped permission flag must never be silent");
});

test("an unavailable --permission-mode is replaced, not dropped", () => {
  const { args } = adaptClaudeArgs(WANTED, parseClaudeCapabilities(HELP_OLD));
  const i = args.indexOf("--permission-mode");
  assert.notEqual(i, -1, "dropping the mode entirely would silently loosen permissions");
  assert.equal(args[i + 1], "default", "the closest thing an old build has to 'deny anything that prompts'");
});

test("the prompt is never touched, even when it looks like a flag", () => {
  const wanted = [...WANTED.slice(0, -1), "--permission-prompts is not a real question"];
  const { args } = adaptClaudeArgs(wanted, parseClaudeCapabilities(HELP_OLD));
  assert.equal(args.at(-1), "--permission-prompts is not a real question");
  assert.equal(args.at(-2), "--");
});

test("no capabilities means no changes — 'could not ask' is not 'unsupported'", () => {
  for (const caps of [null, undefined, { flags: new Set(), permissionModes: new Set() }]) {
    const { args, warnings } = adaptClaudeArgs(WANTED, caps);
    assert.deepEqual(args, WANTED);
    assert.deepEqual(warnings, []);
  }
});
