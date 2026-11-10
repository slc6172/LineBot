# 設定與部署說明

本專案是純 JavaScript(V8)的 Google Apps Script,用 clasp 推送。程式碼在 `src/`,測試在 `test/`(Node 內建測試執行器,零依賴)。

> **誠實聲明**:全部 330 項測試都是在「假的 GAS 世界」(Node `vm` + 假的 LINE / Gemini / TinyFish / Cloudflare / Google 服務)中通過的,沒有在真實環境跑過。請務必照 `MANUAL-ACCEPTANCE.md` 在真實環境驗收。

## 1. 準備

1. 建立一份 Google 試算表,記下網址中的 **試算表 ID**(`/d/` 與 `/edit` 之間那段)。
2. 取得各服務金鑰:LINE Messaging API 的 Channel access token(長期)、Gemini API 金鑰;選用:TinyFish(搜尋)、Cloudflare(生圖:API Token 需有 Workers AI 權限,以及 Account ID)。
3. (要啟用生圖時)在 Google Drive 建立一個**專用資料夾**(例如「linebot-images」),記下網址中 `/folders/` 之後那段 **資料夾 ID**(只填 ID,不要貼整段網址)。這個資料夾必須由「部署者帳號」(網頁應用程式以該帳號執行)擁有或可編輯。程式只會在這個資料夾內建立與清理圖片,**不會再把檔案放到 Drive 根目錄**。
4. 自訂一個 **`WEBHOOK_KEY`**(隨機字串,建議 24 字以上;只用英數字與 `-_`,避免網址編碼問題)。

## 2. 推送程式碼

```bash
npm i -g @google/clasp
clasp login
cp .clasp.json.template .clasp.json     # 填入 scriptId(Apps Script 專案的「專案設定」頁可找到)
clasp push                              # rootDir 是 src/,會一併推送 src/appsscript.json
```

`src/appsscript.json` 已設定時區 `Asia/Taipei`、執行環境 V8、授權範圍 `spreadsheets`、`drive`、`script.external_request`,以及網頁應用程式(以我的身分執行、所有人可存取)。

## 3. Script Properties(專案設定 → 指令碼屬性)

**必填**

| 屬性 | 說明 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE channel access token |
| `GEMINI_API_KEY` | Gemini API 金鑰 |
| `WEBHOOK_KEY` | Webhook 網址的密鑰(沒設定時所有請求都會被拒絕) |
| `SPREADSHEET_ID` | 試算表 ID |

**選填金鑰**(缺少時該功能自動停用,Logs 會記一筆 `KEY_MISSING`,其他功能不受影響)

