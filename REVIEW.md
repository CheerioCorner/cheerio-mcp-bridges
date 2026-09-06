# 架構檢視 — cheerio-mcp-bridges

- 日期：2026-09-05
- 對象：`feat/claude-bridge-and-per-cli-fixes` 分支的狀態
- 更新：2026-09-06 —— 加入第 8 節（各 CLI 專屬問題）與第 9 節（新增 bridge 的檢查清單）
- **立場：只提建議，這份文件不動任何程式碼。** 每一項都標了嚴重度與粗略成本，
  可以當成之後的 backlog 挑著做。
- 觸發點：2026-09-05 pi-bridge 全面失效 3 小時。那次事故本身已在本分支修掉，
  這份檢視是往外看「同一類問題還埋在哪裡」。

---

## 0. 先講結論

這個 repo 的骨架是對的：`src/` 只做 MCP 註冊、`lib/<cli>.mjs` 只做 argv 與
parse、`lib/<cli>-handler.mjs` 是可測的純函式工廠、`lib/run.mjs` 是唯一的
spawn 出口。四個 bridge 真的彼此獨立，這是刻意的、也值得保留。

問題不在骨架，在**四份幾乎一樣的 handler 各自演化**，以及**好幾條「出事但不
出聲」的路徑**。這次事故的根因（入口路徑）只是導火線，真正的缺陷是 stderr 被
丟掉——同樣的丟法在別的地方還有。

優先做這三件（理由見各節）：

1. **§3.1 `*_BRIDGE_TIMEOUT_MS` 打錯字會讓逾時整個消失** — 一行修好，但後果是無限 hang
2. **§5.1 audit 全域吞例外** — log 目錄設錯時你會完全沒有稽核記錄，而且不知道
3. **§1.2 抽出 handler 的共用骨架** — 這次要改 4 個檔案才修好一個 bug，下次還是

---

## 1. 四個 bridge 的重複程度

### 1.1 現況

| 檔案 | 行數 | 與其他三個的差異 |
|------|------|------------------|
| `lib/pi-handler.mjs` | 194 | 參數名、argv 欄位、metadata 欄位 |
| `lib/agy-handler.mjs` | 191 | 同上 + `sandbox`/`dangerously_allow_all` 預設值邏輯 |
| `lib/codex-handler.mjs` | 184 | 同上 |
| `lib/copilot-handler.mjs` | 192 | 同上 + `quotaSnapshots` |
| `lib/claude-handler.mjs` | ~215 | 同上 + `permission_denials` 與結構化 rate limit |

把 CLI 名稱正規化後 diff，四個 handler 的**控制流完全一樣**：

```
availabilityKey → checkAvailability → (blocked 就 return)
  → try { run() } catch { detectRateLimit(err) → recordBlocked → audit → return }
  → detectRateLimit(result) → recordBlocked | clearBlocked | resetProbeClaimedUntil
  → audit(...)
  → 組 meta → 組 body → return { isError: hadError, content: [...] }
```

差異只有三類：**參數名稱**、**送進 `run()` 的欄位名**、**metadata 的欄位**。

這不是理論上的壞味道，是已經付出過代價的：

- 本次「stderr 被丟掉」的 bug，**四個檔案都有**，所以要改四次
- W-2026-08-086（`hadError` 混入 `timedOut`）的註解，四個檔案各寫了一份，
  而且已經開始**各自漂移**——`pi-handler.mjs:115-120` 是六行版，
  `codex-handler.mjs:109-112` 是四行版，講同一件事
- `truncate()` 在四個檔案裡各定義一次（本次已抽到 `lib/result-text.mjs`）

### 1.2 建議：抽 `createBridgeHandler`（嚴重度：中；成本：中）

```js
// lib/bridge-handler.mjs（示意，不是要照抄）
export function createBridgeHandler({
  cli,                    // "pi" | "agy" | "codex" | "copilot"
  run, audit, availability,
  toRunOptions,           // (mcpArgs) => run() 的參數
  toMeta,                 // (result, ctx) => metadata 物件
  toText,                 // (result) => CLI 自己的答案（pi 用 text，agy 用 response||error）
}) { /* 上面那條控制流，只寫一次 */ }
```

每個 bridge 就只剩三個小函式。判準很簡單：**「修一個共用 bug 要改幾個檔案」
從 4 變成 1。**

