#requires -Version 5.1
[CmdletBinding()]
param([string]$RepositoryRoot = (Get-Location).Path)

. (Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1')

function Update-FlaimScheduledSession {
    param([object]$Session)
    return (& (Join-Path $PSScriptRoot 'Flaim-Refresh-Test.ps1') -Session $Session)
}
function Invoke-FlaimPublicNode {
    param([string]$ScriptPath, [string]$DataPath, [string]$FailureKind)
    if ($ScriptPath -match '["\r\n\x00]' -or $DataPath -match '["\r\n\x00]') { Stop-FlaimCloudFailure 'InvalidCloudRequest' }
    # Windows PowerShell 5.1 can return every matching application on PATH.
    $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node.Source
    $start.Arguments = '"' + $ScriptPath + '" "' + $DataPath + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($ScriptPath)
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @('FLAIM_REFRESH_TOKEN','FLAIM_SECRET_WRITER','GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS')) { $start.EnvironmentVariables.Remove($name) }
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo = $start
        try { [void]$process.Start() }
        catch {
            $deep = $_.Exception
            while ($null -ne $deep.InnerException) { $deep = $deep.InnerException }
            $nativeCode = 0
            if ($deep -is [ComponentModel.Win32Exception]) { $nativeCode = $deep.NativeErrorCode }
            $exists = [IO.File]::Exists($start.FileName)
            $launchFailure = [InvalidOperationException]::new(('Public Node launch failed. NativeErrorCode={0}; ExecutableExists={1}.' -f $nativeCode,$exists))
            $launchFailure.Data['CloudKind'] = 'NodeLaunchFailed'
            if ($deep -is [ComponentModel.Win32Exception]) { $launchFailure.Data['NativeErrorCode'] = $deep.NativeErrorCode }
            $launchFailure.Data['NodeExecutableExists'] = [IO.File]::Exists($start.FileName)
            $launchFailure.Data['NodeCommandType'] = $node.CommandType.ToString()
            throw $launchFailure
        }
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $diagnostics = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            try { $process.Kill() } catch { }
            Stop-FlaimCloudFailure 'NodeCommandTimeout'
        }
        if ($process.ExitCode -ne 0) {
            $failure = [InvalidOperationException]::new('Public data subprocess failed.')
            $failure.Data['CloudKind'] = $FailureKind
            try {
                $safeDiagnostic = ConvertFrom-Json -InputObject ($diagnostics.GetAwaiter().GetResult()) -ErrorAction Stop
                $allowedSections = @('Root','Rules','Roster','Matchup','Transactions','Budget','Market','Schedule')
                $invalid = @($safeDiagnostic.InvalidSections | Where-Object { $allowedSections -ccontains $_ })
                $failure.Data['InvalidSections'] = $invalid -join ','
            } catch { }
            throw $failure
        }
        # Do not forward native stderr through PowerShell's error stream.
        # Framework PowerShell can treat even redirected stderr as a terminating error.
        $null = $output.GetAwaiter().GetResult()
        $null = $diagnostics.GetAwaiter().GetResult()
    }
    finally { $process.Dispose() }
}
function Export-FlaimScheduledData {
    param([object]$Session, [string]$Destination)
    $previousSchedule = $null
    if ([IO.File]::Exists($Destination)) {
        try {
            $previous = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Destination)) -ErrorAction Stop
            if ($previous.SchemaVersion -eq 2 -and $previous.League -ceq 'Funny League 2026-27' -and
                $previous.Team -ceq 'RayBookDown' -and @('ok','partial') -ccontains $previous.Sections.Schedule.Status) {
                $previousSchedule = $previous.Sections.Schedule
            }
        } catch { $previousSchedule = $null }
    }
    $historyPath = Join-Path ([IO.Path]::GetDirectoryName($Destination)) 'matchup-history.json'
    $summary = & (Join-Path $PSScriptRoot 'Flaim-Export-Dashboard.ps1') -Session $Session -OutputPath $Destination -HistoryOutputPath $historyPath
    if ($summary.Exported -ne $true) { return $summary }
    # A Flaim-only export cannot replace the last verified NBA source snapshot.
    # The public NBA updater decides whether it can refresh it or retain its old time.
    if ($null -ne $previousSchedule) {
        $fresh = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Destination)) -ErrorAction Stop
        $fresh.Sections.Schedule = $previousSchedule
        $carryPath = $Destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllText($carryPath,(ConvertTo-Json -InputObject $fresh -Depth 24),[Text.UTF8Encoding]::new($false))
            [IO.File]::Replace($carryPath,$Destination,[Management.Automation.Language.NullString]::Value)
        } finally { if ([IO.File]::Exists($carryPath)) { [IO.File]::Delete($carryPath) } }
    }
    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    # These public-data subprocesses inherit no Flaim or GitHub credential variables.
    Invoke-FlaimPublicNode (Join-Path $root 'scripts\update-nba-schedule.mjs') $Destination 'ScheduleUpdateFailed'
    Invoke-FlaimPublicNode (Join-Path $root 'scripts\build-weekly-schedule.mjs') $Destination 'WeeklyScheduleBuildFailed'
    Invoke-FlaimPublicNode (Join-Path $root 'scripts\build-recommendations.mjs') $Destination 'RecommendationBuildFailed'
    Invoke-FlaimPublicNode (Join-Path $root 'scripts\check-dashboard.mjs') $Destination 'DashboardValidationFailed'
    $document = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Destination)) -ErrorAction Stop
    $sectionErrors = @($document.Sections.PSObject.Properties | Where-Object { $_.Value.Status -ne 'ok' } | ForEach-Object { $_.Name })
    return [pscustomobject]@{ Exported=$true; PlayerCount=$summary.PlayerCount; SectionErrors=$sectionErrors }
}
function Publish-FlaimPublicFile {
    param([string]$RelativePath, [byte[]]$Bytes, [Security.SecureString]$RepositoryToken)
    $publicPaths = @('data/dashboard.json','data/team.json','data/matchup-history.json','data/team-week-schedule.json','data/recommendations.json','data/recommendation-evidence.json','data/recommendation-history.json')
    if ($publicPaths -cnotcontains $RelativePath) { Stop-FlaimCloudFailure 'InvalidSnapshot' }
    $endpoint = 'repos/iverson761011-web/raybookdown/contents/' + $RelativePath
    $sha = Invoke-FlaimGh -GhArguments @('api',$endpoint,'-H','Accept:application/vnd.github.object+json','--jq','.sha') -Token $RepositoryToken -ReturnOutput
    if ($sha -cnotmatch '^[0-9a-f]{40}$') { Stop-FlaimCloudFailure 'InvalidCloudResponse' }
    $limit = 1048576
    if ($RelativePath -ceq 'data/recommendation-history.json') { $limit = 8388608 }
    if ($Bytes.Length -gt $limit) { Stop-FlaimCloudFailure 'InvalidSnapshot' }
    $body = @{ message = 'Update RayBookDown public dashboard data'; branch = 'main'; sha = $sha; content = [Convert]::ToBase64String($Bytes) }
    $json = ConvertTo-Json -InputObject $body -Compress
    $null = Invoke-FlaimGh -GhArguments @('api','--method','PUT',$endpoint,'--input','-') -Token $RepositoryToken -InputText $json
}
function Publish-FlaimScheduledData {
    param([string]$Path, [Security.SecureString]$RepositoryToken)
    $bytes = [IO.File]::ReadAllBytes($Path)
    Publish-FlaimPublicFile 'data/dashboard.json' $bytes $RepositoryToken
    $folder = [IO.Path]::GetDirectoryName($Path)
    foreach ($name in @('matchup-history.json','team-week-schedule.json','recommendations.json','recommendation-evidence.json','recommendation-history.json')) {
        $extra = Join-Path $folder $name
        if ([IO.File]::Exists($extra)) { Publish-FlaimPublicFile ('data/' + $name) ([IO.File]::ReadAllBytes($extra)) $RepositoryToken }
    }
    # Keep the previous roster-only endpoint compatible when a fresh roster exists.
    $dashboard = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($bytes)) -ErrorAction Stop
    if ($dashboard.Sections.Roster.Status -ceq 'ok') {
        $rules = $dashboard.Sections.Rules.Data
        $players = @($dashboard.Sections.Roster.Data.Players | ForEach-Object {
            $eligible = $null
            if ($null -ne $_.EligiblePositions) { $eligible = @($_.EligiblePositions) -join ', ' }
            [pscustomobject]@{ Player=$_.Player; Position=$_.Position; Status=$_.Status; EligiblePositions=$eligible }
        })
        $legacy = [ordered]@{
            SchemaVersion=1; Connected=$true; DataRead=$true; League=$dashboard.League; Team=$dashboard.Team
            Platform=$dashboard.Platform; Season=$dashboard.Season; ScoringFormat=$null; ScoringType=$null; TeamCount=$null
            PlayerCount=$players.Count; NamedPlayerCount=@($players | Where-Object { $null -ne $_.Player }).Count
            Players=$players; RetrievedAtUtc=$dashboard.Sections.Roster.RetrievedAtUtc
        }
        if ($null -ne $rules) { $legacy.ScoringFormat=$rules.ScoringFormat; $legacy.ScoringType=$rules.ScoringType; $legacy.TeamCount=$rules.TeamCount }
        $legacyBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $legacy -Depth 12))
        Publish-FlaimPublicFile 'data/team.json' $legacyBytes $RepositoryToken
    }
}