| 屬性 | 啟用的功能 |
|---|---|
| `TINYFISH_API_KEY` | 搜尋與讀網頁 |
| `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`IMAGE_DRIVE_FOLDER_ID`、並設 `IMAGE_ENABLED=true` | 生圖(四項缺一就視為停用;`IMAGE_ENABLED=true` 但缺少其中之一,Logs 會記 `KEY_MISSING` 並在 detail 指出缺哪一項) |

金鑰前後夾帶空白或換行會自動去除。**金鑰不會出現在日誌、錯誤訊息、回覆或請求網址中**(Gemini 與 TinyFish 走標頭、Cloudflare 走 Bearer 標頭)。

**其他設定**(全部可省略,使用預設值;值超出範圍時改用預設值並在 Logs 記一筆 `CONFIG_RANGE`)

| 屬性 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | 字串(格式受限) | 對話用的模型名稱 |
| `GEMINI_MODEL_AUX` | `(同 GEMINI_MODEL)` | 字串(格式受限) | 輔助模型(整理記憶、摘要網頁);預設同 GEMINI_MODEL |
| `THINKING_LEVEL` | `low` | minimal / low / medium / high | 思考深度:minimal / low / medium / high |
| `MAX_OUTPUT_TOKENS` | `1024` | 64 – 8192 的整數 | 對話回覆的輸出 token 上限 |
| `TIME_BUDGET_S` | `60` | 10 – 240 | 每個事件的時間預算(秒);Apps Script 單次執行上限 6 分鐘 |
| `BUDGET_RESERVE_S` | `5` | 1 – 30 | 預算內保留給回覆與寫入的秒數 |
| `MIN_TURN_S` | `12` | 1 – 60 | 剩餘預算低於此值就不再開新的工具輪(強制作答) |
| `MAX_TOOL_TURNS` | `3` | 0 – 6 的整數 | 一個回合最多幾輪工具(搜尋/生圖);0 = 不宣告任何工具 |
| `HISTORY_MAX_TURNS` | `20` | 1 – 100 的整數 | 送給模型的原文窗口輪數;State 中未整理的原文超過此數就觸發整理 |
| `FOLD_BATCH_TURNS` | `10` | 1 – 50 的整數 | 每次整理最舊的幾輪(至少留 1 輪原文) |
| `MEMORY_ENABLED` | `true` | true / false | 長期記憶總開關(關閉時只保留最近 HISTORY_MAX_TURNS 輪原文) |
| `LONG_TERM_MAX_CHARS` | `2000` | 200 – 10000 的整數 | 長期事實常駐區塊與整理結果的字數上限 |
| `RECENT_NOTES_MAX_CHARS` | `600` | 0 – 3000 的整數 | 今天、昨天日誌各自常駐的字數上限 |
| `RETRIEVAL_K` | `3` | 0 – 10 的整數 | 每次最多檢索幾筆舊片段(0 = 關閉檢索) |
| `RETRIEVAL_SNIPPET_CHARS` | `200` | 20 – 1000 的整數 | 每筆檢索片段的字數 |
| `RETRIEVAL_MIN_MESSAGE_CHARS` | `3` | 1 – 20 的整數 | 短於此字數的訊息不檢索 |
| `RETRIEVAL_MIN_SCORE` | `0.6` | 0 – 5 | 檢索分數門檻 |
| `ARCHIVE_SCAN_LIMIT` | `5000` | 0 – 50000 的整數 | 檢索時掃描歸檔表最近幾列 |
| `SEARCH_MAX_RESULTS` | `5` | 1 – 10 的整數 | 每次搜尋取前幾筆結果 |
| `SEARCH_LOCATION` | `TW` | 字串(格式受限) | 搜尋地區(兩個大寫字母) |
| `SEARCH_LANGUAGE` | `zh` | 字串(格式受限) | 搜尋語言(兩到三個小寫字母) |
| `SEARCH_BLOCKED_DOMAINS` | `(空)` | 逗號分隔清單 | 封鎖的網域(逗號分隔,含子網域) |
| `IMAGE_ENABLED` | `false` | true / false | 生圖總開關(還需要 CF_API_TOKEN、CF_ACCOUNT_ID 與 IMAGE_DRIVE_FOLDER_ID) |
| `IMAGE_DRIVE_FOLDER_ID` | `(空)` | Drive 資料夾 ID(英數字、`-`、`_`,10–100 字元) | 生圖專用資料夾。圖片與健檢測試檔都只建立在此;保留期清理也只處理此資料夾內的檔案。**未設定 = 生圖停用**(不會退回根目錄);格式不合(例如貼成整段網址)會記 `CONFIG_RANGE` 並同樣停用 |
| `CF_IMAGE_MODEL` | `flux-2-klein-9b` | 字串(格式受限) | Cloudflare Workers AI 的 black-forest-labs 模型名稱 |
| `IMAGE_WIDTH` | `576` | 256 – 2048 的整數 | 生圖寬度(像素) |
| `IMAGE_HEIGHT` | `1024` | 256 – 2048 的整數 | 生圖高度(像素) |
| `IMAGE_MAX_PER_DAY` | `6` | 0 – 1000 的整數 | 全域每日(UTC)生圖張數上限;0 = 等同停用 |
| `IMAGE_COOLDOWN_S` | `30` | 0 – 3600 的整數 | 全域兩次生圖之間的最短間隔(秒) |
| `IMAGE_MIN_BUDGET_S` | `20` | 1 – 120 | 剩餘預算低於此值不開始生圖 |
| `IMAGE_RETENTION_DAYS` | `30` | 1 – 3650 的整數 | 生成圖片在 Drive 保留幾天(成功生圖時順便清理,一次至多 5 個;只清理 `IMAGE_DRIVE_FOLDER_ID` 資料夾內的檔案) |
| `IMAGE_PENDING_TTL_S` | `600` | 30 – 3600 的整數 | 先傳圖後提問的有效秒數 |
| `IMAGE_PENDING_MAX` | `3` | 1 – 10 的整數 | 最多暫存幾張待提問圖片 |
| `USERS_CACHE_TTL_S` | `300` | 1 – 21600 的整數 | 白名單快取秒數(Users 表異動最多延後這麼久生效) |
| `FORGET_CONFIRM_TTL_S` | `60` | 5 – 600 的整數 | /忘記 二次確認的有效秒數 |
| `GAP_MARKER_MINUTES` | `30` | 1 – 1440 的整數 | 使用者訊息與前一句相隔達此分鐘數,送給模型時加「(距上一句約…)」註記 |
| `TIMEZONE` | `Asia/Taipei` | 字串(格式受限) | 時區(影響時間感知與日誌日期) |
| `PUSH_MONTHLY_BUDGET` | `0` | 0 – 100000 的整數 | reply 失敗時用 push 補送的每月上限(0 = 不 push) |
| `LOG_MAX_ROWS` | `1000` | 50 – 100000 的整數 | Logs 表保留列數(超過約 100 列緩衝後刪最舊的) |
| `DEBUG_TIMING` | `false` | true / false | 記錄各儲存操作與外部呼叫耗時(除錯等級日誌) |

## 4. 建立試算表的各張表

在 Apps Script 編輯器選擇函式 **`setupSheets`** 執行(第一次會要求授權,見下節)。它會建立缺少的表並加好標題列,已存在的不動。

| 表 | 欄位 | 說明 |
|---|---|---|
| `Users` | `id`、`kind`、`note`、`enabled`、`added_at` | 白名單。**由你手動維護**。`kind`:一對一填 `user`;群組或多人聊天室填 `group`(寫 `room` 也可)。`enabled` 填 `TRUE` 才啟用(空白視為停用)。 |
| `State` | `chat_id`、`kind`、`updated_at`、`last_at`、`meta`、`facts_chunks`、`history_chunks`、之後是分塊 | 每個聊天室一列(含一列 `_system` 存全域計數:push 用量、生圖額度)。內容超過單格 50,000 字元會自動分塊,**請勿手動編輯**。 |
| `Archive` | `chat_id`、`ts`、`role`、`text`、`polluted` | 被整理掉的原文歸檔(純文字格式)。 |
| `Events` | `chat_id`、`date`、`time`、`kind`、`text` | 整理出的日誌事件(純文字格式)。 |
| `Images` | `file_id`、`created_at`、`trashed` | 生成圖片的 Drive 檔案 ID,用於保留期清理。清理前會確認檔案確實位於 `IMAGE_DRIVE_FOLDER_ID` 資料夾內,不在其中的檔案一律不動。 |
| `Logs` | `time`、`level`、`code`、`chat_id`、`detail` | 錯誤與狀態日誌(`錯誤`/`狀態`/`除錯`)。只記代碼與結構化欄位,**不含使用者訊息、模型回覆或金鑰**。 |

## 5. 授權與「重新部署新版本」(重要)

1. 在編輯器手動執行一次 `setupSheets`,依畫面授權(試算表、Drive、外部請求)。**授權範圍有變動後(例如第一次加入 Drive 權限),必須重新授權。**
2. 執行 **`smokeTest`**,確認回傳 `ok: true`(檢查正規表示式 lookbehind、`\p{L}`、時區格式化等 Apps Script V8 的執行期相容性)。
3. **部署 → 新增部署作業 → 網頁應用程式**:執行身分選「我」,存取權選「所有人」。取得 `https://script.google.com/macros/s/<部署ID>/exec`。
4. **之後每次改程式碼**:`clasp push` 之後,到「部署 → 管理部署作業 → 編輯(鉛筆)→ 版本:新版本 → 部署」。**只存檔或只 push 不會讓網頁應用程式生效**,這是最常見的踩雷點。