**但不建議連 `src/*-bridge.mjs` 一起合併。** 那四個檔案的重複是 zod schema 和
工具描述文字，那些本來就該逐一手寫（描述文字是給 orchestrating agent 讀的，
共用只會讓它變模糊）。而且四個 bridge 各自是獨立進程、獨立安裝——這個獨立性
是產品特性，不要為了 DRY 犧牲。

### 1.3 建議：`lib/<cli>.mjs` 的 `runX()` 也有共用形狀（嚴重度：低；成本：低）

四個 `runX()` 都是「build argv → spawnCapture → parse → 補上 exitCode/timedOut/
hadError/stdout/stderr/durationMs」。最後那段補欄位的邏輯可以抽成
`normaliseRun(res, parsed)`，順便強制四個 CLI 的 `hadError` 定義一致（見 §3.2）。

---

## 2. `lib/` 的職責切分

### 2.1 目前的切法是對的

```
src/<cli>-bridge.mjs   MCP 註冊、zod schema、工具描述        ← 不可測，也不需要測
lib/<cli>.mjs          argv 組裝 + 輸出解析 + runX()         ← 純函式，好測
lib/<cli>-handler.mjs  可注入依賴的 handler 工廠             ← 好測
lib/run.mjs            唯一的 spawn 出口 + env 處理          ← 好測
lib/availability.mjs   跨進程的 CLI 可用性狀態機
lib/rate-limit.mjs     rate-limit 樣式偵測
lib/audit.mjs          稽核 log
```

「handler 工廠與 `lib/<cli>.mjs` 分開，就是為了讓測試不會觸發 top-level
`requireEnv()`」——這個決定寫在每個 handler 的檔頭，是對的，也是這個 repo 最
值得保留的設計。

### 2.2 `lib/<cli>.mjs` 混了兩件事（嚴重度：低；成本：低）

`lib/pi.mjs` 同時是：**純函式模組**（`buildPiArgs`、`parsePiJson`）和
**有副作用的模組**（top-level `requireEnv("PI_BRIDGE_ENTRY")`）。

後果是任何想 import 前者的人，都被迫先設好 env。本次 `scripts/doctor.mjs` 就
是為了避開這件事，才在 `lib/cli-entry.mjs` 裡**重寫了一份 smoke 用的 argv**
（`buildSmokeInvocation`）——也就是說，argv 現在有兩份定義，會漂移。

建議：把 `PI_ENTRY` / `PI_CWD` 的 `requireEnv()` 從 top-level 移進 `runPi()`
（或一個 `getPiConfig()`），純函式就能自由 import。這樣 doctor 可以直接用
`buildPiArgs()`，`buildSmokeInvocation` 就能刪掉。

代價：env 缺失從「MCP server 啟動時就報錯」變成「第一次呼叫時才報錯」。
如果要保留 fail-fast，在 `src/<cli>-bridge.mjs` 頂端明確呼叫一次
`getPiConfig()` 即可——把「什麼時候檢查」的決定權還給 entry point，而不是綁在
import 的副作用上。

### 2.3 `availability.mjs` 444 行，是最大的單一模組（嚴重度：低；成本：中）

它同時做了：檔案鎖、狀態讀寫、TTL 判斷、probe 認領、損毀檔備份。切成
`availability-store.mjs`（IO + 鎖）和 `availability-policy.mjs`（純邏輯：現在
該不該放行、probe 該不該認領）會好測很多——現在 `test/availability.test.mjs`
有 558 行，大半在鋪 IO 的場景。

不急。目前測試涵蓋率夠，先不要為了美觀動它。

---

## 3. 錯誤與逾時語意

### 3.1 🔴 `*_BRIDGE_TIMEOUT_MS` 打錯字，逾時會整個消失（嚴重度：高；成本：一行）

```js
// lib/pi.mjs:6（agy/codex/copilot 同樣寫法）
export const PI_TIMEOUT_MS = Number(process.env.PI_BRIDGE_TIMEOUT_MS || 300000);
```

`PI_BRIDGE_TIMEOUT_MS="5min"` 或 `"300_000"` → `Number()` 得到 `NaN`。
接著在 `lib/run.mjs`：

```js
if (timeoutMs && timeoutMs > 0) { /* 裝 timer */ }
```

`NaN` 是 falsy → **timer 完全沒裝** → 這次呼叫永遠不會逾時。MCP client 就這樣
掛在那裡，沒有任何錯誤訊息。這跟本次事故是同一個病：設定錯了，但系統裝作沒事。

