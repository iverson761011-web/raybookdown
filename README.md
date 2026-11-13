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

另外在台灣時間 **12:00～18:00 每小時**檢查前一個 NBA 日期是否全場終場。官方比分尚未確認、延賽或來源失敗時，不將當日推薦標成已完成；舊報告保留原時間。GitHub 排程可能延後，不保證整點顯示。

## 每日補強、歷週結果與球隊週場次

- 「歷週結果」逐週讀取 Flaim／Yahoo 的當季對戰，列出對手、類別比分、來源提供的最終勝者與每週讀取時間；當週領先不當成已獲勝。未提供週日期時保留未知。
- 「NBA 賽程」列出 30 隊的整週總場次、現在起的剩餘排定場次與台灣日期；我的陣容及自由市場也顯示相同期間的剩餘場次。Yahoo 週界未核實時，明示使用**台灣日曆週（週一至週日）**，不能當作 Yahoo 對戰週。任何未確認日期都不填假零；球隊排賽不保證球員出賽。
- 「每日補強」以積極爭取近端比項為方向，只比較本次 Flaim 回傳的市場，保留近30日官方逐場證據，以正式賽7／14日樣本、官方傷病報告及剩餘排賽做比較。沒有足夠樣本、身分不明或資料過舊時只列觀察；球隊已提交但球員未列名時，明示醫療狀態未知，最多提供待確認出賽的條件式候選，不推定健康。
- 建議會說明近比分類別的可能幫助和換人損失。Yahoo 不可丟棄標記會保留；不因單場差表現建議移除。這是需自行確認的建議，不會替你增刪 Yahoo 球員；上場欄位、剩餘 Add、讓渡與鎖定時間仍需在 Yahoo 確認。

新增公開檔案：`data/matchup-history.json`、`data/team-week-schedule.json`、`data/recommendations.json`。NBA 證據為 `data/recommendation-evidence.json`，官方球員逐場快取為 `data/recommendation-history.json`；後者只供雲端建立滾動觀察，不在網頁載入。快取可達 8 MiB，其餘公開檔案上限 1 MiB；快取只保留公開 NBA 欄位，沒有 Flaim 原始回應、憑證或內部 Yahoo ID。

GitHub Pages 預設讀取主分支的 raw 公開 JSON，不依賴每次資料提交觸發網頁重建。原 `data/team.json` 在新名單讀取成功時仍會更新，供舊版工具相容使用；正式網頁改讀 `data/dashboard.json`。舊資料來源設定不自動沿用，可在「資料更新」恢復預設來源。

## 任選球隊分析

「球隊分析」頁可選擇同一聯盟的任何一隊，查看所選球隊的陣容、當週比分、FAAB／取得額度、優劣勢及補強人選。離開此頁後，原有「我的陣容」等頁面仍顯示 RayBookDown；來源失敗時不以 RayBookDown 資料替代別隊。

優劣勢依 Yahoo **當週實際計分比項的累計值**與已取得的聯盟球隊比較，顯示排名及比較隊數；失誤採較少較好，展示用項目不計入。這是本週累計相對位置，不是球隊長期實力，出賽數不同會影響結果。資料不完整或樣本不足時明示未知。

補強建議使用所選球隊自己的陣容、對手比分、額度與保護標記，並沿用 NBA 正式賽近7／14日、官方傷病與剩餘排程。相對弱項另以1.35倍分析權重輔助排序；這是可解釋的分析方式，不是 Yahoo 計分權重或獲勝機率。各隊使用同一聯盟的回傳市場；市場與任何球隊陣容互相矛盾的球員不當作已確認自由球員。

新檔為 `data/league-teams.json`（挑選過的全隊來源資料）及 `data/league-analysis.json`（網頁分析）。兩者上限各1MiB，僅包含顯示所需欄位；選隊鍵取自公開隊名的雜湊，不公開內部平台ID、管理者或憑證。近30日的完整公開 NBA 逐場快取供各隊分析重用，網頁不載入該大型快取。雲端讀取沿用同一授權，無須新增登入設定。

## 已完成安全設定的使用者

如果先前已看到 `Configured=True` 並完成首次同步，現有 `flaim` environment secrets 可以直接沿用。此升級不需重新 OAuth，也不需重新輸入或公開任何憑證。

程式合併到 main 後會自動執行同步；若需要額外更新，可在 **Actions → RayBookDown Daily Sync → Run workflow → main** 手動執行。結果應有 `Synced=True`、`CredentialStateSaved=True`。`DataQuality=partial` 或 `SectionWarnings` 表示某些來源未確認，請看網站各區塊時間與未知標示。之後依排程自動執行。

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