### 從舊版升級(圖片原本存在 Drive 根目錄)

1. 建立專用資料夾、設定 `IMAGE_DRIVE_FOLDER_ID`(見 §1、§3),`clasp push` 後依本節第 4 點(上方)重新部署新版本。授權範圍不變(仍是 `drive`),不需要重新授權。
2. **升級前就已產生、留在根目錄(或其他資料夾)的舊圖不會被自動清理**:保留期清理只處理專用資料夾內的檔案,看到不在資料夾內的列會跳過(`Images` 表的 `trashed` 維持 0)。請自行到 Drive 刪除這些舊檔(檔名格式 `img-<時間戳>.jpg/.png`、`healthcheck-<時間戳>.png`),或把它們移進專用資料夾後交給程式清理。
3. 沒設定 `IMAGE_DRIVE_FOLDER_ID` 就升級也不會出事:生圖會自動停用(不會呼叫 Cloudflare,機器人也不會宣稱能畫圖),Logs 會記 `KEY_MISSING`。
4. 換用新的資料夾時,舊資料夾內尚未過期的圖不會再被自動清理(同樣自行處理)。

## 6. LINE 後台

1. LINE Developers → 你的 Messaging API channel →「Messaging API」分頁。
2. Webhook URL 設為 `https://script.google.com/macros/s/<部署ID>/exec?k=<WEBHOOK_KEY>`(**一定要帶 `?k=`**),按 **Verify** 應顯示成功。
3. 開啟「Use webhook」;關閉「Auto-reply messages」與「Greeting messages」。
4. (群組)開啟「Allow bot to join group chats」。

