import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, PROXY_KEYS, spawnCapture } from "../lib/run.mjs";

// ── Platform-aware helpers ───────────────────────────────────────────────────
// On Windows, process.env is case-insensitive: HTTP_PROXY and http_proxy refer
// to the same key. We detect the platform and adjust test data accordingly.

const IS_WIN = process.platform === "win32";

// Keys we'll set in process.env to exercise proxy stripping.
// On Windows we use only the UPPER-case variants (they cover both casings).
// On POSIX we set both casings independently.
const PROXY_KEYS_TO_SET = IS_WIN
  ? { HTTP_PROXY: "http://proxy.corp.example:8080", HTTPS_PROXY: "http://proxy.corp.example:8443", ALL_PROXY: "socks5://proxy.corp.example:1080" }
  : { HTTP_PROXY: "http://proxy.corp.example:8080", HTTPS_PROXY: "http://proxy.corp.example:8443", ALL_PROXY: "socks5://proxy.corp.example:1080", http_proxy: "http://proxy.corp.example:8080", https_proxy: "http://proxy.corp.example:8443", all_proxy: "socks5://proxy.corp.example:1080" };

const PROXY_ENV_KEYS = Object.keys(PROXY_KEYS_TO_SET);

const TEST_UNRELATED_KEY = "BRIDGE_TEST_UNRELATED_VAR";

// ── Lifecycle ────────────────────────────────────────────────────────────────

const saved = {};

function saveEnv(keys) {
  for (const k of keys) saved[k] = process.env[k];
}

function restoreEnv(keys) {
  for (const k of keys) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
    delete saved[k];
  }
}

beforeEach(() => {
  saveEnv([...PROXY_ENV_KEYS, TEST_UNRELATED_KEY, "BRIDGE_BYPASS_PROXY"]);
  // Populate proxy keys and an unrelated key.
  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    process.env[k] = v;
  }
  process.env[TEST_UNRELATED_KEY] = "keep-me";
  // Default: bypass proxy ON (strip proxy keys).
  delete process.env.BRIDGE_BYPASS_PROXY;
});

