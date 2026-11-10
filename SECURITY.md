# 安全政策

## 回報弱點

請**不要**在公開 Issue 貼出弱點細節或任何金鑰。請改用 GitHub 的 Private vulnerability reporting 私下回報(repo 的 Security 分頁 → Report a vulnerability;需先在 Settings → Code security 啟用)。

## 部署者須知

- **`WEBHOOK_KEY`**:Apps Script 讀不到 LINE 的 `X-Line-Signature`,因此驗證只靠網址上的 `?k=` 密鑰。請使用 32 字元以上的隨機字串,不要貼進聊天或公開處,外洩時立即更換並更新 LINE 後台的 Webhook URL。
- **金鑰**:`LINE_CHANNEL_ACCESS_TOKEN`、`GEMINI_API_KEY`、`TINYFISH_API_KEY`、`CF_API_TOKEN` 等只放在 Apps Script 的「指令碼屬性」,絕不寫進程式碼或提交到 repo。
- **圖片資料夾**:生成的圖片因 LINE 需要公開網址而設為「知道連結的人可檢視」。請為 `IMAGE_DRIVE_FOLDER_ID` 建立只放機器人圖片的專用資料夾,不要指向放有其他檔案的資料夾;程式只在該資料夾內建立與清理檔案,並在刪除前確認檔案確實位於其中。授權範圍仍是完整的 `drive`(`getFolderById` 需要),所以部署者帳號 Drive 內其他檔案在技術上仍可被此程式存取。
- **`.clasp.json`** 含 scriptId,已列入 `.gitignore`;請只提交 `.clasp.json.template`。
- 建議在 Google Cloud 為 Gemini 金鑰設定每日配額與預算警示,避免被濫用時產生高額費用。
