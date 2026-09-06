import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInvocation,
  buildSmokeInvocation,
  pickBin,
  resolveEntry,
  SMOKE_PROMPT,
} from "../lib/cli-entry.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// The real shape of pi 0.85.0's package.json: TWO cli.js files exist on disk,
// and only the one named by "bin" has its dependencies bundled.
const PI_PKG = {
  name: "@earendil-works/pi-coding-agent",
  bin: { pi: "dist/bundle/cli.js" },
};

function stubs(overrides = {}) {
  return {
    env: {},
    readPackageJson: async () => null,
    localResolve: async () => null,
    npmGlobalRoot: async () => null,
    which: async () => null,
    ...overrides,
  };
}

// ── pickBin ──────────────────────────────────────────────────────────────────

test("pickBin: reads a name->path bin map", () => {
  assert.equal(pickBin(PI_PKG, "pi"), "dist/bundle/cli.js");
});

test("pickBin: reads a bare string bin", () => {
  assert.equal(pickBin({ bin: "cli.js" }, "whatever"), "cli.js");
});

test("pickBin: returns null when there is no bin, or no such name", () => {
  assert.equal(pickBin({}, "pi"), null);
  assert.equal(pickBin(null, "pi"), null);
  assert.equal(pickBin({ bin: { other: "x.js" } }, "pi"), null);
});

// ── resolveEntry ─────────────────────────────────────────────────────────────

test("resolveEntry: an explicit env var wins over everything else", async () => {
  const r = await resolveEntry({
    envVar: "PI_BRIDGE_ENTRY",
    npmPackage: "@earendil-works/pi-coding-agent",
    binName: "pi",
    ...stubs({
      env: { PI_BRIDGE_ENTRY: "D:/custom/cli.js" },
      npmGlobalRoot: async () => "/global",
      readPackageJson: async () => PI_PKG,
      which: async () => "/usr/bin/pi",
    }),
  });
  assert.equal(r.path, "D:/custom/cli.js");
  assert.equal(r.source, "env");
});

test("resolveEntry: falls back to the package's own bin field (the 2026-09-05 fix)", async () => {
  const r = await resolveEntry({
    envVar: "PI_BRIDGE_ENTRY",
    npmPackage: "@earendil-works/pi-coding-agent",
    binName: "pi",
    ...stubs({
      npmGlobalRoot: async () => "/global/node_modules",
      readPackageJson: async (dir) => {
        assert.match(dir, /pi-coding-agent$/);
        return PI_PKG;
      },
    }),
  });
  assert.equal(r.source, "package-bin");
  // The whole point: bundle/, never the unbundled dist/cli.js.
  assert.match(r.path.replace(/\\/g, "/"), /pi-coding-agent\/dist\/bundle\/cli\.js$/);
});

test("resolveEntry: prefers a local package resolution over the global root", async () => {
  const r = await resolveEntry({
    envVar: "PI_BRIDGE_ENTRY",
    npmPackage: "@earendil-works/pi-coding-agent",
    binName: "pi",
    ...stubs({
      localResolve: async () => "/repo/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: async () => "/global/node_modules",
      readPackageJson: async (dir) => (dir.includes("/repo/") ? PI_PKG : null),
    }),
  });
  assert.match(r.path.replace(/\\/g, "/"), /^\/repo\/node_modules\/.*\/dist\/bundle\/cli\.js$/);
});

test("resolveEntry: falls through to PATH when the package has no usable bin", async () => {
  const r = await resolveEntry({
    envVar: "AGY_BRIDGE_ENTRY",
    binName: "agy",
    ...stubs({ which: async (cmd) => (cmd === "agy" ? "C:/tools/agy.exe" : null) }),
  });
  assert.equal(r.path, "C:/tools/agy.exe");
  assert.equal(r.source, "path");
});

test("resolveEntry: never guesses — returns null plus what it tried", async () => {
  const r = await resolveEntry({
    envVar: "PI_BRIDGE_ENTRY",
    npmPackage: "@earendil-works/pi-coding-agent",
    binName: "pi",
    ...stubs(),
  });
  assert.equal(r.path, null);
  assert.equal(r.source, null);
  assert.equal(r.tried.length, 3);
  assert.ok(r.tried[0].includes("PI_BRIDGE_ENTRY"));
  // Regression guard for the hardcoded "C:/Users/User/..." fallback this replaced.
  assert.ok(!JSON.stringify(r).includes("C:/Users"));
});

// ── buildInvocation ──────────────────────────────────────────────────────────

test("buildInvocation: a .js entry runs through the node binary", () => {
  const inv = buildInvocation("C:/npm/pi/dist/bundle/cli.js", ["--version"], { execPath: "/usr/bin/node" });
  assert.deepEqual(inv, {
    command: "/usr/bin/node",
    args: ["C:/npm/pi/dist/bundle/cli.js", "--version"],
    shell: false,
  });
});

test("buildInvocation: .mjs and .cjs are scripts too", () => {
  for (const ext of ["mjs", "cjs"]) {
    const inv = buildInvocation(`/x/cli.${ext}`, [], { execPath: "/node" });
    assert.equal(inv.command, "/node");
  }
});

