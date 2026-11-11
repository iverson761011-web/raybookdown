#requires -Version 5.1
[CmdletBinding()]
param([string]$RepositoryRoot = (Get-Location).Path)

. (Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1')

function Update-FlaimScheduledSession {
    param([object]$Session)
    return (& (Join-Path $PSScriptRoot 'Flaim-Refresh-Test.ps1') -Session $Session)
}
function Export-FlaimScheduledData {
    param([object]$Session, [string]$Destination)
    return (& (Join-Path $PSScriptRoot 'Flaim-Export-Snapshot.ps1') -Session $Session -OutputPath $Destination)
}
function Publish-FlaimScheduledData {
    param([string]$Path, [Security.SecureString]$RepositoryToken)
    $sha = Invoke-FlaimGh -GhArguments @('api','repos/iverson761011-web/raybookdown/contents/data/team.json','--jq','.sha') -Token $RepositoryToken -ReturnOutput
    if ($sha -cnotmatch '^[0-9a-f]{40}$') { Stop-FlaimCloudFailure 'InvalidCloudResponse' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt 1048576) { Stop-FlaimCloudFailure 'InvalidSnapshot' }
    $body = @{ message = 'Update RayBookDown team snapshot'; branch = 'main'; sha = $sha; content = [Convert]::ToBase64String($bytes) }
    $json = ConvertTo-Json -InputObject $body -Compress
    $null = Invoke-FlaimGh -GhArguments @('api','--method','PUT','repos/iverson761011-web/raybookdown/contents/data/team.json','--input','-') -Token $RepositoryToken -InputText $json
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
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop') { Stop-FlaimCloudFailure 'UnsupportedRuntime' }
        if ($null -eq $RefreshToken -or $null -eq $WriterToken -or $null -eq $RepositoryToken) {
            Stop-FlaimCloudFailure 'CloudSetupRequired'
        }
        if ($RefreshToken.Length -le 0 -or $WriterToken.Length -le 0 -or $RepositoryToken.Length -le 0) {
            Stop-FlaimCloudFailure 'InvalidCredential'
        }
        $target = [IO.Path]::GetFullPath((Join-Path $Root 'data\team.json'))
        if (-not [IO.File]::Exists($target)) { Stop-FlaimCloudFailure 'SnapshotFileMissing' }
        # Verify the writer can save state BEFORE consuming a rotating refresh token.
        Set-FlaimEnvironmentSecret 'FLAIM_REFRESH_TOKEN' $RefreshToken $WriterToken
        $sessionRefresh = $RefreshToken.Copy()
        $sessionRefresh.MakeReadOnly()
        $session = [pscustomobject]@{
            AccessToken = (New-FlaimCloudSecret 'unused-before-refresh')
            RefreshToken = $sessionRefresh; TokenType = 'Bearer'; ExpiresAtUtc = $null; ObtainedAtUtc = $null
        }
        $refreshStarted = $true
        $refreshResult = Update-FlaimScheduledSession $session
        if ($refreshResult.Refreshed -ne $true) { Stop-FlaimCloudFailure 'RefreshFailed' }
        # Save the replacement immediately, even if a later data query or commit fails.
        try { Set-FlaimEnvironmentSecret 'FLAIM_REFRESH_TOKEN' $session.RefreshToken $WriterToken }
        catch { Stop-FlaimCloudFailure 'RefreshPersistenceFailed' }
        $stateSaved = $true
        $export = Export-FlaimScheduledData $session $target
        if ($export.Exported -ne $true) { Stop-FlaimCloudFailure 'DataExportFailed' }
        Publish-FlaimScheduledData $target $RepositoryToken
        return [pscustomobject]@{
            Synced = $true; CredentialStateSaved = $true; PlayerCount = $export.PlayerCount
            ErrorType = $null; NextAction = 'Complete'
        }
    }
    catch {
        $allowed = @('UnsupportedRuntime','CloudSetupRequired','InvalidCredential','SnapshotFileMissing','GitHubCliMissing',
            'InvalidCloudRequest','GitHubCommandTimeout','GitHubCommandFailed','InvalidCloudResponse','InvalidSnapshot',
            'RefreshFailed','RefreshPersistenceFailed','DataExportFailed')
        if ($allowed -ccontains $_.Exception.Data['CloudKind']) { $kind = [string]$_.Exception.Data['CloudKind'] }
        $next = 'ReportSafeSummary'
        if ($kind -eq 'CloudSetupRequired') { $next = 'ConfigureCloudSecrets' }
        if ($refreshStarted -and -not $stateSaved) { $next = 'ReauthorizeAndConfigureAgain' }
        return [pscustomobject]@{
            Synced = $false; CredentialStateSaved = $stateSaved; PlayerCount = $null
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
    $result = Invoke-FlaimScheduledSync $refresh $writer $repositoryToken $RepositoryRoot
    $result | Format-List
    if (-not $result.Synced) { exit 1 }
}
finally {
    if ($null -ne $refresh) { $refresh.Dispose() }
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $repositoryToken) { $repositoryToken.Dispose() }
}
