# cheerio-mcp-bridges

四個「窄工具」MCP server，讓一個沒辦法操作終端機 GUI 的 orchestrator agent（例如跑在 Cowork 裡的 Claude）能夠**驅動本機已安裝、已登入的四個 coding CLI**：

| Server | 內部呼叫 | 對外工具 | 語言 |
|--------|----------|----------|------|
| `pi-bridge` | `pi`（earendil-works/pi） | `ask_pi` | Node.js |
| `agy-bridge` | `agy`（Google Antigravity CLI） | `ask_agy` | Node.js |
| `codex-bridge` | `codex`（OpenAI Codex CLI） | `ask_codex` | Node.js |
| `copilot-bridge` | `copilot`（GitHub Copilot CLI） | `ask_copilot` | Node.js |

**四個 bridge 彼此獨立，不需要四個都裝。** 先跑 `npm run doctor` 看這台機器有哪些 CLI 可用，只啟用對應的 bridge 就好。

四個 server 各自暴露**單一、範圍受限**的工具（不是通用 `run_command`）——只能「把一段 prompt 送給那個 agent」。殘餘風險在於底層 CLI 收到 prompt 後自己能做什麼，因此預設姿態偏保守。

## 設計要點

1. **工作目錄由 server 鎖定**：cwd 來自環境變數（`PI_BRIDGE_CWD` / `AGY_BRIDGE_CWD` / `CODEX_BRIDGE_CWD` / `COPILOT_BRIDGE_CWD`），**呼叫端的 prompt 無法變更**。
2. **確定性的 session 續接**：
   - pi：server 自己產生 UUID → `--session-id`（pi 支援「不存在就建立」），第一次呼叫就把 id 回傳；之後帶同一個 id 續接，不依賴「continue 最近一個」的模糊語意。
   - agy：無法預指定 id，第一次跑完從 `--output-format stream-json` 的 `conversation_id` 撈出來回傳；之後用 `--conversation <id>` 續接。
   - codex：第一次跑完從 `thread.started` 事件的 `thread_id` 撈出來回傳；之後用 `codex exec resume <id>` 續接。
   - copilot：server 自己產生 UUID → `--session-id`，第一次呼叫就把 id 回傳；之後帶同一個 id 續接。
3. **零 shell 注入**：四邊都 `shell:false` 直接 spawn，prompt 當作單一 argv 元素，任何 shell 特殊字元都不會被解讀。
4. **保守的權限旗標**：
   - **預設允許讀寫**檔案（符合使用者選擇），但寫入/危險能力仍分段控制。
   - pi 預設**不**帶專案信任 `-a`（`approve_project` 才開）。
   - agy 預設**不**帶 `--dangerously-skip-permissions`；workspace 讀寫自動放行、shell 指令維持 gated，除非 `dangerously_allow_all:true`。
   - codex 預設 sandbox 為 `read-only`（`danger-full-access` 要明確指定）。
   - copilot 預設只帶 `--allow-all-tools`（非互動必要），**不**帶 `--allow-all`（含 paths + urls），後者要 `dangerously_allow_all:true`。
5. **稽核**：每次呼叫寫一行 JSONL 到 `logs/<pi|agy|codex|copilot>-YYYYMMDD.jsonl`（prompt、session/thread id、exit code、耗時、usage）。

## 踩過的坑（實測得出）

- **stdin 必須關閉**：CLI 都會把 piped stdin 當額外 context，Node spawn 預設留一個開著的 stdin pipe 會讓 CLI **卡住等 EOF**。解法：`stdio: ['ignore','pipe','pipe']`。
- **pi extensions 預設關閉**：互動型 extension（如 `auto-annotate`/plannotator）會在 headless 模式**掛住**（等一個永遠不出現的 UI）。因此預設帶 `--no-extensions`，需要時用 `enable_extensions:true` 開回來。
- **codex 必須帶 `--skip-git-repo-check`**：如果 cwd 不是 git repo（例如 `C:/Cheerio`），不帶這個 flag 會直接報錯退出。
- **copilot 非互動模式一定要 `--allow-all-tools`**：文件明確寫了 non-interactive mode 必須帶這個，否則會卡住等使用者確認權限。bridge 預設就帶 `--allow-all-tools`，但 `--allow-all`（含 paths + urls）只在 `dangerously_allow_all:true` 時才開。
- **copilot MCP server 載入很慢**：非互動模式下 copilot 仍然會載入所有 MCP server（playwright、notion、tavily 等），光是啟動就要 10~30 秒。timeout 設太短會在 MCP 載入階段就被 kill。
- **copilot 預設 auto-routing 可能撞 quota**：不指定 model 時，copilot 的 hydra router 會自動選模型（例如 `gpt-5-mini`），如果該模型的配額用完就會直接失敗。建議呼叫端明確指定 model。
- **Copilot/Codex 都無法非互動查詢剩餘總額度**：
  - Copilot：`copilot billing` / `copilot limits` 是 help topic，只在互動模式 UI 裡有用。非互動 CLI 沒有 `copilot usage` 之類的指令。bridge 只能從 `model.call_failure` 事件裡的 `quotaSnapshots` 拿到「這次失敗時的快照」，無法主動查詢剩餘。
  - Codex：`codex login status` 只顯示登入方式（`Logged in using ChatGPT`），沒有用量/配額查詢。`codex doctor` 只做安裝診斷。bridge 的 `turn.completed.usage` 只有當次 token 用量，無剩餘額度。