test("buildInvocation: a .cmd shim goes through cmd.exe, never through shell:true", () => {
  const inv = buildInvocation("C:\\Users\\x\\npm\\copilot.cmd", ["--version"], { comspec: "cmd.exe" });
  assert.equal(inv.shell, false, "shell:true is what broke codex and copilot on 2026-09-06");
  assert.equal(inv.command, "cmd.exe");
  assert.equal(inv.windowsVerbatimArguments, true);
  assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(inv.args[3], /copilot\.cmd/);
  assert.match(inv.args[3], /--version/);
});

test("buildInvocation: a multi-word prompt survives as ONE argument", () => {
  // The regression itself: `shell: true` handed codex six arguments and it
  // answered `unexpected argument 'with' found`.
  const inv = buildInvocation("C:/npm/codex.cmd", ["exec", SMOKE_PROMPT], { comspec: "cmd.exe" });
  const line = inv.args[3];
  const quoted = line.match(/\^"[^^]*(?:\^"|$)/g) || [];
  assert.ok(
    line.includes("Reply with exactly the two characters: ok"),
    "the prompt text must still be there, intact"
  );
  assert.ok(quoted.length >= 3, "entry + each argument is quoted separately");
});

test("buildInvocation: shell metacharacters in a prompt cannot become a second command", () => {
  const inv = buildInvocation("C:/npm/codex.cmd", ["exec", "hello & del /q C:\\x"], {
    comspec: "cmd.exe",
  });
  // An unescaped & would end the codex command and start a del. Escaped, cmd
  // passes it to codex as text.
  assert.ok(inv.args[3].includes("^&"), "& must be neutralised for cmd.exe");
  assert.ok(!/[^^]&/.test(inv.args[3]), "no bare & may reach cmd.exe");
});

test("buildInvocation: a plain executable is run directly", () => {
  const inv = buildInvocation("C:/tools/agy.exe", ["--version"]);
  assert.deepEqual(inv, { command: "C:/tools/agy.exe", args: ["--version"], shell: false });
});

// ── buildSmokeInvocation ─────────────────────────────────────────────────────

test("buildSmokeInvocation: every CLI sends the prompt through its own headless flags", () => {
  const pi = buildSmokeInvocation("pi", "/x/cli.js");
  assert.ok(pi.args.includes(SMOKE_PROMPT));
  assert.ok(pi.args.includes("--no-extensions"), "extensions hang a headless run");
  assert.deepEqual(pi.args.slice(0, 3), ["/x/cli.js", "--mode", "json"]);

  const agy = buildSmokeInvocation("agy", "/x/agy.exe");
  assert.ok(agy.args.includes("--output-format") && agy.args.includes("stream-json"));
  assert.ok(agy.args.includes(SMOKE_PROMPT));

  const codex = buildSmokeInvocation("codex", "/x/codex.exe");
  assert.deepEqual(codex.args.slice(0, 4), ["exec", "--json", "--skip-git-repo-check", SMOKE_PROMPT]);

  const copilot = buildSmokeInvocation("copilot", "/x/copilot.cmd");
  assert.equal(copilot.shell, false);
  assert.ok(copilot.args[3].includes("--allow-all-tools"));
  assert.ok(copilot.args[3].includes(SMOKE_PROMPT), "the prompt must reach copilot as text");
});

// ── buildSmokeInvocation: claude's moving flag names ─────────────────────────

test("buildSmokeInvocation: without caps, claude gets the newest flag set unchanged", () => {
  const inv = buildSmokeInvocation("claude", "/x/claude.exe");
  assert.ok(inv.args.includes("--permission-prompts"));
  assert.deepEqual(inv.droppedFlags, []);
  assert.equal(inv.args.at(-1), SMOKE_PROMPT);
  assert.equal(inv.args.at(-2), "--", "the prompt is positional and must sit behind a bare --");
});

test("buildSmokeInvocation: a claude build without --permission-prompts still gets a runnable argv", () => {
  // 2.1.258. The old doctor called this machine broken and told the user to
  // go log in.
  const caps = {
    flags: new Set([
      "--print",
      "--output-format",
      "--safe-mode",
      "--strict-mcp-config",
      "--permission-mode",
      "--restricted",
    ]),
    permissionModes: new Set(["acceptEdits", "bypassPermissions", "default", "plan"]),
  };
  const inv = buildSmokeInvocation("claude", "/x/claude.exe", { caps });

  assert.ok(!inv.args.includes("--permission-prompts"));
  assert.ok(!inv.args.includes("none"));
  assert.ok(!inv.args.includes("manual"), "a mode this build rejects must be replaced");
  assert.deepEqual(
    inv.args.slice(inv.args.indexOf("--permission-mode"), inv.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "default"]
  );
  assert.equal(inv.args.at(-1), SMOKE_PROMPT);
  // Silent degradation is the failure mode this repo exists to avoid.
  assert.equal(inv.droppedFlags.length, 2);
  assert.ok(inv.droppedFlags.some((w) => w.includes("--permission-prompts")));
});

test("buildSmokeInvocation: the prompt is short and asks for a tiny answer", () => {
  assert.ok(SMOKE_PROMPT.length < 80);
  assert.match(SMOKE_PROMPT, /ok/);
});

test("buildSmokeInvocation: an unknown CLI is a loud error, not a silent no-op", () => {
  assert.throws(() => buildSmokeInvocation("nope", "/x"), /No smoke invocation/);
});