建議：

```js
function requireIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} 不是正整數毫秒數`);
  }
  return n;
}
```

同時在 `spawnCapture` 加一道防線：`timeoutMs` 若非有限正數就 throw，不要靜默
不裝 timer。「沒有逾時」應該是明確寫 `timeoutMs: 0` 才能得到的結果。

### 3.2 四個 CLI 的 `hadError` 定義不一致（嚴重度：中；成本：低）

| CLI | `hadError` 來源 |
|-----|-----------------|
| pi | 任何 `tool_execution_end.isError` \|\| exit≠0 \|\| timeout |
| codex | 解析到 error 事件 \|\| exit≠0 \|\| timeout |
| copilot | `result.exitCode≠0` \|\| `model.call_failure` \|\| `session.error` \|\| exit≠0 \|\| timeout |
| agy | `!ok`（只看 agy 自己回報的 status） |

pi 特別寬：**一個工具呼叫失敗（例如 grep 沒找到）就會讓整次呼叫 `isError:
true`**，即使 pi 最後給了完美答案。對 orchestrating agent 來說，`isError` 是
「要不要重試/換一支 CLI」的訊號，這個定義會造成假警報。

建議把回傳的錯誤語意拆成兩層，四個 bridge 一致：

- `isError`（MCP 層）＝ **這次呼叫沒有給出可用答案**：spawn 失敗、exit≠0、
  逾時、被 availability 擋下。有答案就不該是 error。
- `metadata.had_tool_errors`（資訊層）＝ 過程中有工具失敗，但答案還在。

現在這兩件事被折在同一個 boolean 裡，跟 W-2026-08-086 折 `timedOut` 是同一種
錯誤。那次已經在 handler 裡「攤開」給 `detectRateLimit` 用了
（`pi-handler.mjs:121-128`），但 `isError` 這條路還是折著的。

### 3.3 逾時語意：我們的 timeout 和 CLI 自己的 timeout 沒有統一（嚴重度：低）

- agy：`buildAgyArgs` 會把 `--print-timeout` 設成比我們的硬 kill 早 5 秒
  （`lib/agy.mjs:36`），這樣能拿到乾淨的 result 事件。**這是對的做法。**
- pi / codex / copilot：沒有對應設定，時間到就直接砍。

`lib/copilot.mjs:17` 的 JSDoc 甚至留著「`Used to derive --print-timeout? No,
copilot doesn't have one.`」——這是註解在自問自答，應該去查證後寫成結論。

建議：查一輪四支 CLI 有沒有各自的逾時旗標，有的就照 agy 的模式設成
「我們的硬 kill 減 5 秒」，並在 README 寫清楚「軟逾時 vs 硬 kill」的分工。

### 3.4 逾時後的孤兒進程（本次已修，但只修了一半）

`lib/run.mjs` 現在用 `taskkill /T /F` 殺整棵樹。**但 `scripts/doctor.mjs` 的
`runWithTimeout()` 還是 `child.kill("SIGTERM")`。** doctor 的 smoke test 會真的
跑起完整的 CLI（包含 pi 的 server / session-worker 子進程），逾時的話一樣會留
孤兒。

建議：doctor 改用 `lib/run.mjs` 的 `spawnCapture` / `killProcessTree`。目前沒
共用是因為 `spawnCapture` 不支援 `shell:true`（`.cmd` shim 需要）——把
`shell` 開成 `spawnCapture` 的選項就能收斂成一條路徑。

---

## 4. env 變數契約

### 4.1 現況（本次已改善）

`requireEnv()` 的設計是對的，理由也寫在 `lib/run.mjs:3-16`：路徑本來就因機器
而異，埋 fallback 只會讓設錯的人以為自己設對了。本次把 `scripts/doctor.mjs`
最後一處硬寫死的 `C:/Users/User/...` 也拔掉了。

### 4.2 契約沒有集中定義的地方（嚴重度：中；成本：低）

現在要知道「這個 repo 吃哪些 env」，得同時看四個 `lib/<cli>.mjs` 的 top-level、
`lib/audit.mjs:17`、`lib/run.mjs:67`、`scripts/doctor.mjs`、README 的表格，以及
`mcp-config.example.json`。**已經漂移過**：README 的 env 表格在本次修正前還寫著
`PI_BRIDGE_CWD` 預設是 `C:/Cheerio/pi`，但那個預設早在 commit `410156e` 就被
拿掉了。

