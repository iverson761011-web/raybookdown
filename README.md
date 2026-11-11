# RayBookDown 戰情中心

此網站呈現 Yahoo 籃球聯盟 **Funny League 2026-27**、球隊 **RayBookDown** 的只讀資料。

## 目前的資料

- `data/team.json`：已確認的 12 人名單、來源位置、來源狀態與可用位置。沒有 token、cookie 或內部識別碼。
- 名單與既有比分、自由市場、賽程、Add 追蹤是不同快照。舊資料會保留自己的日期，不會因名單更新而被標成最新。
- 名單的 `RetrievedAtUtc=null` 表示原始讀取結果沒有時間資訊，頁面會清楚標示未知。後續由安全匯出腳本產生的資料才帶本次讀取時間。
- 空白球員狀態代表來源未提供，不能視為健康。位置代碼保留 Yahoo 原始值，不推定調動是否合法。

網頁開啟時及每五分鐘會檢查設定的 JSON 來源。這只是讀取公開快照，不代表網站會登入 Flaim 或 Yahoo。

## 更新名單

在已完成 OAuth 與 token 更新的原 Windows PowerShell 5.1 視窗，以 `Flaim-Export-Snapshot.ps1` 匯出。將匯出的 `RayBookDown.json` 更新至本專案的 `data/team.json` 即可。兩支讀取／匯出腳本需放在同一資料夾，並使用記憶體中的 `$FlaimSession`。

完整的 Windows PowerShell 5.1 工具已放在 `tools/windows/`。於專案根目錄開啟 Windows PowerShell，可依序執行以下操作；不需要手動複製 token。

```powershell
$FlaimSession = & '.\tools\windows\Flaim-OAuth-PKCE.ps1'
```

```powershell
& '.\tools\windows\Flaim-Team-Test.ps1' -Session $FlaimSession -ShowPlayers
```

```powershell
& '.\tools\windows\Flaim-Export-Snapshot.ps1' -Session $FlaimSession -OutputPath (Join-Path (Get-Location) 'data\team.json') | Format-List
```

需要更新授權時，在同一個視窗執行：

```powershell
& '.\tools\windows\Flaim-Refresh-Test.ps1' -Session $FlaimSession | Format-List
```

更新腳本會直接保存可能輪替的新憑證到原本的記憶體 session；不要將它回傳的狀態摘要覆蓋到 `$FlaimSession`。關閉視窗後需重新登入。公開資料網址使用沒有查詢字串、帳密或片段的 HTTPS 網址，本專案預設為 `data/team.json`。

請勿將 `$FlaimSession`、access token、refresh token、Cookie 或原始 HTTP 回應提交到儲存庫。

## 排程狀態

現有 `.github/workflows/daily-update.yml` 的 `30 22 * * *` 對應每日台灣時間 06:30。它目前只檢查儲存庫中的快照，**沒有從 Flaim 同步新資料**。GitHub 的排程也可能延遲執行。

要建立長期無人值守更新，仍需在後端接上安全憑證儲存。已確認 Flaim 會輪替 refresh token，因此每次更新都必須保存新值；不能將固定的舊 refresh token 填入一次後，就視為永久可用。安全設定完成前，不會把資料檢查宣稱為自動同步。

## 本機檢查

```text
node scripts/check-snapshot.mjs data/team.json
```

此檢查只驗證資料格式，不會使用憑證，也不會發出網路請求。
