# 進度與設計備忘

## 完成狀態
- [x] 01 骨架:測試台與一般文字對話(71 項測試,在假的 GAS 世界中通過)
- [x] 02 回覆格式化(累計 88 項測試通過)
- [x] 03 時間感知(累計 102 項測試通過)
- [x] 04 搜尋加固(累計 157 項測試通過)
- [x] 05 圖片先傳後問(累計 183 項測試通過)
- [x] 06 群組(累計 204 項測試通過)
- [x] 07 記憶(累計 277 項測試通過)
- [x] 08 生圖(累計 321 項測試通過)
- [x] 08a 生圖改存專用 Drive 資料夾(2026-11-09,累計 330 項測試通過;詳見文末「第 08a 張」)

執行測試:`npm test`(Node 22,零依賴,`node:test` + `vm`)。

## 架構
- `src/*.js`:GAS 全域函式(檔名數字決定載入順序,無載入時相依)。`src/appsscript.json` 為清單(clasp `rootDir: src`)。
- `test/world.js`:假的 GAS 世界。每次 `w.post()` 建立全新 vm context(像 GAS 每次執行),世界狀態(試算表/快取/屬性/時鐘/請求紀錄)跨請求共用。`Date.now()` / `new Date()` 在 vm 內會丟錯,強制使用 `Clock`。
- 併發以 `w.beforeGemini` 鉤子模擬:A 呼叫模型期間,B 完整處理完。
- 儲存:Users(白名單,整張快取)/ State(每聊天室一列,分塊)/ Logs(批次寫)。熱請求 0 讀;冷請求 ≤2 讀;全程 `setValues`,無 `appendRow`;所有寫入在全域鎖內。
- 狀態分塊:每塊 ≤40,000 字元、加前綴 `~`(避免被試算表誤判為數字/公式);事件/歷史各自分塊;狀態 >90KB 不進快取。
- 鎖內讀取最新狀態:`loadChatLocked`(快取沒命中時不信請求開頭的表格快照)。

## spec 沒寫到、自行決定的細節(最後要列入完成說明)
- 錯誤句對應:429/5xx 重試後仍失敗→「太忙」;網路例外/逾時/預算不足→「逾時」;400 等其他→一般錯誤;安全擋下→「被擋下」。
- 單次 Gemini 呼叫上限 `GEMINI_CALL_CAP_S=40`;重試退避 1 秒,退避後須仍剩 ≥3 秒才重試。
- 出錯的回合不寫入歷史(沿用原程式行為)。
- reply 失敗的 push 補送只用於白名單內的聊天室(陌生人不 push);push 用量記在 State 的 `_system` 列的 meta,跨月(依 TIMEZONE)重置。
- 缺金鑰/設定值不合法的狀態日誌每小時最多一筆(快取限頻);BAD_KEY 每 10 分鐘最多一筆;STRANGER 同一 ID 每小時一筆。
- 空白設定值視為未設定(用預設、不算問題)。
- 缺 Gemini 金鑰時回固定說明「機器人還沒設定完成,請聯絡管理員。」
- Users 表「啟用」欄空白視為停用。
- `setupSheets()` 維護函式在 `src/95_maintenance.js`。

## 測試方法備註
- 突變檢查:曾手動破壞重試/金鑰標頭/快取/去重/分塊/鎖內重讀等,測試皆會轉紅。
- 發現並修正的真實 bug:鎖內快取沒命中時使用過期表格快照會覆蓋他人剛寫入的回合(現有兩項測試守住)。

## 第 02 張補充(格式化)
- `src/75_format.js`:`markdownToPlain`(程式碼先收起再轉換;標題/清單「・」/表格/引用/分隔線/連結「文字(網址)」/粗斜體/刪除線)、`splitText_`(自然邊界優先序:段落 > 換行 > 句尾 > 空白 > 硬切,且不採用落在前 30% 的邊界)、`buildReplyMessages(text, images)`(文字在前圖片在後,一次 reply 最多 5 則,圖片佔名額)。
- 歷史保存「使用者實際看到的純文字」(已轉換),避免把 Markdown 餵回模型。
- 純文字轉換後為空時回「(沒有內容)」保底。
- 截斷標示 `…(內容過長)` 會佔用最後一則的字數額度(該則仍 ≤5000 字)。