## 7. 加入使用者與群組

- **使用者**:請對方傳一則訊息給機器人,會收到「尚未開通。你的 ID 是 U…」。把這個 ID 填進 `Users` 表(`kind` = `user`、`enabled` = `TRUE`)。
- **群組**:把機器人加進群組後,在群組內 **@機器人** 說一句話,會收到「此群組尚未開通,群組 ID 是 C…」。把這個 ID 填進 `Users` 表(`kind` = `group`、`enabled` = `TRUE`)。群組內沒有 @ 機器人的訊息一律完全忽略。群組內任何成員被 @ 都可使用;但群組內的 `/忘記` 需要發送者本人也在 `Users` 表內。
- 異動最多延後 `USERS_CACHE_TTL_S`(預設 300 秒)生效;想立刻生效請在編輯器執行 **`refreshUsersCache`**。
- 停用:把 `enabled` 改成 `FALSE`(同樣會有快取延遲)。

## 8. 使用者指令

| 指令 | 作用 |
|---|---|
| `/記憶` | 顯示這個聊天室目前的長期記憶與日誌事件數量 |
| `/忘記` | 第一次回覆確認說明;在 `FORGET_CONFIRM_TTL_S` 秒內再輸入一次 `/忘記`(或 `/忘記 確認`)才會清空這個聊天室的記憶與對話歷史(物理刪除 Archive 與 Events 中的列) |

指令須文字完全符合(容許前後空白)。

## 9. 維護函式(在編輯器手動執行)

| 函式 | 用途 |
|---|---|
| `setupSheets` | 建立缺少的表與標題列 |
| `smokeTest` | 部署後確認 Apps Script 執行期相容性 |
| `checkImageUrls` | 圖片網址健檢:在 `IMAGE_DRIVE_FOLDER_ID` 資料夾內建立測試圖(用完即丟垃圾桶;未設定資料夾會直接回報失敗),以主格式(`lh3.googleusercontent.com/d/{id}`)與備援格式(`drive.google.com/thumbnail?id={id}&sz=w1000`)各抓一次。這兩種格式是 Google 未正式承諾的行為,建議設成每週的時間驅動觸發,並在 LINE 手機上實際確認圖片會顯示。 |
| `refreshUsersCache` | 清除白名單快取,Users 表異動立即生效 |

