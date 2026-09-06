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
import { EventEmitter } from "node:events";
import { checkOne, classifySmokeFailure, runWithTimeout } from "../scripts/doctor.mjs";
import { buildInvocation } from "../lib/cli-entry.mjs";

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

// 一個帶空白與冒號的 prompt —— 正是被 shell:true 拆成六個參數的那一個。
const SMOKE_PROMPT_FIXTURE = "Reply with exactly the two characters: ok";

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

// ── Why a smoke test failed ──────────────────────────────────────────────────
//
// On 2026-09-06 three CLIs failed smoke and doctor said, for all three,
// "通常是入口檔本身壞掉或尚未登入". All three were argument bugs in this repo.
// Pointing someone at `codex login` when the bug is ours costs more time than
// saying nothing, so each kind now has to be recognised from the CLI's words.

test("an argument error is called an argument error, not a login problem", () => {
  const d = classifySmokeFailure({
    exitCode: 2,
    stdout: "",
    stderr: "error: unexpected argument 'with' found\n\nUsage: codex exec [OPTIONS] [PROMPT]",
  });
  assert.equal(d.kind, "bad-args");
  assert.match(d.hint, /不是登入問題/, "this is our bug; the reader must not be sent to a login flow");
});

test("copilot's unquoted-prompt error is the same kind", () => {
  const d = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "error: Invalid command format.\nIt looks like your prompt was not quoted",
  });
  assert.equal(d.kind, "bad-args");
});

test("claude's unknown option is the same kind", () => {
  const d = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "error: unknown option '--permission-prompts'",
  });
  assert.equal(d.kind, "bad-args");
});

test("the 2026-09-05 pi failure is still recognised as a broken entry", () => {
  const d = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server'",
  });
  assert.equal(d.kind, "entry-broken");
  assert.match(d.hint, /bin/);
});

test("cmd.exe 抱怨命令列時，說的是「我們組壞了」，不是 CLI 壞了", () => {
  // 2026-09-06 第二輪 copilot 收到的原句（解碼之後）。
  const zh = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "檔案名稱、目錄名稱或磁碟區標籤語法錯誤。",
  });
  assert.equal(zh.kind, "cmd-line");
  assert.match(zh.hint, /windowsVerbatimArguments/, "要指到真正的修法");

  const en = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "The filename, directory name, or volume label syntax is incorrect.",
  });
  assert.equal(en.kind, "cmd-line", "英文 Windows 也要認得");
});

test("a real login failure is still called a login failure", () => {
  const d = classifySmokeFailure({
    exitCode: 1,
    stdout: "",
    stderr: "Error: Not logged in. Run `codex login` first.",
  });
  assert.equal(d.kind, "auth");
});

test("a timeout is its own kind, not guesswork", () => {
  const d = classifySmokeFailure({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(d.kind, "timeout");
});

test("an unrecognised failure says so instead of guessing", () => {
  const d = classifySmokeFailure({ exitCode: 3, stdout: "", stderr: "wat" });
  assert.equal(d.kind, "unknown");
  assert.equal(d.hint, null);
});

// ── invocation → spawn：整包傳，不要挑欄位 ───────────────────────────────────
//
// 2026-09-06（第二輪）：doctor 把 copilot 報成 ❌ smoke 失敗，錯誤訊息是
// 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤。」。copilot 是唯一入口為 .cmd 的
// CLI，所以只有它會走 buildCmdInvocation()：那條路自己組好 cmd.exe 的命令列並
// 跳脫過，回傳 windowsVerbatimArguments: true 要 Node 別再加工。runWithTimeout
// 當時只解構 { command, args, shell }，把那個旗標丟了 —— Node 於是在我們跳脫過
// 的字串外再加一層引號，cmd.exe 收到壞掉的命令列。CLI 本身完全正常。
//
// 這條測試盯的是「invocation 的每個欄位都要原封不動送到 spawn」，不是某一個
// 旗標的值。

/** 一個立刻正常結束的假 child，只為了看 spawn 收到什麼 options。 */
function recordingSpawn(calls, { exitCode = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("close", exitCode));
    return child;
  };
}

test("runWithTimeout 把 windowsVerbatimArguments 傳下去 —— 少傳這個，Node 會把已跳脫的命令列再加一層引號", async () => {
  const inv = buildInvocation("C:\\Users\\x\\npm\\copilot.cmd", ["-p", SMOKE_PROMPT_FIXTURE], {
    comspec: "cmd.exe",
  });
  assert.equal(inv.windowsVerbatimArguments, true, "前提：.cmd 入口就是要用 verbatim");

  const calls = [];
  await runWithTimeout(inv, { timeoutMs: 5000, cwd: process.cwd(), spawnFn: recordingSpawn(calls) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cmd.exe", "cmd 入口要透過 cmd.exe 執行");
  assert.deepEqual(calls[0].args, inv.args, "我們組好的 args 不可以被改動");
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("runWithTimeout 永遠不用 shell —— 跳脫只能發生在 lib/win-args.mjs 一個地方", async () => {
  const calls = [];
  const inv = buildInvocation("/x/agy.exe", ["--version"]);
  await runWithTimeout(inv, { timeoutMs: 5000, cwd: process.cwd(), spawnFn: recordingSpawn(calls) });

  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, false, "一般執行檔不需要 verbatim");
});
