#!/usr/bin/env node
/**
 * doctor.mjs — 檢查本機 4 支 CLI 是否真的能用，輔助判斷要啟用哪些 bridge。
 *
 * 用法：
 *   npm run doctor              解析入口 → --version → smoke test（預設全跑）
 *   npm run doctor -- --no-smoke   只做入口解析與 --version，完全不花額度
 *
 * 為什麼預設要跑 smoke test：
 *   2026-09-05 的事故裡，pi 的入口檔（dist/cli.js）import 了一個沒安裝的套件，
 *   一啟動就 ERR_MODULE_NOT_FOUND。但 `--version` 在某些 CLI 上會在載入完整
 *   相依之前就先印版本並退出 —— 也就是說「--version 過了」不代表「這支 CLI
 *   能用」。只有真的送一個 prompt 跑完整條路徑，才擋得住這類故障。
 *   smoke test 每支 CLI 只送一個極短 prompt，成本可忽略。
 *
 * 這支腳本不猜路徑：入口一律由 <CLI>_BRIDGE_ENTRY、套件自己的 package.json
 * "bin" 欄位、或 PATH 解析出來；三者都沒有就明確報錯（見 lib/cli-entry.mjs）。
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "../lib/run.mjs";
import { buildInvocation, buildSmokeInvocation, resolveEntry } from "../lib/cli-entry.mjs";
import { parseClaudeCapabilities } from "../lib/claude-flags.mjs";
import { codePageToLabel, decodeChildOutput, detectConsoleCodePage } from "../lib/console-encoding.mjs";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI 設定 ─────────────────────────────────────────────────────────────────
// 沒有任何預設路徑：npmPackage 有值的，會從該套件 package.json 的 "bin" 動態
// 解析（這正是 pi 事故中唯一正確的答案：dist/bundle/cli.js）；沒有的就只靠
// env 或 PATH。
export const CLIS = [
  {
    name: "pi",
    bridge: "pi-bridge",
    tool: "ask_pi",
    envVar: "PI_BRIDGE_ENTRY",
    cwdVar: "PI_BRIDGE_CWD",
    npmPackage: "@earendil-works/pi-coding-agent",
    binName: "pi",
    versionCmd: ["--version"],
    installHint: "npm install -g @earendil-works/pi-coding-agent",
    loginHint: "pi 會在第一次啟動時引導登入",
  },
  {
    name: "agy",
    bridge: "agy-bridge",
    tool: "ask_agy",
    envVar: "AGY_BRIDGE_ENTRY",
    cwdVar: "AGY_BRIDGE_CWD",
    binName: "agy",
    versionCmd: ["--version"],
    installHint: "請參考 https://github.com/nicholasareed/antigravity 安裝",
    loginHint: "agy login（會引導 Google 帳號授權）",
  },
  {
    name: "codex",
    bridge: "codex-bridge",
    tool: "ask_codex",
    envVar: "CODEX_BRIDGE_ENTRY",
    cwdVar: "CODEX_BRIDGE_CWD",
    npmPackage: "@openai/codex",
    binName: "codex",
    versionCmd: ["--version"],
    installHint: "請參考 OpenAI 官方文件安裝 Codex CLI",
    loginHint: "codex login（會引導 ChatGPT 帳號授權）",
  },
  {
    name: "copilot",
    bridge: "copilot-bridge",
    tool: "ask_copilot",
    envVar: "COPILOT_BRIDGE_ENTRY",
    cwdVar: "COPILOT_BRIDGE_CWD",
    npmPackage: "@github/copilot-cli",
    binName: "copilot",
    versionCmd: ["--version"],
    installHint: "npm install -g @github/copilot-cli",
    loginHint: "copilot login（會引導 GitHub 帳號授權）",
  },
  {
    name: "claude",
    bridge: "claude-bridge",
    tool: "ask_claude",
    envVar: "CLAUDE_BRIDGE_ENTRY",
    cwdVar: "CLAUDE_BRIDGE_CWD",
    // package.json 的 bin 指向 bin/claude.exe —— 是原生執行檔不是 JS 腳本，
    // 所以 buildInvocation 會直接執行它，不會前置 node。
    npmPackage: "@anthropic-ai/claude-code",
    binName: "claude",
    versionCmd: ["--version"],
    // claude's flag names move between patch releases, so ask this build what
    // it takes before sending it anything. --help costs nothing.
    capabilityProbe: { args: ["--help"], parse: parseClaudeCapabilities },
    installHint: "npm install -g @anthropic-ai/claude-code（或官方安裝腳本）",
    loginHint: "claude 首次啟動會引導登入（訂閱制走 OAuth）",
  },
];

const VERSION_TIMEOUT_MS = 8000;
const SMOKE_TIMEOUT_MS = Number(process.env.DOCTOR_SMOKE_TIMEOUT_MS || 120000);

// ── 工具函式 ─────────────────────────────────────────────────────────────────

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 子行程輸出的解碼方式。
 *
 * Windows 的 cmd.exe 與 Win32 錯誤訊息走 console 的 OEM code page（這台是
 * CP950 / Big5），CLI 自己印的 JSON 則是 UTF-8 —— 同一條 pipe 兩種編碼。
 * 2026-09-06 那則 copilot 失敗原因就是這樣變成
 * 「exit code 1｜�ɮצW�١B...」的：訊息一直都在，只是讀不懂。
 * 看不懂的錯誤跟沒有錯誤差不多（REVIEW.md：「出事的時候誰會知道？」）。
 *
 * 探測失敗就是 null＝維持純 UTF-8 解碼，也就是修好之前的行為 —— 問不到絕不會
 * 讓輸出比原本更糟。見 lib/console-encoding.mjs。
 */