## 10. 日誌代碼速查(Logs 表)

| 等級 | 代碼 | 意義 |
|---|---|---|
| 錯誤 | `LOCK_TIMEOUT` | 30 秒內取不到鎖;這回合沒存進狀態(reply 仍已送出) |
| 錯誤 | `COMMIT_FAILED` | 寫入階段發生例外 |
| 錯誤 | `UNHANDLED` | 未預期的例外(只記例外類型) |
| 錯誤 | `LINE_REPLY_FAILED` / `LINE_PUSH_FAILED` | LINE 回覆/補送失敗(附 HTTP 狀態與 LINE 回應的 message 欄位) |
| 錯誤 | `GEMINI_FAILED` | Gemini 呼叫失敗(非限流、非擋下) |
| 錯誤 | `IMAGE_FAILED` / `IMAGE_PAUSED` / `IMAGE_DRIVE_FAILED` | 生圖失敗 / 因設定錯誤暫停 6 小時 / Drive 無法儲存或分享(含 `IMAGE_DRIVE_FOLDER_ID` 的資料夾不存在或沒有權限) |
| 錯誤 | `STATE_CORRUPT` / `USERS_SHEET_MISSING` | State 內容無法解析 / 缺少 Users 表 |
| 狀態 | `BAD_KEY` / `BAD_BODY` / `STRANGER` | 網址密鑰錯誤 / 請求內容無法解析 / 不在白名單的使用者或群組嘗試(皆為限頻記錄) |
| 狀態 | `KEY_MISSING` / `CONFIG_RANGE` | 缺少金鑰或必要設定(含 `IMAGE_DRIVE_FOLDER_ID`)/ 設定值超出範圍或格式不合(每小時最多記一次) |
| 狀態 | `GEMINI_RETRY` / `GEMINI_RATE_LIMIT` / `GEMINI_BLOCKED` / `GEMINI_MAX_TOKENS` | 重試 / 限流 / 被安全機制擋下 / 回覆因長度上限被截斷 |
| 狀態 | `SEARCH_FAILED` / `SEARCH_INJECTION_DROPPED` / `FETCH_FAILED` / `DEEP_FETCH_FAILED` | 搜尋或讀頁失敗 / 搜尋結果因注入警報被丟棄(只記網域)/ 讀頁失敗 / 深入模式失敗 |
| 狀態 | `FOLD_FAILED` / `FOLD_INVALID` / `FOLD_ERASE_REJECTED` / `FOLD_OVER_LIMIT` / `FOLD_STALE` | 記憶整理:模型失敗 / 回應不合法 / 會清空既有事實而不採信 / 新事實超過上限(保留舊事實)/ 整理期間狀態已變動而作廢 |
| 狀態 | `HISTORY_CAP_DROP` | 整理一直失敗,最舊的原文被丟掉(安全上限) |
| 狀態 | `IMAGE_QUOTA_EXHAUSTED` / `IMAGE_BUSY` / `IMAGE_TIMEOUT` | Cloudflare 當日額度用盡 / 暫時沒容量 / 逾時 |
| 狀態 | `PUSH_BUDGET_EXHAUSTED` / `EVENT_LOOP_TIMEOUT` | push 月預算用完 / 單次執行超過 270 秒而略過剩餘事件 |
| 除錯 | `TIMING` | `DEBUG_TIMING=true` 時各儲存操作與外部呼叫的耗時 |

## 11. 開發

```bash
npm test      # 330 項測試,Node 22,零依賴
```

測試只從 `doPost` 進去(搭配假的 GAS 世界),只有純函式(清洗、網址白名單、檢索評分、Markdown 轉換與分段、整理結果驗證等)直接單元測試。假的世界會計算試算表呼叫次數、擋 50,000 字元單格上限、擋使用者內容被當成公式、強制所有時間都走 `Clock`。