建議做一個 `lib/env.mjs` 當單一事實來源：

```js
export const ENV_CONTRACT = {
  PI_BRIDGE_ENTRY:   { required: true,  kind: "path",
                       note: "必須是套件 package.json bin 指向的檔案" },
  PI_BRIDGE_CWD:     { required: true,  kind: "dir" },
  PI_BRIDGE_TIMEOUT_MS: { required: false, kind: "posInt", default: 300000 },
  BRIDGE_BYPASS_PROXY:  { required: false, kind: "bool",   default: true },
  // ...
};
```

`requireEnv` / `requireIntEnv` 從這張表驗；doctor 從這張表印；README 的表格用
腳本從這張表產（或加個測試檢查兩邊一致）。

### 4.3 `*_BRIDGE_CWD` 沒有驗證存在（嚴重度：中；成本：低）

`requireEnv("PI_BRIDGE_CWD")` 只檢查「有沒有設」，不檢查「這個目錄在不在」。
設成一個打錯字的路徑 → bridge 啟動成功 → 每次 `spawn` 都 `ENOENT` → handler
的 catch 回「Failed to launch pi: ...」。比靜默好，但完全可以在啟動時就擋掉。

建議：`*_BRIDGE_CWD` 在啟動時 `stat()` 一次，不是目錄就報錯。
`*_BRIDGE_ENTRY` 同理（本次 doctor 已經會檢查，但 bridge 本身還沒有）。

### 4.4 `BRIDGE_BYPASS_PROXY` 的布林解析太寬鬆（嚴重度：低）

只有字串 `"false"` 會關閉，其他一律當開啟——包含 `"0"`、`"no"`、`"False"`。
`lib/run.mjs:67` 有註解說明這是刻意的，測試也蓋到了
（`test/run.test.mjs:100`），但使用者不會讀原始碼。至少 README 要寫「只有
小寫的 `false` 有效」，或者放寬成常見的假值集合。

---

## 5. 其他「靜默失敗」的路徑

這節是本次事故的直接延伸：**還有哪裡是「出事了但沒人會知道」。**

### 5.1 🔴 audit 吞掉所有例外（嚴重度：高；成本：低）

```js
// lib/audit.mjs:23
} catch {
  // never throw from the audit path
}
```

「稽核不能弄掛工具呼叫」是對的。但現在的寫法是：`MCP_BRIDGE_LOG_DIR` 設到一個
沒有寫入權限的路徑 → **每一筆稽核記錄都靜靜消失，永遠**。等到要查事故的時候
才發現 log 目錄是空的——而那正是最需要它的時刻。

建議：保持不 throw，但**第一次失敗時往 stderr 印一行警告**（之後靜音，避免洗
版）。MCP server 的 stderr 會進 client 的日誌，看得到。

```js
let auditWarned = false;
} catch (err) {
  if (!auditWarned) {
    auditWarned = true;
    console.error(`[audit] 寫入失敗，稽核記錄將遺失：${err.message}`);
  }
}
```

### 5.2 🟡 NDJSON parser 靜默丟掉解析不了的行（嚴重度：中；成本：低）

```js
// lib/pi.mjs:56、lib/codex.mjs:58
} catch {
  continue; // ignore any non-JSON noise
}
```

現在很合理：CLI 會在 NDJSON 中間夾雜警告文字。但如果 CLI **改了輸出格式**
（升版最常見的破壞方式），結果會是：所有行都解析失敗 → `text` 是空字串 →
exit code 還是 0 → 使用者看到「(pi returned no text)」，而 stdout 裡其實有滿滿
的答案。

本次修的 stderr 邏輯**擋不住這種**（因為 exit code 是 0）。

建議：統計丟掉的行數，放進 metadata：

```js
if (unparsedLines > 0 && !text) {
  // 有輸出但一行都解析不出來 → 幾乎肯定是格式變了
}
```
metadata 加 `unparsed_lines`，`text` 為空且 `unparsed_lines > 0` 時，把前幾行
原始 stdout 一起回傳。判準跟 §5 一樣：**不要在有證據的時候說「沒有輸出」。**

### 5.3 🟡 `availability.json` 損毀後靜默降級（嚴重度：中；成本：低）

