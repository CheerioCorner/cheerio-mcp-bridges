/**
 * doctor 讀得懂 Windows 的錯誤訊息嗎？
 *
 * 2026-09-06：copilot 的失敗原因印出來是
 *     exit code 1｜�ɮצW�١B�ؿ��W�٩κϺаϼ��һy�k���~�C
 * 原句是 cmd.exe 的「檔案名稱、目錄名稱或磁碟區標籤語法錯誤。」，CP950（Big5）
 * 編碼，被當成 UTF-8 解。訊息一直都在，只是沒有人讀得懂 —— 這跟沒有訊息只差
 * 一點點。下面第一條測試用的就是那串真實的 Big5 位元組。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  codePageToLabel,
  decodeChildOutput,
  detectConsoleCodePage,
  parseChcp,
} from "../lib/console-encoding.mjs";

const CMD_SYNTAX_ERROR = "檔案名稱、目錄名稱或磁碟區標籤語法錯誤。";

/**
 * 那句話真正的 CP950 位元組（寫成 hex，不依賴平台有沒有 iconv）。
 * 產生方式：`"檔案名稱、目錄名稱或磁碟區標籤語法錯誤。".encode("big5").hex()`
 */
const CMD_SYNTAX_ERROR_BIG5_HEX =
  "c0c9aed7a657bad9a142a5d8bffda657bad9a9cebacfbad0b0cfbcd0c5d2bb79aa6bbff9bb7ea143";

function big5Bytes() {
  return Buffer.from(CMD_SYNTAX_ERROR_BIG5_HEX, "hex");
}

// ── decodeChildOutput ────────────────────────────────────────────────────────

test("Big5 的 cmd.exe 錯誤訊息會被解成看得懂的中文，而不是一排 replacement char", () => {
  const decoded = decodeChildOutput(big5Bytes(), "big5");

  assert.equal(decoded, CMD_SYNTAX_ERROR);
  assert.ok(!decoded.includes("\uFFFD"), "不可以留下任何 U+FFFD");
});

test("UTF-8 的輸出維持 UTF-8 —— 同一條 pipe 兩種編碼，不可以一律當 Big5 解", () => {
  // copilot 自己印的 JSON 是 UTF-8，就算這台機器的 console 是 CP950。
  const json = Buffer.from(JSON.stringify({ text: "好的，完成了 ✅" }), "utf8");

  assert.equal(decodeChildOutput(json, "big5"), '{"text":"好的，完成了 ✅"}');
});

test("沒有 OEM label 時不會丟掉位元組 —— latin1 至少讓 ASCII 讀得出來", () => {
  const bytes = Buffer.concat([Buffer.from("copilot: "), big5Bytes()]);
  const decoded = decodeChildOutput(bytes, null);

  assert.match(decoded, /^copilot: /, "英文部分一定要讀得出來");
  assert.equal(Buffer.from(decoded, "latin1").length, bytes.length, "位元組數不可以變少");
});

test("這個 Node build 不認得的 label 不會炸掉，退回 latin1", () => {
  const decoded = decodeChildOutput(big5Bytes(), "not-a-real-encoding");
  assert.equal(typeof decoded, "string");
  assert.ok(decoded.length > 0);
});

test("空輸出就是空字串", () => {
  assert.equal(decodeChildOutput(Buffer.alloc(0), "big5"), "");
  assert.equal(decodeChildOutput(null, "big5"), "");
});

// ── parseChcp ────────────────────────────────────────────────────────────────
//
// chcp 的文案本身是在地化的，而且它自己也可能是亂碼。所以只認數字，不認字。

test("chcp 的輸出不管哪個語言、就算自己是亂碼，都抓得到 code page", () => {
  assert.equal(parseChcp("Active code page: 950"), 950);
  assert.equal(parseChcp("使用中的字碼頁: 950"), 950);
  assert.equal(parseChcp("¨Ï¥Î¤¤ªº¦r½X­¶: 950"), 950, "亂碼版也要抓得到");
  assert.equal(parseChcp("Aktive Codepage: 850"), 850);
  assert.equal(parseChcp("Active code page: 65001\r\n"), 65001);
});

test("讀不出數字就回 null，不要瞎猜", () => {
  assert.equal(parseChcp(""), null);
  assert.equal(parseChcp("command not found"), null);
  assert.equal(parseChcp(null), null);
});

// ── codePageToLabel ──────────────────────────────────────────────────────────

test("常見 code page 對得到 TextDecoder 認得的 label", () => {
  assert.equal(codePageToLabel(950), "big5");
  assert.equal(codePageToLabel(65001), "utf-8");
  assert.equal(codePageToLabel("936"), "gbk");
});

test("對不到的 code page 回 null（例如 DOS 的 437），不是丟一個假 label 出去", () => {
  assert.equal(codePageToLabel(437), null);
  assert.equal(codePageToLabel(null), null);
});

// ── detectConsoleCodePage ────────────────────────────────────────────────────

function fakeChcp({ stdout = "", fail = false, code = 0 } = {}) {
  return () => {
    if (fail) throw new Error("spawn ENOENT");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "latin1"));
      child.emit("close", code);
    });
    return child;
  };
}

test("非 Windows 一律回 null，連 spawn 都不做", async () => {
  let spawned = false;
  const cp = await detectConsoleCodePage({
    platform: "linux",
    spawnFn: () => {
      spawned = true;
    },
  });
  assert.equal(cp, null);
  assert.equal(spawned, false);
});

test("Windows 上問得到就用問到的", async () => {
  const cp = await detectConsoleCodePage({
    platform: "win32",
    comspec: "cmd.exe",
    spawnFn: fakeChcp({ stdout: "Active code page: 950\r\n" }),
  });
  assert.equal(cp, 950);
});

test("探測失敗回 null＝維持原本的 UTF-8 解碼，絕不會讓輸出比修好之前更糟", async () => {
  for (const opts of [{ fail: true }, { stdout: "" }, { stdout: "wat", code: 1 }]) {
    const cp = await detectConsoleCodePage({
      platform: "win32",
      comspec: "cmd.exe",
      spawnFn: fakeChcp(opts),
    });
    assert.equal(cp, null);
  }
});

test("探測走的是 cmd.exe，而且跟其他地方一樣用 verbatim，不用 shell", async () => {
  let seen = null;
  await detectConsoleCodePage({
    platform: "win32",
    comspec: "C:\\WINDOWS\\system32\\cmd.exe",
    spawnFn: (command, args, options) => {
      seen = { command, args, options };
      return fakeChcp({ stdout: "Active code page: 950" })();
    },
  });

  assert.equal(seen.command, "C:\\WINDOWS\\system32\\cmd.exe");
  assert.deepEqual(seen.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.windowsVerbatimArguments, true);
});
