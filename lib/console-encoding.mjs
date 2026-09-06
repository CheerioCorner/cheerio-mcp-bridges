/**
 * Reading a Windows child process's output without turning it into 亂碼.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * On 2026-09-06 doctor reported copilot as broken and printed its reason as:
 *
 *     exit code 1｜�ɮצW�١B�ؿ��W�٩κϺаϼ��һy�k���~�C
 *
 * The reason was real and useful — cmd.exe saying
 * 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤。」 — but it arrived as CP950 (Big5)
 * bytes and `chunk.toString()` decodes UTF-8, so every Chinese byte pair became
 * a replacement character. Diagnosing it took a guess at what the original
 * sentence must have been.
 *
 * An error nobody can read is barely better than no error at all, which is the
 * standing rule for this repo (see REVIEW.md: 「出事的時候誰會知道？」). So:
 * Win32 and cmd.exe emit their messages in the console's OEM code page, and we
 * ask the console which one that is instead of assuming.
 *
 * THE MIXED-ENCODING PROBLEM
 * --------------------------
 * One pipe can carry both encodings: the CLI's own stdout is UTF-8 (copilot
 * prints JSON), while a cmd.exe failure on the SAME run is CP950. Decoding
 * everything as Big5 would mangle the healthy case.
 *
 * So the order is: try UTF-8 with `fatal: true` first, and fall back to the OEM
 * decoder only when the bytes are genuinely not UTF-8. Almost no Big5 byte
 * sequence is valid UTF-8, and all valid UTF-8 stays UTF-8 — the two cases
 * separate cleanly. This also means the fallback costs nothing on Linux/macOS,
 * where nothing ever reaches it.
 */

import { spawn } from "node:child_process";
import { buildCmdInvocation } from "./win-args.mjs";

/**
 * Windows code page → WHATWG encoding label (what TextDecoder understands).
 *
 * Only the code pages a TextDecoder can actually take are listed. A code page
 * that is missing here (437 and the other DOS pages, most notably) falls back
 * to latin1, which at least keeps every byte and every ASCII word readable —
 * and Win32's English messages are pure ASCII anyway.
 */
const CODE_PAGE_LABELS = new Map([
  [65001, "utf-8"],
  [1200, "utf-16le"],
  [950, "big5"], // 繁體中文 —— 這台機器
  [936, "gbk"],
  [932, "shift_jis"],
  [949, "euc-kr"],
  [874, "windows-874"],
  [866, "ibm866"],
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1255, "windows-1255"],
  [1256, "windows-1256"],
  [1257, "windows-1257"],
  [1258, "windows-1258"],
]);

/**
 * @param {number|string|null|undefined} cp
 * @returns {string|null} A TextDecoder label, or null if we have no mapping.
 */
export function codePageToLabel(cp) {
  return CODE_PAGE_LABELS.get(Number(cp)) ?? null;
}

/**
 * Pull the code page number out of `chcp` output.
 *
 * The wording is localised — "Active code page: 950",
 * 「使用中的字碼頁: 950」, "Aktive Codepage: 850" — and may itself arrive as
 * 亂碼, so we do not match on the words at all. The number is ASCII in every
 * locale, and it is the last one on the line.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseChcp(text) {
  const nums = String(text ?? "").match(/\d+/g);
  if (!nums) return null;
  const cp = Number(nums[nums.length - 1]);
  return Number.isInteger(cp) && cp > 0 ? cp : null;
}

/**
 * Ask the console which code page it is in.
 *
 * Costs one `cmd.exe /d /s /c chcp` — no CLI, no credits, no login. Returns
 * null on any non-Windows platform and on any failure: null means "decode as
 * UTF-8 and fall back to latin1", i.e. exactly today's behaviour, so a failed
 * probe can never make output worse than it already was.
 *
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {Function} [o.spawnFn]
 * @param {string} [o.comspec]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<number|null>}
 */
export function detectConsoleCodePage({
  platform = process.platform,
  spawnFn = spawn,
  comspec,
  timeoutMs = 4000,
} = {}) {
  if (platform !== "win32") return Promise.resolve(null);

  const inv = buildCmdInvocation("chcp.com", [], { comspec });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(inv.command, inv.args, {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        windowsVerbatimArguments: !!inv.windowsVerbatimArguments,
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      done(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (c) => (out += c.toString("latin1")));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(parseChcp(out));
    });
  });
}

/**
 * Decode captured child output.
 *
 * @param {Buffer|Uint8Array|null} buf
 * @param {string|null} [oemLabel]  TextDecoder label from codePageToLabel().
 * @returns {string}
 */
export function decodeChildOutput(buf, oemLabel = null) {
  if (!buf || buf.length === 0) return "";
  try {
    // fatal:true is the whole trick — it turns "these bytes are not UTF-8"
    // into a signal instead of a string full of U+FFFD.
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Not UTF-8. On Windows that means the console's OEM code page.
  }
  if (oemLabel && oemLabel !== "utf-8") {
    try {
      return new TextDecoder(oemLabel).decode(buf);
    } catch {
      // This Node build does not know the label (small-icu). Fall through.
    }
  }
  // Never lose the bytes: latin1 is 1:1 and keeps ASCII words readable.
  return Buffer.from(buf).toString("latin1");
}