let oemLabel = null;

export async function initConsoleEncoding(opts) {
  oemLabel = codePageToLabel(await detectConsoleCodePage(opts));
  return oemLabel;
}

/**
 * 執行一個帶逾時的指令，回傳 { ok, stdout, stderr, output, exitCode }。
 * ok 的定義刻意嚴格：exit code 必須是 0。
 *
 * 第一個參數是 buildInvocation()/buildSmokeInvocation() 回傳的**整個** invocation
 * 物件，而且要原封不動往下傳。這裡曾經只解構 `{ command, args, shell }`：
 * `.cmd` 入口（Windows 上 npm 裝的 copilot 就是）由 buildCmdInvocation() 自己
 * 組好並跳脫過 cmd.exe 的命令列，靠 `windowsVerbatimArguments: true` 要求 Node
 * 別再加工；那個旗標被丟掉之後，Node 又用自己的規則在我們跳脫過的字串外面加了
 * 一層反斜線引號，cmd.exe 收到壞掉的命令列，回
 * 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤。」——
 * 於是 doctor 把一支好好的 copilot 報成壞的（lib/run.mjs 的 spawnCapture 有正確
 * 傳，所以 bridge 本身一直是好的）。誤報比不報更貴，見 REVIEW.md。
 *
 * @param {{command:string, args:string[], windowsVerbatimArguments?:boolean}} inv
 * @param {object} o
 * @param {number} o.timeoutMs
 * @param {string} o.cwd
 * @param {Function} [o.spawnFn]  注入點，讓測試看得到真正送進 spawn 的 options。
 */
export function runWithTimeout(inv, { timeoutMs, cwd, spawnFn = spawn }) {
  const { command, args } = inv;
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // 這個 repo 沒有任何地方用 shell: true —— 命令列的跳脫只存在
        // lib/win-args.mjs 一個地方，見上面的說明。
        shell: false,
        windowsVerbatimArguments: !!inv.windowsVerbatimArguments,
        windowsHide: true,
        env: buildChildEnv(),
      });
    } catch (err) {
      return resolve({ ok: false, stdout: "", stderr: String(err), output: `(spawn error) ${err}`, exitCode: null, durationMs: 0 });
    }
    // 收 Buffer、最後才解碼：一個多位元組字元可能被切在兩個 chunk 中間，
    // 逐塊 toString() 會把它拆壞，而我們的 UTF-8/OEM 判斷正是靠「這串位元組
    // 是不是合法 UTF-8」，被拆壞就判錯了。
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (c) => outChunks.push(Buffer.from(c)));
    child.stderr.on("data", (c) => errChunks.push(Buffer.from(c)));
    const decoded = () => ({
      stdout: decodeChildOutput(Buffer.concat(outChunks), oemLabel),
      stderr: decodeChildOutput(Buffer.concat(errChunks), oemLabel),
    });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      done({ ...decoded(), ok: false, output: "(timeout)", exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const { stdout, stderr } = decoded();
      done({ ok: code === 0, stdout, stderr, output: (stdout + stderr).trim(), exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ...decoded(), ok: false, output: `(spawn error) ${err.message}`, exitCode: null });
    });
  });
}

function firstLine(s, max = 80) {
  return (s || "").trim().split(/\r?\n/)[0].slice(0, max);
}