`readStateSafe()`（`lib/availability.mjs:126-133`）在 JSON 壞掉時回
`{ _corrupt: true }`。後續流程會備份並重建——邏輯是對的，但**使用者不會知道**
自己的 rate-limit 狀態被重置了，可能因此連續打爆一支已經被 429 的 CLI。

建議：同 §5.1，往 stderr 印一次，並在該次呼叫的 metadata 裡標
`availability_state_reset: true`。

### 5.4 🟡 `logs/` 與 `state/` 用 repo 相對路徑（嚴重度：低）

`lib/audit.mjs:6` 和 `lib/availability.mjs:23` 都用 `join(__dir, "..")`。也就是
說**同一台機器上 clone 兩份 repo，就會有兩套獨立的 availability 狀態**，而
`availability.mjs` 的跨進程鎖是設計來讓四個 bridge 共用一份狀態的。

`MCP_BRIDGE_LOG_DIR` 已經可以覆寫 log 路徑，但 state 沒有對應的環境變數。

建議：加 `MCP_BRIDGE_STATE_DIR`，並在 README 說明「四個 bridge 要指到同一個
state 目錄，rate-limit 狀態才會共用」。

### 5.5 🟢 proxy strip 沒有任何痕跡（嚴重度：低）

`buildChildEnv()` 預設會拿掉子進程的 `HTTP_PROXY` 等變數。這在企業網路裡是必要
的，但如果某天某支 CLI **需要** proxy 才能出去，症狀會是「連不上，而且看不出
為什麼」。

建議：第一次 strip 時往 stderr 印一行（列出被拿掉的變數名，不印值）。

### 5.6 🟢 `resetProbeClaimedUntil` 失敗會靜默（嚴重度：低）

四個 handler 都 `await` 這些 availability 寫入，但沒有任何一個檢查結果。寫入
失敗（例如鎖搶不到）時 probe 認領不會釋放，下一個請求要多等一個完整視窗。
不致命，但值得在 metadata 裡留個 `availability_write_failed`。

---

## 6. 建議的優先順序

| # | 項目 | 嚴重度 | 成本 | 節 |
|---|------|--------|------|-----|
| 1 | `*_BRIDGE_TIMEOUT_MS` 打錯字 → 逾時消失 | 🔴 高 | 極低 | §3.1 |
| 2 | audit 吞例外 → 事故時沒有 log | 🔴 高 | 低 | §5.1 |
| 3 | doctor 的 timeout 也要殺進程樹 | 🟡 中 | 低 | §3.4 |
| 4 | `*_BRIDGE_CWD` / `ENTRY` 啟動時驗證存在 | 🟡 中 | 低 | §4.3 |
| 5 | NDJSON 全數解析失敗要出聲 | 🟡 中 | 低 | §5.2 |
| 6 | `isError` 與 `had_tool_errors` 拆開 | 🟡 中 | 中 | §3.2 |
| 7 | `ENV_CONTRACT` 單一事實來源 | 🟡 中 | 低 | §4.2 |
| 8 | 抽 `createBridgeHandler` | 🟡 中 | 中 | §1.2 |
| 9 | `requireEnv` 移出 top-level，doctor 共用 argv | 🟢 低 | 中 | §2.2 |
| 10 | `MCP_BRIDGE_STATE_DIR` | 🟢 低 | 低 | §5.4 |
| 11 | copilot 補唯讀模式（需在有 copilot 的機器實測） | 🟡 中 | 中 | §8.3 |
| 12 | 五支的預設安全姿態對齊成一個明確決定 | 🟡 中 | 低 | §8.4 |
| 13 | agy 逾時時救回部分回應 | 🟡 中 | 低 | §8.5 |
| 14 | `tools_used` 型別統一 | 🟡 中 | 低 | §8.6 |
| 15 | 驗證 codex 真實的錯誤事件名稱 | 🟡 中 | 低 | §8.7 |

1 到 5 加起來大概是一個下午，而且都是「讓失敗會出聲」這一類，跟這次事故是同一
個主題。6 到 8 是結構性的，建議排在同一次重構裡做，不要零散地改四個檔案。

---

## 8. 各 CLI 專屬的問題（2026-09-06 新增）

第 1～7 節講的是共用層。這一節是**單一 CLI 自己的**問題 —— 四份 handler 各自演化的直接後果。
標 ✅ 的已經在本分支修掉了，其餘是建議。

### 8.1 ✅ codex / copilot 會回傳 CLI 從來不知道的 session id

