/**
 * Integration test for `npm run doctor`'s smoke test.
 *
 * The point of the smoke test is a failure mode doctor USED to miss entirely:
 * an entry point whose `--version` works but which cannot actually run. That
 * is exactly pi 0.85.0's unbundled dist/cli.js — it prints a version, then
 * dies with ERR_MODULE_NOT_FOUND the moment a real run loads its imports.
 *
 * So the fake CLI below is built to pass --version and fail everything else.
 * If doctor reports it healthy, the 2026-09-05 outage could happen again.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOne } from "../scripts/doctor.mjs";

// A CLI that lies: `--version` succeeds, a real prompt crashes on import.
const BROKEN_CLI = `
if (process.argv.includes("--version")) { console.log("0.85.0"); process.exit(0); }
process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server'");
process.exit(1);
`;

// A CLI that works: version, and NDJSON on stdout for a prompt.
const HEALTHY_CLI = `
if (process.argv.includes("--version")) { console.log("0.85.0"); process.exit(0); }
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
process.exit(0);
`;

// A CLI that exits 0 but says nothing — "success" with no output is still broken.
const SILENT_CLI = `
if (process.argv.includes("--version")) { console.log("0.85.0"); process.exit(0); }
process.exit(0);
`;

let dir;
const paths = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "doctor-smoke-"));
  for (const [name, src] of [
    ["broken", BROKEN_CLI],
    ["healthy", HEALTHY_CLI],
    ["silent", SILENT_CLI],
  ]) {
    paths[name] = join(dir, `${name}-cli.js`);
    await writeFile(paths[name], src, "utf8");
  }
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.DOCTOR_TEST_ENTRY;
});

/** A CLI descriptor shaped like doctor's own, pointed at a fake entry. */
function fakeCli(entry) {
  process.env.DOCTOR_TEST_ENTRY = entry;
  return {
    name: "pi", // reuse pi's real smoke flags
    bridge: "pi-bridge",
    tool: "ask_pi",
    envVar: "DOCTOR_TEST_ENTRY",
    cwdVar: "DOCTOR_TEST_CWD",
    binName: "pi",
    versionCmd: ["--version"],
    installHint: "(test)",
    loginHint: "(test)",
  };
}

test("smoke test CATCHES an entry that passes --version but cannot run", async () => {
  const r = await checkOne(fakeCli(paths.broken), { smoke: true });

  assert.equal(r.status, "smoke_failed");
  assert.match(r.note, /ERR_MODULE_NOT_FOUND/, "the real cause must be reported");
  assert.match(r.note, /exit code 1/);
});

test("without the smoke test, that same broken entry looks healthy — this is why it is on by default", async () => {
  const r = await checkOne(fakeCli(paths.broken), { smoke: false });

  assert.equal(r.status, "version_only");
  assert.equal(r.version, "0.85.0");
  // --version alone genuinely cannot see the problem. Documented, not accidental.
});

test("a working entry passes the smoke test", async () => {
  const r = await checkOne(fakeCli(paths.healthy), { smoke: true });

  assert.equal(r.status, "ok");
  assert.equal(r.version, "0.85.0");
  assert.ok(typeof r.smokeMs === "number");
});

test("exit code 0 with empty output still fails — non-empty output is required", async () => {
  const r = await checkOne(fakeCli(paths.silent), { smoke: true });

  assert.equal(r.status, "smoke_failed");
  assert.match(r.note, /輸出是空的/);
});

test("an entry path that does not exist is reported, not silently skipped", async () => {
  const r = await checkOne(fakeCli(join(dir, "nope.js")), { smoke: true });

  assert.equal(r.status, "missing");
  assert.match(r.note, /DOCTOR_TEST_ENTRY/, "must name the env var that is wrong");
});

test("the resolved entry and its source are always reported back", async () => {
  const r = await checkOne(fakeCli(paths.healthy), { smoke: true });

  assert.equal(r.entry, paths.healthy);
  assert.equal(r.entrySource, "env");
});
