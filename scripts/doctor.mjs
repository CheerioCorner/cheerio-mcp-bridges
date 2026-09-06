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
 * 執行一個帶逾時的指令，回傳 { ok, stdout, stderr, output, exitCode }。
 * ok 的定義刻意嚴格：exit code 必須是 0。
 */
function runWithTimeout({ command, args, shell }, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: !!shell,
        windowsHide: true,
        env: buildChildEnv(),
      });
    } catch (err) {
      return resolve({ ok: false, stdout: "", stderr: String(err), output: `(spawn error) ${err}`, exitCode: null, durationMs: 0 });
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      done({ ok: false, stdout, stderr, output: "(timeout)", exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, stdout, stderr, output: (stdout + stderr).trim(), exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, stdout, stderr, output: `(spawn error) ${err.message}`, exitCode: null });
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

  // ── 真正的 smoke test：跑完整條路徑 ────────────────────────────────────────
  const smokeRes = await runWithTimeout(buildSmokeInvocation(cli.name, resolved.path), {
    timeoutMs: SMOKE_TIMEOUT_MS,
    cwd,
  });
  const producedOutput = !!smokeRes.stdout.trim();

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
        console.log(`      通常是入口檔本身壞掉（相依沒裝）或尚未登入：${r.loginHint}`);
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