/** stderr 的頭幾行 —— 錯誤原因通常就在最前面。 */
function errorHead(r, max = 200) {
  const src = (r.stderr || "").trim() || (r.stdout || "").trim() || r.output || "";
  return src.split(/\r?\n/).slice(0, 3).join(" / ").slice(0, max);
}


/**
 * Say WHY a smoke run failed, from the evidence.
 *
 * The old text said "通常是入口檔本身壞掉或尚未登入" for every failure. On
 * 2026-09-06 all three failures were argument bugs in this repo, and that
 * sentence sent the reader to `codex login` — a wrong answer stated
 * confidently is worse than no answer, so each kind now has to be recognised
 * from the CLI's own words or it stays "unknown".
 *
 * @param {{exitCode:number|null, stdout:string, stderr:string, timedOut?:boolean}} res
 * @returns {{kind:string, hint:string}}
 */
export function classifySmokeFailure(res) {
  const text = `${res.stderr || ""}\n${res.stdout || ""}`;

  if (res.timedOut) {
    return {
      kind: "timeout",
      hint: "在時限內沒有回應 —— 可能是它在等一個沒人看得到的互動提示，或網路/代理擋住了。DOCTOR_SMOKE_TIMEOUT_MS 可以放寬時限。",
    };
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)|MODULE_NOT_FOUND/i.test(text)) {
    return {
      kind: "entry-broken",
      hint: "入口檔 import 了沒安裝的套件 —— 這就是 2026-09-05 的 pi。重裝這支 CLI，或把 *_BRIDGE_ENTRY 指向套件 package.json \"bin\" 所指的那個檔案。",
    };
  }
  if (/unknown option|unexpected argument|unrecognized|invalid command format|allowed choices|error: unknown|too many arguments/i.test(text)) {
    return {
      kind: "bad-args",
      hint: "這支 CLI 不接受我們送的參數 —— 是這個 repo 跟它的版本對不上，不是登入問題。對照它的 --help 修 lib/cli-entry.mjs 的 buildSmokeInvocation 與對應的 lib/<cli>.mjs。",
    };
  }
  if (/not logged in|please (log|sign) in|unauthorized|authentication|401|no credentials|login required|expired/i.test(text)) {
    return { kind: "auth", hint: null }; // the per-CLI loginHint says the rest
  }
  // cmd.exe 在抱怨命令列本身。這幾句是 Win32 在指令名稱壞掉時的固定說法，
  // 意思是「送進 cmd.exe 的那條命令列組壞了」—— 2026-09-06 doctor 漏傳
  // windowsVerbatimArguments 時 copilot 收到的就是第一句。這是我們的 bug，
  // 不是 CLI 的問題，更不是沒登入。
  if (
    /filename, directory name, or volume label syntax is incorrect|檔案名稱、目錄名稱或磁碟區標籤語法錯誤|is not recognized as an internal or external command|不是內部或外部命令|The system cannot find the path specified|系統找不到指定的路徑/i.test(
      text
    )
  ) {
    return {
      kind: "cmd-line",
      hint: "cmd.exe 說命令列本身有問題 —— 是我們組壞的，不是這支 CLI 壞了。invocation 物件要整包傳給 spawn（windowsVerbatimArguments 少傳一個就會這樣），見 lib/win-args.mjs 與 runWithTimeout。",
    };
  }
  if (/EINVAL|ENOENT|spawn/i.test(text)) {
    return {
      kind: "spawn",
      hint: "連啟動都失敗了。Windows 上 .cmd / .bat 不能直接 CreateProcess —— 檢查解析出來的入口，或把 *_BRIDGE_ENTRY 指向真正的執行檔。",
    };
  }
  return { kind: "unknown", hint: null };
}

// ── 各階段檢查 ───────────────────────────────────────────────────────────────