function Invoke-FlaimScheduledSync {
    param(
        [Security.SecureString]$RefreshToken, [Security.SecureString]$WriterToken,
        [Security.SecureString]$RepositoryToken, [string]$Root
    )
    $ErrorActionPreference = 'Stop'
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    $session = $null
    $stateSaved = $false
    $refreshStarted = $false
    $kind = 'ScheduledSyncFailed'
    $stage = 'Initialize'
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop') { Stop-FlaimCloudFailure 'UnsupportedRuntime' }
        if ($null -eq $RefreshToken -or $null -eq $WriterToken -or $null -eq $RepositoryToken) {
            Stop-FlaimCloudFailure 'CloudSetupRequired'
        }
        if ($RefreshToken.Length -le 0 -or $WriterToken.Length -le 0 -or $RepositoryToken.Length -le 0) {
            Stop-FlaimCloudFailure 'InvalidCredential'
        }
        $target = [IO.Path]::GetFullPath((Join-Path $Root 'data\dashboard.json'))
        if (-not [IO.File]::Exists($target)) { Stop-FlaimCloudFailure 'SnapshotFileMissing' }
        # Verify the writer can save state BEFORE consuming a rotating refresh token.
        $stage = 'CredentialPreflight'
        Set-FlaimEnvironmentSecret 'FLAIM_REFRESH_TOKEN' $RefreshToken $WriterToken
        $sessionRefresh = $RefreshToken.Copy()
        $sessionRefresh.MakeReadOnly()
        $session = [pscustomobject]@{
            AccessToken = (New-FlaimCloudSecret 'unused-before-refresh')
            RefreshToken = $sessionRefresh; TokenType = 'Bearer'; ExpiresAtUtc = $null; ObtainedAtUtc = $null
        }
        $refreshStarted = $true
        $stage = 'RefreshAuthorization'
        $refreshResult = Update-FlaimScheduledSession $session
        if ($refreshResult.Refreshed -ne $true) { Stop-FlaimCloudFailure 'RefreshFailed' }
        # Save the replacement immediately, even if a later data query or commit fails.
        $stage = 'PersistRefreshedCredential'
        try { Set-FlaimEnvironmentSecret 'FLAIM_REFRESH_TOKEN' $session.RefreshToken $WriterToken }
        catch { Stop-FlaimCloudFailure 'RefreshPersistenceFailed' }
        $stateSaved = $true
        $stage = 'ExportPublicData'
        $export = Export-FlaimScheduledData $session $target
        if ($export.Exported -ne $true) { Stop-FlaimCloudFailure 'DataExportFailed' }
        $stage = 'PublishPublicData'
        Publish-FlaimScheduledData $target $RepositoryToken
        return [pscustomobject]@{
            Synced = $true; CredentialStateSaved = $true; PlayerCount = $export.PlayerCount
            DataQuality = $(if ($null -ne $export.PSObject.Properties['SectionErrors'] -and @($export.SectionErrors).Count -gt 0) { 'partial' } else { 'complete' })
            SectionWarnings = $(if ($null -ne $export.PSObject.Properties['SectionErrors']) { @($export.SectionErrors) } else { @() })
            ErrorType = $null; NextAction = 'Complete'
        }
    }
    catch {
        $allowed = @('UnsupportedRuntime','CloudSetupRequired','InvalidCredential','SnapshotFileMissing','GitHubCliMissing',
            'InvalidCloudRequest','GitHubCommandTimeout','GitHubCommandFailed','InvalidCloudResponse','InvalidSnapshot',
            'RefreshFailed','RefreshPersistenceFailed','DataExportFailed')
        $allowed += @('NodeCommandTimeout','NodeLaunchFailed','ScheduleUpdateFailed','DashboardValidationFailed','WeeklyScheduleBuildFailed','RecommendationBuildFailed')
        if ($allowed -ccontains $_.Exception.Data['CloudKind']) { $kind = [string]$_.Exception.Data['CloudKind'] }
        $next = 'ReportSafeSummary'
        if ($kind -eq 'CloudSetupRequired') { $next = 'ConfigureCloudSecrets' }
        if ($refreshStarted -and -not $stateSaved) { $next = 'ReauthorizeAndConfigureAgain' }
        return [pscustomobject]@{
            Synced = $false; CredentialStateSaved = $stateSaved; PlayerCount = $null
            FailureStage = $stage; ExceptionType = $_.Exception.GetType().FullName
            FailureFile = [IO.Path]::GetFileName($_.InvocationInfo.ScriptName); FailureLine = $_.InvocationInfo.ScriptLineNumber
            InvalidSections = $_.Exception.Data['InvalidSections']
            NativeErrorCode = $_.Exception.Data['NativeErrorCode']; NodeExecutableExists = $_.Exception.Data['NodeExecutableExists']; NodeCommandType = $_.Exception.Data['NodeCommandType']
            ErrorType = $kind; NextAction = $next
        }
    }
    finally {
        if ($null -ne $session) {
            try { $session.AccessToken.Dispose() } catch { }
            try { $session.RefreshToken.Dispose() } catch { }
        }
        $refreshResult = $null
        $export = $null
    }
}

$refresh = $null
$writer = $null
$repositoryToken = $null
try {
    if ([string]::IsNullOrEmpty($env:FLAIM_REFRESH_TOKEN) -or [string]::IsNullOrEmpty($env:FLAIM_SECRET_WRITER)) {
        Write-Host 'Synced=False; ErrorType=CloudSetupRequired. No Flaim request was sent.'
        exit 0
    }
    $refresh = New-FlaimCloudSecret $env:FLAIM_REFRESH_TOKEN
    $writer = New-FlaimCloudSecret $env:FLAIM_SECRET_WRITER
    $repositoryToken = New-FlaimCloudSecret $env:GITHUB_TOKEN
    $env:FLAIM_REFRESH_TOKEN = $null
    $env:FLAIM_SECRET_WRITER = $null
    $env:GITHUB_TOKEN = $null
    $env:GH_TOKEN = $null
    $result = Invoke-FlaimScheduledSync $refresh $writer $repositoryToken $RepositoryRoot
    $result | Format-List
    if (-not $result.Synced) { exit 1 }
}
finally {
    if ($null -ne $refresh) { $refresh.Dispose() }
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $repositoryToken) { $repositoryToken.Dispose() }
}