## 第 03 張補充(時間感知)
- `src/80_prompt.js`:`periodOfDay_` / `gapLevel_` / `formatGap_` / `buildTimeBlock_`。時間區塊取代 01 的單行日期;含日期、星期、HH:mm、時段、時區名稱、與上一則訊息(`chat.lastAt`)的間隔與分級(格式 `約 N 分鐘〔接續〕。` + 一句行為提示)。第一次對話標明「第一次對話」。
- 分級邊界(固定值):<30 分 接續;<6 小時 隔了一陣子;<24 小時 過了半天以上;<7 天 隔了好幾天;其餘 很久沒聊。與 `GAP_MARKER_MINUTES` 無關。
- 間隔格式:<1 分「不到 1 分鐘」;分鐘/小時/天皆無條件捨去;≥60 天改以「個月」(天數 /30 捨去)。
- 註記「(距上一句約 …)」只加在**使用者**訊息、相對於前一則(任何角色)的時間戳;存回狀態的是原文。(模型訊息不加;第 04 張工具迴圈讓一個回合可超過 1 分鐘,對應測試已補。)
- 時區非 Asia/Taipei 時,時區標示改用 TIMEZONE 名稱。

## 第 04 張補充(搜尋加固)
- 檔案:`62_websafety.js`(清洗/注入警報/網址白名單/資料區塊,純函式)、`63_searchintent.js`(明令搜尋比對、`cleanQuery_`)、`64_tinyfish.js`(請求建構與回應解析)、`65_tools.js`(工具宣告、並行執行、`runChatTurn` 迴圈)。
- 流程:`runChatTurn` →(明令搜尋:先搜尋,把結果區塊接在 system prompt 後,計為 1 個工具輪)→ 模型 → 若要求函式:全部規劃成請求,**一次 fetchAll** 送出 → 逐一解讀 → functionResponse(帶回呼叫 ID,模型該輪 parts 原樣放回)→ 下一輪。
- 強制作答(`toolConfig.mode=NONE`):工具輪數 ≥ `MAX_TOOL_TURNS` 或剩餘預算 < `MIN_TURN_S`。強制輪模型仍只要函式 → 回「一般錯誤」句。`MAX_TOOL_TURNS=0` 或沒有 `TINYFISH_API_KEY` → 不宣告工具、提示詞不提搜尋、明令搜尋也不執行。
- 讀網頁白名單:URL 必須「在本輪(同一請求)搜尋結果中(已通過清洗/封鎖/注入過濾者)」且 `plainPublicHttps_`(https、公開網域、埠 443、無帳密、非 IP〔含十進位/十六進位縮寫〕、非 localhost/.local/.internal/.lan/.home.arpa/.localhost、須有點)且不在 `SEARCH_BLOCKED_DOMAINS`。上一個請求的網址不能讀。
- `web_fetch` 與深入模式都是:TinyFish 讀頁 → 清洗並截 4000 字 → **輔助模型(無人設、不帶工具)**摘要 → 清洗並截 500 字 → 包在同一個一次性標記內回給模型。失敗:深入模式記 `DEEP_FETCH_FAILED`(狀態)並只用搜尋摘要;`web_fetch` 回工具錯誤。
- 日誌(狀態):`SEARCH_FAILED`(HTTP 狀態/EXC/unreadable/budget,不含查詢)、`SEARCH_INJECTION_DROPPED`(只記網域)、`FETCH_FAILED`、`DEEP_FETCH_FAILED`。
- 汙染回合:有取得任何網頁內容(搜尋有可用結果或讀頁成功)→ 該回合**模型回覆那一筆**歷史標記 `p:1` 與 `q:[查詢…]`(最多 5 筆、各 ≤100 字,供第 07 張做佔位文字)。搜尋失敗/無結果的回合不算汙染。
- 自行決定(spec 未寫):同一輪最多執行 4 個函式呼叫(超過回工具錯誤);查詢字串須 ≥2 字;TinyFish 單次上限(搜尋 15 秒/讀頁 25 秒,同樣受剩餘預算限制);搜尋失敗不重試。
- 與參考實作的差異:HTML 標籤只認「`<` 後接字母、`/` 或 `!`」(避免 `3 < 5 且 7 > 2` 被整段吃掉);注入警報句型 `systemprompt` 需接 is 或冒號(參考實作相同)。
- 測試台新增:TinyFish 路由與預設結果、`g.call/g.calls`(含 thoughtSignature 等 extra 欄位)。

