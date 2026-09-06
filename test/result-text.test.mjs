import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrimaryText,
  buildResultBody,
  runFailed,
  STDERR_SNIPPET_MAX,
  truncate,
} from "../lib/result-text.mjs";

// The exact stderr that was thrown away for three hours on 2026-09-05.
const REAL_STDERR = [
  "node:internal/modules/esm/resolve:317",
  "    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
  "          ^",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server' imported from",
  "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
].join("\n");

// ── runFailed ────────────────────────────────────────────────────────────────

test("runFailed: non-zero exit, signal death and timeout all count as failure", () => {
  assert.equal(runFailed({ exitCode: 1 }), true);
  assert.equal(runFailed({ exitCode: null }), true, "killed by signal");
  assert.equal(runFailed({ exitCode: 0, timedOut: true }), true);
});

test("runFailed: a clean run, or no exit code at all, is not a failure", () => {
  assert.equal(runFailed({ exitCode: 0 }), false);
  assert.equal(runFailed({}), false, "undefined is not evidence of anything");
});

// ── the regression this whole module exists for ──────────────────────────────

test("no text + non-zero exit: stderr IS in the reply (W-2026-09-05 regression)", () => {
  const body = buildPrimaryText({
    cli: "pi",
    text: "",
    stderr: REAL_STDERR,
    exitCode: 1,
    timedOut: false,
  });

  assert.ok(body.includes("ERR_MODULE_NOT_FOUND"), "the actual cause must be visible");
  assert.ok(body.includes("@earendil-works/pi-server"), "the missing package must be named");
  assert.ok(body.includes("exit code 1"));
  // The old, useless message must be gone.
  assert.ok(!body.includes("(pi returned no text)"));
});

test("no text + non-zero exit + no stderr: says so explicitly", () => {
  const body = buildPrimaryText({ cli: "pi", text: "", stderr: "", exitCode: 1 });
  assert.match(body, /no stderr was captured/);
  assert.match(body, /exit code 1/);
});

test("no text + timeout: reports the timeout, not a bare exit code", () => {
  const body = buildPrimaryText({ cli: "agy", text: "", stderr: "hung", exitCode: null, timedOut: true });
  assert.match(body, /timed out/);
  assert.ok(!body.includes("killed by signal"));
});

test("no text + killed by signal: named as such", () => {
  const body = buildPrimaryText({ cli: "codex", text: "", stderr: "boom", exitCode: null });
  assert.match(body, /killed by signal/);
});

test("no text but a clean exit: keeps the old, correct message", () => {
  const body = buildPrimaryText({ cli: "pi", text: "", stderr: "", exitCode: 0 });
  assert.equal(body, "(pi returned no text)");
});

test("a successful answer is returned untouched, never buried under stderr", () => {
  // Noisy-but-harmless stderr (deprecation warnings) must not leak into a good reply.
  const body = buildPrimaryText({
    cli: "pi",
    text: "  the answer  ",
    stderr: "(node:1) DeprecationWarning: something",
    exitCode: 0,
  });
  assert.equal(body, "the answer");
});

test("text present but the run failed: the CLI's own words still win", () => {
  const body = buildPrimaryText({ cli: "copilot", text: "quota exceeded", stderr: "raw", exitCode: 1 });
  assert.equal(body, "quota exceeded");
});

// ── truncation ───────────────────────────────────────────────────────────────

test("truncate: keeps the head and marks the cut", () => {
  const long = "E".repeat(STDERR_SNIPPET_MAX + 500);
  const t = truncate(long);
  assert.ok(t.startsWith("EEEE"));
  assert.ok(t.endsWith("... (truncated)"));
  assert.equal(t.length, STDERR_SNIPPET_MAX + "... (truncated)".length);
});

test("truncate: empty-ish input becomes null so it can be omitted from JSON", () => {
  assert.equal(truncate(""), null);
  assert.equal(truncate(null), null);
  assert.equal(truncate(undefined), null);
});

test("a huge stderr is truncated inside the reply, not dumped whole", () => {
  const body = buildPrimaryText({ cli: "pi", text: "", stderr: "X".repeat(50000), exitCode: 1 });
  assert.ok(body.length < STDERR_SNIPPET_MAX + 500);
  assert.ok(body.includes("... (truncated)"));
});

// ── the full body ────────────────────────────────────────────────────────────

test("buildResultBody: appends exactly one metadata footer, per-CLI labelled", () => {
  const meta = { exit_code: 1, timed_out: false };
  const body = buildResultBody({
    cli: "pi",
    text: "",
    stderr: REAL_STDERR,
    exitCode: 1,
    meta,
  });
  const [primary, footer] = body.split("\n\n---\n");
  assert.ok(primary.includes("ERR_MODULE_NOT_FOUND"));
  assert.equal(footer, `pi-bridge metadata: ${JSON.stringify(meta)}`);
});

test("buildResultBody: every bridge labels its own footer", () => {
  for (const cli of ["pi", "agy", "codex", "copilot"]) {
    const body = buildResultBody({ cli, text: "hi", exitCode: 0, meta: {} });
    assert.ok(body.includes(`${cli}-bridge metadata: `));
  }
});
