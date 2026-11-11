# 每日 06:30 同步的安全設定

程式已備妥，但這些設定必須由你完成。請勿把 GitHub 或 Flaim token 貼到聊天、網頁、程式碼或 JSON。

## 一次性準備

1. 將本 PR 合併到 `main` 後，下載／更新專案程式碼。`tools/windows/` 必須保留完整檔案。
2. 安裝官方 [GitHub CLI](https://cli.github.com/)。Windows 可用 `winget install --id GitHub.cli --exact --source winget`。不需要執行 `gh auth login` 或把 token 放進指令。
3. 到 [專案 Environments 設定](https://github.com/iverson761011-web/raybookdown/settings/environments) 建立名為 **flaim** 的環境；若已存在，直接編輯它。Deployment branches and tags 選 **Selected branches and tags**，只加入 **Branch: main** 一項。不要加入萬用字元或其他分支。若設定需要人工核准的 reviewer，排程會等待核准；無人值守同步需要不阻擋排程的設定。
4. 在 GitHub 自己的 [fine-grained token 設定](https://github.com/settings/personal-access-tokens/new) 建立一個新 token：只選 **iverson761011-web/raybookdown**；Repository permissions 只需 **Environments: Read and write**（Metadata read 為預設），並設定你接受的到期日。這個 token 用來保存輪替後的更新憑證，無須給它程式碼寫入權限。
5. 確認 Actions 中沒有 `sync` 工作正在執行，避免設定交接與既有更新同時進行。保留仍持有 `$FlaimSession` 的 Windows PowerShell 5.1 視窗。若已關閉，先用 OAuth 腳本重新登入。於專案根目錄執行：

```powershell
& '.\tools\windows\Flaim-Configure-GitHub.ps1' -Session $FlaimSession | Format-List
```

程式會顯示固定目標 `iverson761011-web/raybookdown / flaim`，再以**隱藏輸入**要求剛才的 fine-grained token。只在這個本機提示輸入，不要貼到聊天。若缺少 CLI 或 main 分支限制，程式會停止。新安裝 CLI 後可繼續使用原 PowerShell 視窗，程式也會檢查官方預設安裝路徑，不必為了重新載入 PATH 而關閉授權視窗。

若使用另提供的獨立工具 ZIP，解壓縮到「下載」中的 `RayBookDown-Windows-Tools` 後，可在原本視窗逐行執行：

```powershell
Get-ChildItem -LiteralPath 'C:\Users\k1070704\Downloads\RayBookDown-Windows-Tools' -Filter '*.ps1' -File | Unblock-File
```

```powershell
& 'C:\Users\k1070704\Downloads\RayBookDown-Windows-Tools\Flaim-Configure-GitHub.ps1' -Session $FlaimSession | Format-List
```

成功時顯示 `Configured=True`。它會經 GitHub CLI 在本機加密後存入該環境的 `FLAIM_SECRET_WRITER` 與 `FLAIM_REFRESH_TOKEN`，不將明文放在命令列或檔案。設定成功後，本機 `$FlaimSession.RefreshToken` 會清除；後續輪替改由雲端管理。請不要另用舊副本刷新，否則可能使整個更新憑證家族失效。

交接後若需要重新在本機操作，請重新執行 OAuth 登入取得新的本機 session，不要再對已交接的舊 session 執行刷新。

## 第一次執行

到專案 **Actions → RayBookDown Daily Sync → Run workflow**，選 **main** 執行。

- 只有 `main` 上的排程／手動觸發會進入 `sync` 工作；PR 與其他分支只做不含真實憑證的測試。
- `sync` 結果應顯示 `Synced=True`、`CredentialStateSaved=True`。
- 若顯示 `CloudSetupRequired`，代表環境 secrets 尚未齊備，程式沒有向 Flaim 發送更新請求。
- 檢查 `data/team.json` 出現新的 `RetrievedAtUtc`。網站每五分鐘檢查資料，GitHub Pages 版本會直接讀取主分支的公開 JSON；不靠自動提交再觸發網頁重建。

每次同步會依序：測試憑證寫入 → 更新 Flaim 授權 → 立即保存新 refresh token → 讀取 RayBookDown 名單 → 只提交挑選過的公開資料。更新憑證保存失敗時不會繼續發布資料，也不會自動重試。

避免在同步步驟中途取消工作；若取消剛好發生於更新後、保存前，需要重新授權與設定。若網站先前儲存過自訂資料網址，可在「資料更新」清空網址再儲存，以恢復本版本的預設來源。

## 為什麼使用 environment secrets

更新憑證已確認會輪替。Repository secrets 在工作流程排隊時就讀取，可能讓排隊中的執行拿到舊值；environment secrets 在工作開始時讀取。因此此工作使用 **flaim environment secrets** 與同一個不取消執行中的鎖，讓後一個工作在前一個完成後才取得新值。[GitHub secrets 讀取時機](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets)

GitHub CLI 會在送到 GitHub 前於本機加密 secret；腳本透過標準輸入傳值，不使用 `--body` 的明文引數、不建立登入設定檔，也不轉送子程序的原始錯誤內容。[GitHub CLI secret set](https://cli.github.com/manual/gh_secret_set)

fine-grained token 的 **Environments write** 是 GitHub 更新環境 secret 所需的權限。[GitHub REST 權限說明](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret)

## 失敗或到期

- `GitHubCommandFailed`：先確認 GitHub token 到期日、只限本專案的 Environments write 權限，以及環境名稱 `flaim`。預先寫入檢查失敗會在消耗 Flaim refresh token 前停止。
- `RefreshFailed` / `RefreshPersistenceFailed` 且 `NextAction=ReauthorizeAndConfigureAgain`：不要連續重試舊值。重新 OAuth 登入，再執行一次設定腳本以重新交接。
- `DataExportFailed` 或資料提交失敗，但 `CredentialStateSaved=True`：新更新憑證已保存，可確認來源／網路後重新手動執行。程式不會在同一次工作中重送更新請求。
- fine-grained token 到期後需更新設定。重新 OAuth 並重新執行設定腳本即可；不要把過期 token 保留在聊天或程式碼中。

此同步更新的是目前球隊名單與聯盟摘要；舊比分、自由市場、Add 追蹤和賽程仍清楚保留舊快照標示，沒有宣稱它們已自動更新。GitHub 排程可能延遲，並不保證精確在 06:30:00 執行。

## 驗證範圍

雲端流程使用合成憑證與假 CLI 的測試，確認保密輸入、寫入順序、輪替後先保存、各種失敗時停止發布與安全摘要。尚未使用你的真實 GitHub/Flaim 憑證測試排程；需完成上述本機設定，才能驗證首次正式同步。
