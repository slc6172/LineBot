# LINE Bot (Google Apps Script)

純 JavaScript(V8)的 LINE 機器人,跑在 Google Apps Script 上,不需要自己的伺服器。

## 功能

- **Gemini 對話**:繁體中文、口語化、適合 LINE 閱讀,並具時間感知(早晚問候、隔多久沒聊)。
- **搜尋與讀網頁**(TinyFish):模型自行判斷何時上網;網頁內容先清洗、由沒有角色設定的輔助模型整理成要點,並以一次性隨機標記包起來,降低提示詞注入風險。
- **圖片先傳後問**:一對一先傳圖、再問問題;群組內不回應圖片以免洗版。
- **群組**:只有被 @ 的文字訊息才會處理;群組與使用者以白名單(Google 試算表)控管。
- **分層長期記憶**:近期對話、日誌事件與長期事實;`/記憶` 查看、`/忘記` 清空(需二次確認)。用到網頁內容的回合不會寫進長期記憶。
- **生圖**(選用,Cloudflare Workers AI):有每日額度與冷卻,圖片存在你指定的 Google Drive 專用資料夾(`IMAGE_DRIVE_FOLDER_ID`)並定期回收。

## 架構

```
src/    GAS 程式碼(檔名數字決定載入順序;src/appsscript.json 為清單)
test/   測試:假的 GAS 世界(world.js)+ node:test,零依賴
docs/   部署、驗收與完成說明
```

資料存在 Google 試算表(`Users` / `State` / `Archive` / `Events` / `Images` / `Logs`)與 Apps Script 快取;所有寫入都在全域鎖內進行。

## 快速開始

1. 複製 `.clasp.json.template` 為 `.clasp.json`,填入你的 Apps Script `scriptId`(此檔已被 `.gitignore` 排除)。
2. 用 [clasp](https://github.com/google/clasp) 推送 `src/`,在 Apps Script 的「指令碼屬性」設定金鑰與 `WEBHOOK_KEY`。
3. 部署為 Web App,把 `https://script.google.com/macros/s/<部署ID>/exec?k=<WEBHOOK_KEY>` 設為 LINE 的 Webhook URL。

完整步驟、所有設定項目與維護函式請見 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 測試

```bash
npm test    # 330 項測試(需要 Node 22 以上,零相依)
```

測試在假的 Apps Script 環境中執行,**不等於**真實環境;部署後請依 [`docs/MANUAL-ACCEPTANCE.md`](docs/MANUAL-ACCEPTANCE.md) 人工驗收,並在 Apps Script 編輯器執行一次 `smokeTest()`。

## 文件

- [`docs/DEPLOY.md`](docs/DEPLOY.md):部署與設定
- [`docs/MANUAL-ACCEPTANCE.md`](docs/MANUAL-ACCEPTANCE.md):必須在真實環境確認的人工驗收清單
- [`docs/COMPLETION-NOTES.md`](docs/COMPLETION-NOTES.md):自行決定的細節與尚未驗證的部分
- [`PROGRESS.md`](PROGRESS.md):設計備忘與各階段補充
- [`SECURITY.md`](SECURITY.md):安全政策與部署者須知

## 授權

[MIT](LICENSE)
