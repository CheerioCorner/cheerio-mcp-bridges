#!/usr/bin/env node
/**
 * doctor.mjs — 輕量檢查本機 4 支 CLI 的可用性，輔助判斷要啟用哪些 bridge。
 *
 * 用法：npm run doctor
 * 不花 API 額度，不做真實呼叫。
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { buildChildEnv } from "../lib/run.mjs";

// ── CLI 設定 ─────────────────────────────────────────────────────────────────
// 每個 CLI 的預設 ENTRY 路徑（與 lib/*.mjs 對齊），用 env override 也可以。
const CLIS = [
  {
    name: "pi",
    bridge: "pi-bridge",
    tool: "ask_pi",
    // pi 是用 node 執行 js 檔，所以要判斷的是那個 .js 檔案
    entry:
      process.env.PI_BRIDGE_ENTRY ||
      "C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    // 也可以用 `where pi` 找全域安裝
    altCheck: "pi",
    versionCmd: ["--version"],
    installHint: "npm install -g @earendil-works/pi-coding-agent",
    loginHint: "pi 會在第一次啟動時引導登入",
  },
  {
    name: "agy",
    bridge: "agy-bridge",
    tool: "ask_agy",
    entry: process.env.AGY_BRIDGE_ENTRY || "C:/Users/User/AppData/Local/agy/bin/agy.exe",
    altCheck: "agy",
    versionCmd: ["--version"],
    installHint: "請參考 https://github.com/nicholasareed/antigravity 安裝",
    loginHint: "agy login（會引導 Google 帳號授權）",
  },
  {
    name: "codex",
    bridge: "codex-bridge",
    tool: "ask_codex",
    entry:
      process.env.CODEX_BRIDGE_ENTRY ||
      "C:/Users/User/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe",
    altCheck: "codex",
    versionCmd: ["--version"],
    installHint: "請參考 https://github.com/nicholasareed/codex 或 OpenAI 官方文件安裝",
    loginHint: "codex login（會引導 ChatGPT 帳號授權）",
  },
  {
    name: "copilot",
    bridge: "copilot-bridge",
    tool: "ask_copilot",
    entry: process.env.COPILOT_BRIDGE_ENTRY || "C:/Users/User/AppData/Roaming/npm/copilot.cmd",
    altCheck: "copilot",
    versionCmd: ["--version"],
    installHint: "npm install -g @github/copilot-cli",
    loginHint: "copilot login（會引導 GitHub 帳號授權）",
  },
];

// ── 工具函式 ─────────────────────────────────────────────────────────────────

/**
 * 檢查檔案是否存在。
 */
async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 where/which 找 command 在 PATH 上的位置。
 */
function whereCommand(cmd) {
  const isWin = process.platform === "win32";
  const bin = isWin ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(bin, [cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: buildChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        const lines = stdout.trim().split(/\r?\n/);
        // On Windows, prefer .cmd files (they work with shell:true)
        if (process.platform === "win32") {
          const cmdFile = lines.find((l) => /\.cmd$/i.test(l));
          if (cmdFile) return resolve(cmdFile);
        }
        resolve(lines[0]);
      } else {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * 執行一個帶逾時的指令，回傳 stdout。用來跑 --version。
 */
function runWithTimeout(cmd, args, timeoutMs = 8000) {
  // Windows .cmd files need shell:true to execute via cmd.exe.
  // When shell:true, normalize backslashes to forward slashes so cmd.exe
  // doesn't eat them (DEP0190 / path mangling).
  const needsShell = process.platform === "win32" && /\.cmd$/i.test(cmd);
  const execCmd = needsShell ? cmd.replace(/\\/g, "/") : cmd;
  return new Promise((resolve) => {
    const child = spawn(execCmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
      env: buildChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      resolve({ ok: false, output: "(timeout)", durationMs: timeoutMs });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      resolve({ ok: code === 0, output, durationMs: 0 });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: "(spawn error)", durationMs: 0 });
    });
  });
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  cheerio-mcp-bridges doctor — CLI 可用性檢查               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const results = [];

  for (const cli of CLIS) {
    const entryExists = await fileExists(cli.entry);
    const altPath = await whereCommand(cli.altCheck);
    const found = entryExists || !!altPath;
    const foundVia = entryExists ? "ENTRY path" : altPath ? "PATH (${cli.altCheck})" : null;

    let version = null;
    let reachable = false;

    if (found) {
      const checkCmd = altPath || cli.entry;
      const r = await runWithTimeout(checkCmd, cli.versionCmd, 8000);
      if (r.ok) {
        reachable = true;
        version = r.output.split("\n")[0].slice(0, 80);
      } else {
        version = r.output.slice(0, 80) || "(version check failed or requires login)";
      }
    }

    results.push({ ...cli, found, foundVia, reachable, version, altPath });
  }

  // 輸出表格
  const colW = { cli: 10, bridge: 18, status: 10, version: 40 };
  const sep = "─".repeat(colW.cli + colW.bridge + colW.status + colW.version + 9);

  console.log(
    `  ${"CLI".padEnd(colW.cli)} │ ${"Bridge".padEnd(colW.bridge)} │ ${"Status".padEnd(colW.status)} │ ${"Version / Note".padEnd(colW.version)}`
  );
  console.log(`  ${sep}`);

  for (const r of results) {
    let status, note;
    if (!r.found) {
      status = "❌ 未找到";
      note = `安裝：${r.installHint}`;
    } else if (r.reachable) {
      status = "✅ 可用";
      note = r.version || "(ok)";
    } else {
      status = "⚠️  找到但…";
      note = r.version || "可能需要登入或版本不支援 --version";
    }
    console.log(
      `  ${r.name.padEnd(colW.cli)} │ ${r.bridge.padEnd(colW.bridge)} │ ${status.padEnd(colW.status)} │ ${note.slice(0, colW.version)}`
    );
  }

  console.log();
  console.log("── 建議 ──────────────────────────────────────────────────────");
  const available = results.filter((r) => r.found && r.reachable);
  const unavailable = results.filter((r) => !r.found || !r.reachable);

  if (available.length > 0) {
    console.log(`  這台機器可以啟用 ${available.length} 個 bridge：`);
    for (const r of available) {
      console.log(`    ✓ ${r.bridge}（工具：${r.tool}）`);
    }
  }
  if (unavailable.length > 0) {
    console.log(`  以下 ${unavailable.length} 個 bridge 不建議啟用：`);
    for (const r of unavailable) {
      const reason = !r.found ? "執行檔未找到" : "執行檔找到但版本檢查失敗";
      console.log(`    ✗ ${r.bridge} — ${reason}`);
      console.log(`      安裝：${r.installHint}`);
      console.log(`      登入：${r.loginHint}`);
    }
  }

  console.log();
  console.log("  請把上面「可以啟用」的 bridge 區塊，從 mcp-config.example.json");
  console.log("  複製進你的 MCP client 設定（.mcp.json），並調整路徑與環境變數。");
  console.log("  沒裝的 CLI 對應的 bridge 不要加，加了會在啟動時報錯。");
  console.log();
}

main().catch((err) => {
  console.error("doctor 執行失敗：", err);
  process.exit(1);
});