## 第 05 張補充(圖片先傳後問,一對一)
- 待提問圖片存在 State 該聊天室列的 `meta.pending = [{id, ts}]`(不存位元組);傳圖時用寫入階段記下,丟掉已過期並保留最新 `IMAGE_PENDING_MAX` 個。傳圖的 reply「收到,想問什麼?」不呼叫 AI;**ack 不用 push 補送**(自行決定:節省 push 預算),但即使 reply 失敗圖片仍被記下。
- 文字進來:`validPending_`(`現在 − ts ≤ IMAGE_PENDING_TTL_S`,剛好 600 秒仍算)→ `fetchPendingImages_`:**一次 fetchAll** 向 `api-data.line.me/v2/bot/message/{id}/content` 下載(Bearer、`timeoutSeconds ≤ min(20, 剩餘預算−保留)`)→ `inlineData`(圖片在前、文字在後)。mime 取自 Content-Type(缺少時 jpeg;非 jpeg/png/webp/gif/heic/heif → 視為無法取得)。大小取 Content-Length 與實際位元組數的較大者,`> 10MB`(10×1024×1024)略過並告知。
- 告知方式:回覆文字後附「(附註:N 張圖片無法取得;M 張圖片超過 10MB,已略過,這次沒有參考到。)」,同時在 system prompt 末尾告知模型看不到圖、不要假裝看過。附註只出現在 reply,不存進歷史。
- 提交時只清掉「這次處理過的」與「已過期的」待提問圖片(回答期間才到的新圖保留)。模型呼叫失敗的回合不提交、不消耗待提問圖片,使用者重問仍會帶圖。下載失敗/過大者視為已消耗(使用者需重傳)。
- 歷史前綴「[圖片] 」只在**至少一張圖成功帶上**時加(存進歷史);當前回合送給模型的文字不帶前綴;system prompt 說明該前綴只是標記。
- 傳圖不算對話:不更新 `lastAt`(不影響與上一則訊息的間隔)。不在白名單的人傳圖 → 與傳文字相同的「尚未開通」。
- 已知限制:`Http.fetchAll` 若發生網路層例外,整批視為失敗(HTTP 錯誤碼則逐張處理)。未限制單次請求內嵌圖片的總大小(Gemini 內嵌請求有約 20MB 的總量上限;3 張各近 10MB 會失敗,屬極端情況)。
- 測試台新增:LINE 內容 API 路由(`w.images[id]` 可自訂狀態/位元組/標頭)、`w.ev.image`、`Utilities.base64Encode`、二進位回應。

## 第 06 張補充(群組)
- `src/53_mention.js`:`isSelfMentioned_`(只看 `message.mention.mentionees[].isSelf === true`,文字裡寫 @Bot 不算)、`stripSelfMentions_`(依 index/length 以 UTF-16 移除;該段不是以 `@` 開頭時改以碼位再試一次,都對不上就不動;只收斂空格/Tab/全形空白,保留換行)。
- `chatOfSource_`:`user`→`{id:userId, kind:'user'}`;`group`→groupId、`room`→roomId,兩者 kind 皆為 `'group'`(State 的 kind 欄存 `group`)。
- 順序:型別檢查 → **群組文字沒 @ 直接丟棄**(不去重、不查白名單、不寫任何東西)→ 去重 → 白名單 → 路由。群組圖片沒有提及資訊,所以會去重並查白名單。
- 白名單(`isRegistered_`):一對一須 Users 表種類 `user`;群組型須種類 `group` 或 `room`(種類寫錯不算已登記)。群組內任何成員被 @ 都可用(不查個人)。
- 未登記群組:被 @ → 「此群組尚未開通,群組 ID 是 C…」(同樣記限頻 STRANGER 日誌);沒被 @ → 靜默;傳圖 → 完全忽略。已登記群組傳圖 → 不回覆、靜默記入待提問圖片(沿用第 05 張的 TTL / 張數上限 / 下載 / 前綴)。
- 只有 @ 沒有內容(去掉 @ 後為空)→ 靜默忽略(自行決定:不呼叫模型、不回覆)。
- 群組 system prompt 多一句「這是多人群組的共用對話,你不知道每則訊息是誰說的…」;不記發送者(spec 明列「以個別發送者區分的群組記憶」為不做)。
- reply 失敗 push 補送對象為群組 ID(沿用 push 預算)。
- `/忘記` 在群組內需發送者在 Users 內:第 07 張處理(目前 `ectx` 尚未帶 senderId,第 07 張再加)。
- 迴歸教訓:替換程式區段時誤刪 `NOT_CONFIGURED_REPLY` 常數,被既有的「缺 Gemini 金鑰」測試抓到(ReferenceError 被最外層攔成 UNHANDLED 日誌)。

