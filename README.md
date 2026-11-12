# RayBookDown 戰情中心

Yahoo 籃球聯盟 **Funny League 2026-27**、球隊 **RayBookDown** 的公開只讀儀表板。

## 自動更新的內容

`data/dashboard.json` 是完整公開資料來源，分開保存 Rules、Roster、Matchup、Transactions、Budget、Market、Schedule 七個區塊。各區塊都有自己的讀取時間、來源更新時間（未提供時為未知）及成功／部分／未知狀態；單項失敗不會被顯示成零或新資料。

- Flaim：使用 session 實際回傳的聯盟與球隊 ID，先讀規則，再讀名單、當週比分、本隊明確 UTC 日期範圍交易、FAAB／讓渡順位，以及本次回傳的25位可取得球員。

- NBA：無憑證讀取官方未來七個台灣日期的賽程。無法核實的日期顯示未知；保留先前驗證資料時保留原讀取時間，不把它標成剛更新。

- Yahoo 未提供完整歷史保證、官方週 Add 計數或週起訖日期時，不從交易筆數推算本週剩餘 Add。FAAB出價空缺不是0；空白球員狀態不是健康。

- 市場持有率是 Yahoo 全平台數值，非本聯盟持有率。讓渡日期沒有時間或時區時，不解讀為精確開放時刻。

## 兩種更新時間

每日台灣時間 **06:30** 及 main 程式更新後：GitHub Actions 取得新資料並發布 JSON，排程可能延遲。網站開啟時及每 **5分鐘**：重新讀取公開 JSON，不直接登入 Flaim 或 Yahoo。自動資料提交使用 GITHUB_TOKEN，不會再觸發新一輪同步；github-actions[bot] 的 push 亦被排除。

GitHub Pages 預設讀取主分支的 raw 公開 JSON，不依賴每次資料提交觸發網頁重建。原 `data/team.json` 在新名單讀取成功時仍會更新，供舊版工具相容使用；正式網頁改讀 `data/dashboard.json`。舊資料來源設定不自動沿用，可在「資料更新」恢復預設來源。

## 已完成安全設定的使用者

如果先前已看到 `Configured=True` 並完成首次同步，現有 `flaim` environment secrets 可以直接沿用。此升級不需重新 OAuth，也不需重新輸入或公開任何憑證。

將版本合併到 main 後，在 **Actions → RayBookDown Daily Sync → Run workflow → main** 執行一次。結果應有 `Synced=True`、`CredentialStateSaved=True`。`DataQuality=partial` 或 `SectionWarnings` 表示某些來源未確認，請看網站各區塊時間與未知標示。之後每日排程會自動執行。

初次使用才需依 [安全設定](CLOUD_SETUP.md) 完成一次性交接。排程會在消耗 Flaim 更新憑證前先測試保存權限，刷新後立即保存輪替的新值，再讀資料及發布。不要取消刷新與保存之間的工作。

## 本機匯出

在另行取得本機 OAuth session 的 Windows PowerShell 5.1，可執行：

```powershell

& '.\tools\windows\Flaim-Export-Dashboard.ps1' -Session $FlaimSession -OutputPath '.\data\dashboard.json' | Format-List

```

這只匯出 Flaim 區塊。接著以 Node 24 執行官方賽程與驗證：

```text

node scripts/update-nba-schedule.mjs data/dashboard.json

node scripts/check-dashboard.mjs data/dashboard.json

```

已交接雲端的舊 `$FlaimSession` 不再持有更新憑證；本機需要重新登入，不能重用舊更新憑證。不要將 session、token、cookie、原始HTTP回應或內部平台ID存入公開資料。

## 檢查

```text

node --test scripts/check-dashboard.test.mjs scripts/update-nba-schedule.test.mjs

node --test scripts/check-snapshot.test.mjs

powershell.exe -NoProfile -NonInteractive -File tools/windows/Test-Flaim-Cloud.ps1

powershell.exe -NoProfile -NonInteractive -File tools/windows/Test-Flaim-Dashboard.ps1

```

PR只執行合成Flaim資料測試與無憑證NBA公開來源檢查；真實憑證僅供main分支的排程／手動／程式更新後同步使用。原生Node程序使用獨立且移除憑證環境變數的安全執行器；錯誤摘要僅含階段、型別、行號及已知section名稱，沒有原始診斷或資料值。