export async function checkOne(cli, { smoke }) {
  const resolved = await resolveEntry({
    envVar: cli.envVar,
    npmPackage: cli.npmPackage,
    binName: cli.binName,
  });

  if (!resolved.path) {
    return {
      ...cli,
      entry: null,
      entrySource: null,
      status: "missing",
      note: `找不到入口。已嘗試：${resolved.tried.join("；")}`,
    };
  }

  // env 指定的路徑不做任何猜測式修正 —— 存在與否直接回報。
  if (!(await fileExists(resolved.path))) {
    return {
      ...cli,
      entry: resolved.path,
      entrySource: resolved.source,
      status: "missing",
      note:
        resolved.source === "env"
          ? `${cli.envVar} 指到不存在的檔案：${resolved.path}`
          : `解析出的入口不存在：${resolved.path}`,
    };
  }

  const cwd = process.env[cli.cwdVar] || repoRoot;

  const versionRes = await runWithTimeout(buildInvocation(resolved.path, cli.versionCmd), {
    timeoutMs: VERSION_TIMEOUT_MS,
    cwd,
  });
  const version = versionRes.ok ? firstLine(versionRes.stdout || versionRes.output) : null;
  const versionNote = versionRes.ok ? null : errorHead(versionRes) || "版本檢查失敗（可能需要登入）";

  if (!smoke) {
    // 沒有 smoke test 時，--version 是我們僅有的訊號，失敗就只能當失敗。
    return versionRes.ok
      ? { ...cli, entry: resolved.path, entrySource: resolved.source, status: "version_only", version, note: version }
      : { ...cli, entry: resolved.path, entrySource: resolved.source, status: "version_failed", note: versionNote };
  }

  // --version 失敗不直接結案 —— smoke test 是比它強的訊號，所以讓 smoke 來裁決。
  // 這不是理論：某些受限環境的 claude 包裝腳本只接受 `claude -p "<prompt>"`，
  // --version 會直接非 0 退出，但實際送 prompt 完全正常。反過來（--version 過
  // 但跑不動）正是 2026-09-05 的 pi。兩個方向都只有 smoke test 講得準。

  // ── 版本能力探測 ──────────────────────────────────────────────────────────
  // 只有宣告了 capabilityProbe 的 CLI 才跑（目前只有 claude）。不花額度。
  let caps = null;
  if (cli.capabilityProbe) {
    const capsRes = await runWithTimeout(buildInvocation(resolved.path, cli.capabilityProbe.args), {
      timeoutMs: VERSION_TIMEOUT_MS,
      cwd,
    });
    const parsed = cli.capabilityProbe.parse(`${capsRes.stdout}\n${capsRes.stderr}`);
    // 探測失敗 ≠ 旗標不存在 —— 讀不到就什麼都不調整，寧可讓 smoke 明講哪個
    // 旗標不被接受，也不要默默拔掉權限旗標。
    caps = parsed && parsed.flags && parsed.flags.size > 0 ? parsed : null;
  }

  // ── 真正的 smoke test：跑完整條路徑 ────────────────────────────────────────
  const smokeInv = buildSmokeInvocation(cli.name, resolved.path, { caps });
  const smokeRes = await runWithTimeout(smokeInv, { timeoutMs: SMOKE_TIMEOUT_MS, cwd });
  const producedOutput = !!smokeRes.stdout.trim();
  const droppedFlags = smokeInv.droppedFlags || [];

  if (!smokeRes.ok || !producedOutput) {
    const why = !smokeRes.ok
      ? `exit code ${smokeRes.exitCode === null ? "null（被中止或逾時）" : smokeRes.exitCode}`
      : "輸出是空的";
    return {
      ...cli,
      entry: resolved.path,
      entrySource: resolved.source,
      status: "smoke_failed",
      version,
      versionFailed: !versionRes.ok,
      note: `${why}｜${errorHead(smokeRes) || "（沒有任何 stderr）"}`,
      diagnosis: classifySmokeFailure({ ...smokeRes, timedOut: !!smokeRes.timedOut }),
      droppedFlags,
      smokeMs: smokeRes.durationMs,
    };
  }

  return {
    ...cli,
    entry: resolved.path,
    entrySource: resolved.source,
    status: "ok",
    version,
    versionFailed: !versionRes.ok,
    droppedFlags,
    note: versionRes.ok
      ? `${version}（smoke ${Math.round(smokeRes.durationMs / 1000)}s）`
      : `smoke 通過（${Math.round(smokeRes.durationMs / 1000)}s）但 --version 失敗：${versionNote}`,
    smokeMs: smokeRes.durationMs,
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  ok: "✅ 可用",
  version_only: "✅ 版本 OK",
  version_failed: "⚠️  版本失敗",
  smoke_failed: "❌ smoke 失敗",
  missing: "❌ 未找到",
};

const HEALTHY = new Set(["ok", "version_only"]);

async function main() {
  const smoke = !process.argv.includes("--no-smoke");

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  cheerio-mcp-bridges doctor — CLI 可用性檢查                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(
    smoke
      ? "  模式：完整檢查（含 smoke test，每支 CLI 送一個極短 prompt）\n"
      : "  模式：--no-smoke（只解析入口與 --version，不花任何額度）\n"
  );

  // 先問 console 的 code page，再開始跑 —— 這樣後面每一則錯誤訊息才讀得懂。
  await initConsoleEncoding();

  const results = [];
  for (const cli of CLIS) {
    // 進度只在互動終端顯示；被導向檔案或 CI 時不要留下 \r 垃圾。
    if (process.stdout.isTTY) process.stdout.write(`  檢查 ${cli.name} …`.padEnd(40) + "\r");
    results.push(await checkOne(cli, { smoke }));
  }
  if (process.stdout.isTTY) process.stdout.write(" ".repeat(40) + "\r");

  const colW = { cli: 9, bridge: 16, status: 14, note: 46 };
  const sep = "─".repeat(colW.cli + colW.bridge + colW.status + colW.note + 9);
  console.log(
    `  ${"CLI".padEnd(colW.cli)} │ ${"Bridge".padEnd(colW.bridge)} │ ${"Status".padEnd(colW.status)} │ ${"Version / Note"}`
  );
  console.log(`  ${sep}`);
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(colW.cli)} │ ${r.bridge.padEnd(colW.bridge)} │ ${(STATUS_LABEL[r.status] || r.status).padEnd(colW.status)} │ ${(r.note || "").slice(0, colW.note)}`
    );
  }

  console.log();
  console.log("── 入口來源 ──────────────────────────────────────────────────");
  for (const r of results) {
    const src =
      r.entrySource === "env"
        ? `${r.envVar}`
        : r.entrySource === "package-bin"
          ? `${r.npmPackage} package.json "bin"`
          : r.entrySource === "path"
            ? "PATH"
            : "（未解析出）";
    console.log(`  ${r.name.padEnd(9)} ${src}`);
    if (r.entry) console.log(`  ${" ".repeat(9)}${r.entry}`);
  }

  const withDropped = results.filter((r) => r.droppedFlags && r.droppedFlags.length > 0);
  if (withDropped.length > 0) {
    console.log();
    console.log("── 版本差異（已自動降級） ────────────────────────────────────");
    for (const r of withDropped) {
      for (const w of r.droppedFlags) console.log(`  ${r.name.padEnd(9)} ${w}`);
    }
  }

  console.log();
  console.log("── 建議 ──────────────────────────────────────────────────────");
  const available = results.filter((r) => HEALTHY.has(r.status));
  const unavailable = results.filter((r) => !HEALTHY.has(r.status));

  if (available.length > 0) {
    console.log(`  這台機器可以啟用 ${available.length} 個 bridge：`);
    for (const r of available) console.log(`    ✓ ${r.bridge}（工具：${r.tool}）`);
  }
  if (unavailable.length > 0) {
    console.log(`  以下 ${unavailable.length} 個 bridge 不建議啟用：`);
    for (const r of unavailable) {
      console.log(`    ✗ ${r.bridge} — ${STATUS_LABEL[r.status]}`);
      console.log(`      ${r.note}`);
      if (r.status === "missing") {
        console.log(`      安裝：${r.installHint}`);
        console.log(`      或直接在 MCP server 的 env 設定 ${r.envVar} 為絕對路徑`);
      } else if (r.status === "smoke_failed") {
        console.log(
          r.versionFailed
            ? `      入口找得到，但 --version 和實際 prompt 都失敗了 ——`
            : `      入口存在且 --version 正常，但實際跑一個 prompt 失敗 ——`
        );
        const d = r.diagnosis || { kind: "unknown", hint: null };
        if (d.hint) console.log(`      ${d.hint}`);
        if (d.kind === "auth") console.log(`      看起來是還沒登入：${r.loginHint}`);
        if (d.kind === "unknown") {
          console.log(`      認不出這個錯誤。可能是入口檔壞掉（相依沒裝）或尚未登入：${r.loginHint}`);
          console.log(`      完整輸出在上面的 Note 欄；必要時直接手動跑一次那支 CLI。`);
        }
      } else {
        console.log(`      登入：${r.loginHint}`);
      }
    }
  }

  console.log();
  console.log("  請把上面「可以啟用」的 bridge 區塊，從 mcp-config.example.json");
  console.log("  複製進你的 MCP client 設定（.mcp.json），並調整路徑與環境變數。");
  console.log("  沒裝的 CLI 對應的 bridge 不要加，加了會在啟動時報錯。");
  console.log();

  // 讓 CI / 腳本能靠 exit code 判斷：有任何 bridge 掛掉就非 0。
  const broken = results.filter((r) => r.status === "smoke_failed" || r.status === "version_failed");
  if (broken.length > 0) process.exitCode = 1;
}

// 只有被當成腳本執行時才輸出報告；被 test 匯入時不跑。
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("doctor 執行失敗：", err);
    process.exit(1);
  });
}