- **企業級 TLS 攔截 Proxy 可能導致 `npm install` 失敗**：某些組織會使用 TLS 檢查型 Proxy（例如資安廠商的憑證攔截方案）對 HTTPS 流量做中間人解密。這會讓 Node.js 的 TLS 驗證失敗，`npm install` 報 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 或 `certificate chain incomplete` 之類的錯誤。解法：設定環境變數 `NODE_EXTRA_CA_CERTS` 指向公司的完整憑證鏈檔案（PEM 格式），注意需要的是 CA 中繼憑證（intermediate cert），不是只有 leaf cert。
- **GitHub Copilot Enterprise 的 IP allow list 可能阻擋 CLI 存取**：如果你的 GitHub Copilot Enterprise 帳號啟用了 IP allow list，`ask_copilot` 可能會直接被 API 擋下（錯誤訊息類似 "enterprise has an IP allow list enabled, and your IP address is not permitted"）。這跟 bridge / MCP 設定完全無關，需要找 GitHub Enterprise 管理員確認目前的出口 IP 有沒有在白名單，或者是不是需要透過特定 VPN / 公司網路才能使用。

---

## 跨機器安裝（從零開始）

> 四個 bridge 彼此獨立。先跑 `npm run doctor` 看這台機器有哪些 CLI 可用，**只把對應的 bridge 註冊進 MCP client 設定就好**，其他沒裝的不要加。

### 前置需求

- **Node.js** ≥ 18（需要支援 `node:test` 和 ES module）
- **npm** ≥ 9

### Step 1：Clone & 安裝

```bash
git clone https://github.com/CheerioCorner/cheerio-mcp-bridges.git
cd cheerio-mcp-bridges
npm install
```

### Step 2：檢查哪些 CLI 可用

```bash
npm run doctor
```

會輸出一個表格，告訴你 4 支 CLI 各自找到了沒有、能不能正常執行 `--version`，以及建議啟用哪些 bridge。

### Step 3：安裝你需要的 CLI（如果還沒裝）

以下是各 CLI 的安裝與登入方式，**沒裝的跳過就好，不用全部裝**：

#### pi（earendil-works/pi）

```bash
npm install -g @earendil-works/pi-coding-agent
pi   # 首次啟動會引導登入
```

驗證：`pi --version` 或 `pi --help`

#### agy（Google Antigravity CLI）

```bash
# 請參考官方文件安裝，通常是一個獨立執行檔
# https://github.com/nicholasareed/antigravity
agy   # 首次啟動會引導 Google 帳號授權
```

驗證：`agy --version`

#### codex（OpenAI Codex CLI）

```bash
# 請參考 OpenAI 官方文件安裝
# Windows 通常安裝在 %LOCALAPPDATA%/Programs/OpenAI/Codex/
codex login   # 會引導 ChatGPT 帳號授權
```

驗證：`codex --version`、`codex login status`

#### copilot（GitHub Copilot CLI）

```bash
npm install -g @github/copilot-cli
copilot login   # 會引導 GitHub 帳號授權
```

驗證：`copilot --version`

### Step 4：選擇性啟用 bridge

把你需要的 bridge 設定從 `mcp-config.example.json` 複製進你的 MCP client 設定（例如 `~/.mcp.json` 或 `.mcp.json`）。

**不要四個全抄。** 只複製你這台機器有裝且有登入的 CLI 對應的區塊，然後調整路徑與環境變數。

例如你只裝了 pi 和 copilot，就只加 `pi-bridge` 和 `copilot-bridge` 兩個區塊。

### Step 5：驗證 bridge 正常運作

啟動你的 MCP client 後，用對應的工具送一個很小的 prompt 測試：

- `ask_pi`：`{ "prompt": "Reply only: pong" }`
- `ask_agy`：`{ "prompt": "Reply only: pong" }`
- `ask_codex`：`{ "prompt": "Reply only: pong" }`
- `ask_copilot`：`{ "prompt": "Reply only: pong" }`

應該要收到 `pong` 回覆和一行 bridge metadata。如果收到錯誤訊息，檢查：
- CLI 執行檔路徑（環境變數 `*_BRIDGE_ENTRY`）是否正確
- CLI 是否已登入
- cwd 環境變數（`*_BRIDGE_CWD`）是否存在