```js
// 修正前，lib/codex-handler.mjs 與 lib/copilot-handler.mjs 同樣寫法
const threadId = session_id || randomUUID();   // 憑空生一個
...
sessionId: session_id || undefined,            // 但不傳給 CLI
...
thread_id: result.threadId || threadId,        // 回傳時卻拿它當 fallback
```

CLI 正常時會回報真的 id，看不出問題。但 CLI **在宣告 session 之前就掛掉**時
（也就是 2026-09-05 那種形狀），fallback 生效，呼叫端拿到一個不存在的 id，
`codex exec resume <假id>` 從此永遠失敗。

規則寫下來：**回傳的 id 只能是 CLI 認可過的、或呼叫端自己給的。**
agy 本來就對；pi 也對，因為它把生成的 UUID 真的用 `--session-id` 傳給了 pi；
claude 同理（`--session-id` 可以指定，實測有效）。只有 codex 和 copilot 兩支違反。
見 `test/session-id.test.mjs`。

### 8.2 ✅ agy 的 `--print-timeout` 算式在短逾時下是反的

```js
const secs = Math.max(30, Math.floor((timeoutMs || AGY_TIMEOUT_MS) / 1000) - 5);
```

這個 flag 存在的目的是「agy 先放棄並吐出乾淨的 `result` 事件，而不是被我們砍掉」。
所以不變量只有一條：**agy 的軟逾時必須嚴格早於我們的硬 kill。**
但 `Math.max(30, ...)` 讓每個 35 秒以下的 budget 都違反它 —— 傳 `timeout_ms: 20000`
會得到 30 秒的軟逾時對上 20 秒的硬 kill，於是每次都被砍，正好是這個 flag 想避免的事。
下限保護錯了那一端。

### 8.3 🟡 copilot 是唯一沒有唯讀模式的

`--allow-all-tools` 在 `lib/copilot.mjs` 是無條件加的。pi 有 `read_only`、
codex 有 `sandbox`、agy 有 `sandbox`、claude 有 `read_only` / `allow_edits`，
只有 copilot 沒有任何辦法限制。

工具描述有誠實寫「非互動模式需要 `--allow-all-tools`（自動加上）」，所以不是隱瞞。
但如果 copilot CLI 支援 `--deny-tool` 之類的旗標，值得補一個 `read_only` 參數把介面補齊。
**需要在有 copilot 的機器上實測才能確定做不做得到** —— 不要照著文件猜。

### 8.4 🟡 五支的預設安全姿態應該是一個決定，不是四次意外

| CLI | 預設 | 誰決定的 |
|---|---|---|
| codex | `-s read-only` | handler `sandbox \|\| "read-only"` |
| claude | 讀可以、寫自動拒絕 | 本次刻意設計 |
| pi | 可讀寫，不跳過權限 | pi 自己的預設 |
| copilot | `--allow-all-tools` 永遠開 | 無條件 |
| agy | `--sandbox` **＋ `--dangerously-skip-permissions`** | `!== false` 預設開 |

agy 那個「自動核准所有工具權限」的預設是四支裡最寬的，而且是用
`if (dangerouslyAllowAll !== false)` 這種預設開啟的寫法達成的。它有被記在工具描述裡
（為了避免 headless CANCELED/ERROR，見 commit `b5d9cf7`），所以是有理由的 ——
但這個理由應該和其他四支放在一起比較過。

建議：定一條全 repo 的規則（例如「預設唯讀，寫入要明講」），能做到的就對齊，
做不到的（agy 可能真的需要）在工具描述裡寫清楚為什麼是例外。

### 8.5 🟡 agy 逾時就一定丟掉部分回應

`parseAgyStream` 只從 `result` 事件取 `response`。逾時被砍時沒有 `result` 事件，
於是 `response` 一定是空字串 —— 即使 `step_update` 已經串流出半個答案。

claude-bridge 遇到同樣情境會退回去把 assistant 的 text blocks 接起來
（`parseClaudeStream` 的 `sawResultEvent`）。agy 可以照做。

### 8.6 🟡 `tools_used` 同一個欄位兩種型別

pi 和 claude 給字串陣列（`["Read","Grep"]`），agy 給物件陣列
（`[{type,state,info}]`）。對 orchestrating agent 來說這是同一個 metadata 欄位。
建議統一成字串陣列，細節放另一個欄位。