afterEach(() => {
  restoreEnv([...PROXY_ENV_KEYS, TEST_UNRELATED_KEY, "BRIDGE_BYPASS_PROXY"]);
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("buildChildEnv: default strips all proxy keys, keeps unrelated vars", () => {
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped`);
  }
  assert.equal(childEnv[TEST_UNRELATED_KEY], "keep-me");
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=undefined strips proxy (default is ON)", () => {
  // BRIDGE_BYPASS_PROXY is already deleted in beforeEach.
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped when unset`);
  }
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=true strips proxy", () => {
  process.env.BRIDGE_BYPASS_PROXY = "true";
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped when BRIDGE_BYPASS_PROXY=true`);
  }
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=false preserves proxy keys", () => {
  // Explicitly set everything RIGHT BEFORE the call to avoid test-ordering issues.
  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    process.env[k] = v;
  }
  process.env.BRIDGE_BYPASS_PROXY = "false";

  const childEnv = buildChildEnv();

  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    assert.equal(childEnv[k], v, `${k} should be preserved when BRIDGE_BYPASS_PROXY=false`);
  }
  assert.equal(childEnv[TEST_UNRELATED_KEY], "keep-me");
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=anythingOtherThanFalse also strips (not just 'true')", () => {
  for (const val of ["1", "yes", "TRUE", "on", ""]) {
    process.env.BRIDGE_BYPASS_PROXY = val;
    const childEnv = buildChildEnv();
    for (const k of PROXY_ENV_KEYS) {
      assert.equal(childEnv[k], undefined, `${k} should be stripped when BRIDGE_BYPASS_PROXY=${JSON.stringify(val)}`);
    }
  }
});

test("buildChildEnv: process.env is NEVER mutated (critical regression test)", () => {
  // Record the values before calling buildChildEnv.
  const before = {};
  for (const k of [...PROXY_ENV_KEYS, TEST_UNRELATED_KEY]) {
    before[k] = process.env[k];
  }

  // Default mode: buildChildEnv will strip proxy keys from the RETURNED object.
  const childEnv = buildChildEnv();

  // Verify the returned object had proxy keys stripped.
  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `returned object should not have ${k}`);
  }

  // Verify process.env is completely untouched.
  for (const k of [...PROXY_ENV_KEYS, TEST_UNRELATED_KEY]) {
    assert.equal(process.env[k], before[k], `process.env.${k} was mutated!`);
  }
});

test("buildChildEnv: envOverride is merged on top of process.env", () => {
  const childEnv = buildChildEnv({ MY_CUSTOM_VAR: "hello", HTTPS_PROXY: "http://override:9999" });

  // Custom var should be present.
  assert.equal(childEnv.MY_CUSTOM_VAR, "hello");
  // HTTPS_PROXY override should be stripped by proxy bypass (default ON).
  assert.equal(childEnv.HTTPS_PROXY, undefined);

  // But if bypass is off, the override should win.
  process.env.BRIDGE_BYPASS_PROXY = "false";
  const childEnv2 = buildChildEnv({ MY_CUSTOM_VAR: "hello", HTTPS_PROXY: "http://override:9999" });
  assert.equal(childEnv2.HTTPS_PROXY, "http://override:9999");
  assert.equal(childEnv2.MY_CUSTOM_VAR, "hello");
});

test("buildChildEnv: PROXY_KEYS constant covers expected keys", () => {
  assert.ok(PROXY_KEYS.includes("HTTP_PROXY"));
  assert.ok(PROXY_KEYS.includes("HTTPS_PROXY"));
  assert.ok(PROXY_KEYS.includes("ALL_PROXY"));
  assert.ok(PROXY_KEYS.includes("http_proxy"));
  assert.ok(PROXY_KEYS.includes("https_proxy"));
  assert.ok(PROXY_KEYS.includes("all_proxy"));
  assert.equal(PROXY_KEYS.length, 6);
  // NO_PROXY is intentionally excluded.
  assert.ok(!PROXY_KEYS.includes("NO_PROXY"));
  assert.ok(!PROXY_KEYS.includes("no_proxy"));
});

test("buildChildEnv: returns a plain object (not a reference to process.env)", () => {
  const childEnv = buildChildEnv();
  assert.notEqual(childEnv, process.env);
  // It should be a different object identity.
  childEnv.__TEST_INJECTED = "should-not-affect-parent";
  assert.equal(process.env.__TEST_INJECTED, undefined);
  delete childEnv.__TEST_INJECTED;
});

// ── spawnCapture 的輸出解碼 ──────────────────────────────────────────────────
//
// 2026-09-06：doctor 把 cmd.exe 的 CP950 錯誤印成
//     ?????W?١B?ؿ??W?٩κϺ??ϼ??һy?k???~?C
// 訊息一直都在，只是 `chunk.toString()` 用 UTF-8 解。讀不懂的 stderr 跟被吞掉
// 的 stderr 差不了多少 —— 而 stderr 被吞掉正是 2026-09-05 那 3 小時的成因。
// spawnCapture 是 bridge 的執行路徑，doctor 修好了它也要修。
//
// 這幾條在任何平台都跑：Windows 專屬的部分（用 chcp 問到 big5）在 Linux/macOS
// 上探測會回 null，退到 latin1 —— 要驗的是「不管哪條路都不可以吃掉位元組」。

// 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤。」的 CP950 位元組。
const CMD_SYNTAX_ERROR_BIG5_HEX =
  "c0c9aed7a657bad9a142a5d8bffda657bad9a9cebacfbad0b0cfbcd0c5d2bb79aa6bbff9bb7ea143";

/** 跑一小段 node 程式，回傳 spawnCapture 的結果。 */
function runNode(src) {
  return spawnCapture(process.execPath, ["-e", src], { cwd: process.cwd(), timeoutMs: 20000 });
}

test("非 UTF-8 的 stderr 不會被吃掉 —— 一個 replacement char 都不留", async () => {
  const r = await runNode(
    `process.stderr.write(Buffer.from("${CMD_SYNTAX_ERROR_BIG5_HEX}", "hex")); process.exit(1);`
  );

  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes("�"), "toString() 的舊行為會在這裡塞滿 U+FFFD");
  assert.equal(
    Buffer.from(r.stderr, "latin1").length,
    CMD_SYNTAX_ERROR_BIG5_HEX.length / 2,
    "位元組數不可以變少 —— 少掉就是資訊沒了"
  );
});

test("英文的 Windows 錯誤照樣讀得出來", async () => {
  const msg = "The filename, directory name, or volume label syntax is incorrect.";
  const r = await runNode(`process.stderr.write(${JSON.stringify(msg)}); process.exit(1);`);

  assert.equal(r.stderr, msg);
});

test("被切在兩個 chunk 中間的多位元組字元不會被拆壞", async () => {
  // 一個 UTF-8 中文字是 3 bytes；這裡故意在第 2 個 byte 之後才 flush。
  const src = `
    const b = Buffer.from("完成了", "utf8");
    process.stdout.write(b.subarray(0, 2));
    setTimeout(() => { process.stdout.write(b.subarray(2)); }, 50);
  `;
  const r = await runNode(src);

  assert.equal(r.stdout, "完成了", "逐塊 toString() 在這裡會生出 U+FFFD");
});

test("正常的 UTF-8 輸出完全不受影響", async () => {
  const payload = JSON.stringify({ text: "好的，完成了 ✅" });
  const r = await runNode(`process.stdout.write(${JSON.stringify(payload)});`);

  assert.equal(r.stdout, payload);
  assert.equal(r.code, 0);
  assert.ok(typeof r.durationMs === "number");
});