## 第 07 張補充(記憶)
- 檔案:`66_memory.js`(純函式:bigram/檢索/整理結果驗證/常駐區塊)、`67_memorystore.js`(facts 編碼、Events/Archive 讀寫、快取)、`68_commands.js`(`/記憶` `/忘記`)、`69_fold.js`(整理)、`70_recall.js`(常駐注入與檢索)。
- **資料位置**:facts 存在 State 該聊天室列的 `facts` 欄(JSON:`{使用者, 共同經歷, 待跟進, 更早的摘要}`,值為「- 」開頭的行);State 的 `meta.folds` 記整理次數。Events 表 `[chat_id, date, time(空), kind(事件), text]`;Archive 表 `[chat_id, ts(ms), role(u/m), text, polluted(0/1)]`。
- **整理流程(與 spec 的差異點在於「單一寫入階段」)**:回合結束 → `sendReply` → `planFold_`(原文輪數 > `HISTORY_MAX_TURNS`、剩餘預算 ≥ `MIN_TURN_S`、沒有 `fold:<chat>` 旗標〔TTL 120 秒〕)→ 輔助模型呼叫(不持鎖;`responseMimeType=application/json` + `responseJsonSchema`;`maxOutputTokens` 固定 4096,不受對話用的上限限制)→ **同一個寫入階段**:取鎖 → 重讀最新狀態 → 附加本回合 → 驗證 State 最舊的原文仍是當初整理的那些(否則 `FOLD_STALE` 作廢)→ 依序寫 Archive、Events → 更新 State(facts、history、meta.folds)→ 一次批次寫日誌。因此一個請求至多一個寫入階段(含整理)。
- 整理一次取最舊 `min(FOLD_BATCH_TURNS, 輪數−1)` 輪(至少留 1 輪原文)。驗證:`normalizeFold_`(缺區段/型別錯 → 作廢 `FOLD_INVALID`;事件 ≤10 筆、≤80 字、日期須是真實日曆日期否則用該批第一則的日期);既有事實會被全部清空 → `FOLD_ERASE_REJECTED`;新事實總長 > `LONG_TERM_MAX_CHARS` → `FOLD_OVER_LIMIT`(保留舊事實、事件照記、進度前進);模型省略「更早的摘要」→ 沿用舊的。模型呼叫失敗 → `FOLD_FAILED`。以上任一情況不影響對話,下一次請求重試。
- State 的原文安全上限:整理一直失敗時最多保留 `HISTORY_MAX_TURNS × 3` 輪(`HISTORY_CAP_DROP` 狀態日誌);記憶關閉(`MEMORY_ENABLED=false`)時只留 `HISTORY_MAX_TURNS` 輪並不整理。送給模型的原文窗口永遠只有最近 `HISTORY_MAX_TURNS` 輪。
- 汙染回合:整理時該回合的回覆換成佔位文字(「(那天查過:X、Y;網頁內容未納入)」或「(那天用到網頁內容;網頁內容未納入)」),Archive 寫的也是佔位文字且 `polluted=1`;檢索語料排除汙染回覆。
- 檢索:`loadMemoryData_` 讀 Events(整張)與 Archive(只讀最近 `ARCHIVE_SCAN_LIMIT` 列),過濾該聊天室,**歸檔每筆截 300 字**後整包放快取 `mem:<chat>`(>90KB 不放快取、每次讀表);整理成功或 `/忘記` 時失效。**從未整理過的聊天室(`meta.folds` 為 0)完全不讀 Events/Archive**。冷路徑:使用者、狀態、事件、歸檔四次讀取連續發生 = 1 個讀取階段(測試以「彼此相連的讀取」計為一個階段)。
- `/記憶`、`/忘記`:嚴格比對(只容許前後空白);`/忘記 確認` 也可當作確認。確認旗標以「聊天室 + 發送者」為鍵(群組內別人輸入只是自己的第一次);群組需發送者在 Users 內(含種類 `user`)。清空 = State 列整列寫空白(列保留)、Events/Archive 整張讀出過濾後覆寫並 `deleteRows` 尾端、清快取;`_system` 列不動。指令的回覆不用 push 補送、不寫歷史、不更新 `lastAt`。
- **安全補強**:Archive、Events 兩張表建立時設為純文字格式(使用者內容以 `=` 開頭不會變公式、日期字串不會被轉成日期);讀取時日期欄若是 Date 物件也能處理,數字欄一律 `Number()`。測試台的假試算表會在非純文字表寫入 `=+-@` 開頭的字串時直接丟錯。
- 與 spec/參考實作的差異:`leftOutFactLines_` 改為依位置而非內容比對(內容重複的行不會被誤判已顯示);沒有「角色自己」區段(spec 無人設)。
- 檢索標籤:歸檔/State 的舊訊息標為「更早的對話·使用者」「更早的對話·我」,事件標「日誌」,事實行標「長期記憶」。
- 測試台新增:操作時間線(`w.ops`/`w.readPhases()`)、`w.setState/addEvents/addArchive`、純文字格式防護。