### 8.7 🟡 codex 的錯誤事件名稱沒有驗證過

`parseCodexJson` 的 switch 裡有 `thread.failed` 和 `error`，但檔案自己的註解
列出的「real output」事件只有 `thread.started` / `turn.started` / `item.completed` /
`turn.completed` 四個。如果 codex 不是這樣報錯，串流層的錯誤就完全漏掉，
只剩 exit code 擋著。應該在有 codex 的機器上實際觸發一次錯誤，把真實事件名寫進註解。

### 8.8 🟡 copilot 的 text_delta / message 順序相依

`assistant.text_delta` 是**累加**、`assistant.message` 是**覆蓋**。
哪個先到會決定最終結果。如果某個版本先送 `assistant.message` 再繼續送 deltas，
輸出就會壞掉，而且是靜默壞掉（看起來只是答案怪怪的）。
建議明確定義優先序，並在 `test/copilot-fixtures.mjs` 加一個兩者交錯的 fixture。

### 8.9 🟢 其他小東西

- `lib/codex.mjs` 的 JSDoc 還留著 `@param {number} [o.cwdIndex] Not used`。
- `lib/copilot.mjs` 的 JSDoc 留著自問自答：`Used to derive --print-timeout? No, copilot doesn't have one.` —— 查證過就寫成結論。
- copilot 的 `quotaSnapshots` 只在 `model.call_failure` 抓，所以只有失敗時看得到額度。

---

## 9. 新增一支 bridge 時的檢查清單

claude-bridge 是第五支。做的過程中發現，前四支的問題大多是「沒有人把同一份清單走完」。
把它寫下來，下一支就不用重新踩：

1. **入口是什麼**：JS 腳本（要 `node`）還是原生執行檔？以套件 `package.json` 的 `bin` 為準。
   claude 是 `bin/claude.exe`，原生執行檔。
2. **prompt 怎麼傳**：是某個旗標的值，還是位置參數？claude 的 `-p` 是布林旗標，
   prompt 是位置參數，所以必須放最後並用 `--` 分隔 —— 否則 dash 開頭的 prompt 會被當旗標。
   **這件事一定要用真的以 `--` 開頭的 prompt 實測。**
3. **stdin**：會不會等 EOF？（claude 會等 3 秒才放棄。）`stdio:['ignore',...]` 一律要有。
4. **session id**：CLI 給、還是我們可以指定？不能指定就**絕對不要偽造**（見 §8.1）。
5. **錯誤訊號**：哪個欄位才是真的？claude 的 `subtype` 在 API 錯誤時還是 `"success"`，
   要看 `is_error` / `api_error_status`。**用一個一定會失敗的呼叫實測，不要看文件。**
6. **靜默失敗**：有沒有「exit 0、沒有錯誤、但事情沒發生」的路徑？
   claude 的 `permission_denials` 就是 —— 被拒絕的寫入不算錯誤，回應還會說改好了。
7. **rate limit**：有沒有結構化訊號？claude 有 `rate_limit_event`（含精確 `resetsAt`）。
   有的話優先用，比字串比對可靠得多。**但要看清楚是哪個欄位** ——
   健康帳號的事件裡 `status:"allowed"` 和 `overageStatus:"rejected"` 是並存的。
8. **會不會遞迴載入自己**：CLI 會不會讀使用者的 MCP 設定？claude 會，
   所以固定帶 `--strict-mcp-config`。
9. **關客製化的旗標會不會順便關掉認證**：claude 的 `--bare` 會 ——
   它只吃 `ANTHROPIC_API_KEY`／`apiKeyHelper`，不讀 OAuth，訂閱制登入直接失敗。
   要用 `--safe-mode`。
10. **doctor**：加進 `CLIS`，並在 `lib/cli-entry.mjs` 補 smoke invocation。

---

## 7. 一句話總結

這次的教訓不是「pi 改版了」，而是**「所有證據都在手上，程式卻選擇不說」**。
`spawnCapture` 抓到了 stderr、`result.stderr` 拿得到、`ERR_MODULE_NOT_FOUND` 就
在裡面——然後 `(result.text || "(pi returned no text)")` 把它丟了。

上面每一條 🔴🟡 都是同一個形狀：**有錯誤，但沒有出口。** 建議往後 review 的時候
就用這個問題當檢查點：*這段 catch / fallback / 預設值，出事的時候誰會知道？*
