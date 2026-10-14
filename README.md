# DSH 對話雲端同步 V4（0.4.0）

此套件為 `dsh-conversation-sync`，使用 VPS HTTPS API 與裝置配對。它不是舊的 `dsh-session-sync` Git SSH 插件，請勿同時啟用兩種同步流程。

## 從 GitHub 安裝或更新

使用指定版本安裝，可確保公司與家裡使用同一版本：

```powershell
dsh plugin --profile web add "github:ammo0904/dsh-conversation-sync#v0.4.0"
```

日後更新時將標籤換成新版本；安裝後重新啟動 DSH，瀏覽器按 Ctrl+F5。既有本機設定與配對資料保留。套件需要 DSH 0.2.0-rc.2 相容介面及 Node.js 24；VPS HTTPS 同步服務必須另外部署，本儲存庫只包含用戶端插件。

## 公司電腦更新

1. 關閉公司電腦的 DSH，保留原有對話資料與配對資料。
2. 備份原插件資料夾，再將本版解壓縮至例如 `C:\Users\<帳號>\DSH-Plugins\dsh-conversation-sync`；資料夾內應直接有 `package.json`。
3. 在 PowerShell 執行（依實際解壓縮位置修改路徑）：

```powershell
npm --prefix "$env:USERPROFILE\DSH-Plugins\dsh-conversation-sync" install --omit=dev
dsh plugin --profile web add "link:$env:USERPROFILE/DSH-Plugins/dsh-conversation-sync"
```

4. 重新啟動 DSH，瀏覽器按 Ctrl+F5。
5. 進入「插件 → dsh-conversation-sync」，確認標題顯示 v0.4.0。

## 設定會話來源前綴

在「新會話標題前綴」欄位輸入：

- 家裡電腦：`家裡_`
- 公司電腦：`公司_`

按「儲存設定」，再建立新會話並送出第一則訊息。DSH 自動命名後會顯示例如 `公司_討論專案部署`。空白表示停用。

此功能不會批次修改既有標題，不會替下載的對話換成本機前綴。改前綴後，下一個新會話使用新值。前綴只儲存在本機設定，同步傳輸的是已命名的對話標題。

## 既有公司裝置

請保留原本 VPS HTTPS 位址、裝置名稱、配對資料與還原專案。已配對的裝置不需重新配對，亦不需 SSH 金鑰或 root 密碼。從 0.1.0 升級時請先升級到本版後再下載；本版包含 0.2.0 的跨電腦 cwd 映射修正。

## 首次安裝的公司裝置

1. 填入與家裡端相同的 VPS HTTPS 同步服務位址（不是 Git 儲存庫路徑）。
2. 裝置名稱填「公司電腦」，標題前綴填 `公司_`。
3. 先在公司端本機專案建立一個會話，再於「新下載對話的本機專案」選擇該專案。
4. 按「儲存設定」與「測試連線」。
5. 向管理者取得 VPS 配對密語，按「配對裝置」；此安裝包不包含配對密語。
6. 按「立即同步」，檢查最近同步時間與錯誤，再開啟自動上傳、啟動及定期下載。

## 明天確認清單

- GUI 顯示 v0.4.0，前綴欄位可以儲存並在重新啟動後保留。
- 新會話的自動標題帶有 `公司_`，沒有重複前綴。
- 下載的家裡會話保留 `家裡_`，可開啟歷史並續聊。
- 檢查最近同步時間及錯誤；已開啟、被鎖定的對話可能暫緩下載，關閉該對話後再同步。

## 版本與發布

安裝包使用版本檔名 `dsh-conversation-sync-V4-0.4.0.zip`；變更紀錄見 CHANGELOG.md。本插件已發布於 https://github.com/ammo0904/dsh-conversation-sync；目前版本為 `v0.4.0`。不要在 GitHub 放配對憑證、對話紀錄或 VPS 密碼。