## 快速開始

```bash
cd C:/Cheerio/Claude/mcp-bridges   # 或你 clone 的路徑
npm install
npm run doctor        # 檢查哪些 CLI 可用
npm test              # 執行 parser/arg-builder 單元測試（不花 API 額度）
```

## 註冊到 MCP client

見 `mcp-config.example.json`。那是一份**菜單**——照你這台機器實際有的 CLI，只挑對應的區塊複製進你的 MCP client 設定（`.mcp.json`），並依實際路徑調整。不是四個都要抄。

## 工具介面

### `ask_pi`
| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `prompt` | string | — | 要送給 pi 的指令（必填） |
| `session_id` | string | 自動產生 | 帶上一次回傳的值即可續接同一對話 |
| `read_only` | boolean | false | true 時只給 `read,grep,find,ls`，禁 edit/write/bash |
| `model` | string | — | 覆寫 model |
| `approve_project` | boolean | false | 是否信任專案本地資源（pi -a） |
| `enable_extensions` | boolean | false | 是否載入 extensions（有掛住風險） |
| `timeout_ms` | number | 300000 | 硬性逾時 |

回傳：pi 的最終文字 + 一行 `pi-bridge metadata`（含 `session_id`）。

### `ask_agy`
| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `prompt` | string | — | 要送給 agy 的指令（必填） |
| `conversation_id` | string | 自動擷取 | 帶上一次回傳的值即可續接 |
| `model` | string | — | model slug（見 `agy models`） |
| `effort` | low\|medium\|high | — | 推理強度 |
| `sandbox` | boolean | false | 開終端沙箱限制（--sandbox） |
| `dangerously_allow_all` | boolean | false | **危險**：自動批准所有工具權限（含 shell） |
| `timeout_ms` | number | 300000 | 硬性逾時（同步作為 agy --print-timeout） |

回傳：agy 的最終回應 + 一行 `agy-bridge metadata`（含 `conversation_id`、`status`）。

### `ask_codex`
| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `prompt` | string | — | 要送給 Codex 的指令（必填） |
| `session_id` | string | 自動產生 | 帶上一次回傳的 thread_id 即可續接 |
| `model` | string | — | 覆寫 model（如 `o3`、`codex-mini`） |
| `sandbox` | read-only\|workspace-write\|danger-full-access | read-only | 沙箱策略 |
| `timeout_ms` | number | 300000 | 硬性逾時 |

回傳：Codex 的最終文字 + 一行 `codex-bridge metadata`（含 `thread_id`、`usage`）。

### `ask_copilot`
| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `prompt` | string | — | 要送給 Copilot 的指令（必填） |
| `session_id` | string | 自動產生 | 帶上一次回傳的值即可續接同一對話 |
| `model` | string | — | 覆寫 model（如 `claude-haiku-4.5`） |
| `effort` | none\|minimal\|low\|medium\|high\|xhigh\|max | — | 推理強度 |
| `max_ai_credits` | number | — | 單次呼叫的花費上限（安全閥） |
| `dangerously_allow_all` | boolean | false | **危險**：加 `--allow-all`（含 paths + urls） |
| `timeout_ms` | number | 300000 | 硬性逾時 |

回傳：Copilot 的最終回應 + 一行 `copilot-bridge metadata`（含 `session_id`、`usage`、`quota_snapshots`）。

> **額度查詢限制**：Copilot CLI 沒有非互動模式的指令能查詢「剩餘總額度」。`copilot billing` / `copilot limits` 只在互動模式的 UI 裡有用。bridge 只能回報「這次呼叫消耗多少」（`usage` + 當次 `quotaSnapshots`），無法回報剩餘總額度。Codex 同理，`codex login status` 只顯示登入狀態，無用量查詢。

## 環境變數

| 變數 | 預設 |
|------|------|
| `PI_BRIDGE_CWD` / `AGY_BRIDGE_CWD` | `C:/Cheerio/pi` |
| `PI_BRIDGE_ENTRY` | pi 的 `dist/cli.js` 全域路徑 |
| `AGY_BRIDGE_ENTRY` | `agy.exe` 路徑 |
| `PI_BRIDGE_TIMEOUT_MS` / `AGY_BRIDGE_TIMEOUT_MS` | `300000` |
| `CODEX_BRIDGE_CWD` | `C:/Cheerio` |
| `CODEX_BRIDGE_ENTRY` | `codex.exe` 路徑 |
| `CODEX_BRIDGE_TIMEOUT_MS` | `300000` |
| `COPILOT_BRIDGE_CWD` | `C:/Cheerio` |
| `COPILOT_BRIDGE_ENTRY` | `copilot.cmd` 路徑 |
| `COPILOT_BRIDGE_TIMEOUT_MS` | `300000` |
| `MCP_BRIDGE_LOG_DIR` | `<repo>/logs` |