## 第 08 張補充(生圖)與收尾
- 檔案:`71_image.js`(純函式 `imageKind_`/`imageUrl_`/`driveImageUrls_`、可用性 `imageStatus_`、Cloudflare `cfGenerate_`、Drive `saveToDrive_`、`runImageCall_`、鎖內 `applyImageEffects_`/`trashExpiredImages_`);`65_tools.js` 的 `declaredTools_` 依「當下可用」宣告 `generate_image`;`95_maintenance.js` 的 `checkImageUrls`、`smokeTest`、`refreshUsersCache`。
- 狀態:額度/冷卻/封鎖在 State 的 `_system` 列 `meta.image = {day(UTC), n, lastAt, blockedUntil}`;暫停(5035/5007/5004)用快取 `img:pause`(TTL 6 小時);`_system` 不存在時做負向快取。
- Cloudflare:POST `…/accounts/{id}/ai/run/@cf/black-forest-labs/{model}`,Bearer 標頭,GAS 物件 payload(`prompt/width/height` 為字串)。成功 = HTTP <400 且 `success===true` 且有 `result.image` 且檔頭是 JPEG/PNG。錯誤碼:3036 額度用盡(封鎖到下個 UTC 00:00)、5035/5007/5004 暫停 6 小時、3040/3007 預算足夠才重試一次、3006 提示詞太長、其他回報 HTTP 狀態與錯誤代碼。
- 圖片網址:主格式 `lh3.googleusercontent.com/d/{id}`;預覽圖超過 1MB(>1,000,000 位元組)改用備援 `drive.google.com/thumbnail?id={id}&sz=w1000`;`uc?export=view` 不使用(有測試守住)。
- 生圖不依賴搜尋(沒有 TINYFISH 金鑰也能生圖,反之亦然);沒有搜尋金鑰時搜尋函式呼叫回工具錯誤、明令搜尋不執行。
- 全部 8 張完成。最終交付物:`linebot-gas-final.zip`(程式碼、測試、`src/appsscript.json`、`.clasp.json.template`、`docs/DEPLOY.md`、`docs/MANUAL-ACCEPTANCE.md`、`docs/COMPLETION-NOTES.md`)。

## 第 08a 張補充(生圖專用 Drive 資料夾,2026-11-09)
- 動機:原本 `DriveApp.createFile` 把圖片與健檢測試檔都丟在 Drive 根目錄。改為只在使用者指定的資料夾內建立與清理。
- 設定:新增 `IMAGE_DRIVE_FOLDER_ID`(`CONFIG_SPEC`,`re` 型別 `DRIVE_ID_RE`,預設空字串)。**未設定或格式不合 = 生圖視為未啟用**(`imageConfigured_` 要求它),不宣告 `generate_image`、不呼叫 Cloudflare,避免先花掉額度才在 Drive 失敗;`IMAGE_ENABLED=true` 卻缺少時記 `KEY_MISSING`,格式不合記 `CONFIG_RANGE`。
- `71_image.js`:新增 `imageDriveFolderId_`(只讀 `rc.cfg`,不再直接讀 Script Properties,不做根目錄回退)、`imageDriveFolder_`(`getFolderById` + 驗證)、`imageFileInFolder_`(以 `getParents()` 確認檔案在資料夾內);`saveToDrive_(bytes, kind, nowMs, rc)` 改用資料夾的 `createFile`;`trashExpiredImages_` 只處理在資料夾內的檔案,不在內的(舊版根目錄遺留檔)跳過且不標記已處理;檔案已不存在/無法存取仍沿用舊行為標記已處理。
- `95_maintenance.js`:`checkImageUrls` 的測試檔也建在該資料夾;未設定資料夾直接回報失敗。
- 測試台:`DriveApp` 假物件新增 `getFolderById`、檔案 `getParents`,並以 `w.drive.rootCreates` 偵測是否有人又呼叫根目錄 `createFile`。新增 6 項測試(建於資料夾、未設定停用、格式不合、資料夾不存在、只清理資料夾內檔案、健檢),既有測試與設定預設值表同步調整。
- 已知取捨:升級前遺留在根目錄的舊圖不會被自動清理(見 DEPLOY.md「從舊版升級」);這些列會在每次成功生圖的清理中被重新檢查(各 2 次 Drive 呼叫),數量以升級前的總張數為上限,不會繼續增加。
