#requires -Version 5.1
<#
.SYNOPSIS
    Export selected RayBookDown team data, never credentials, for the dashboard.
.DESCRIPTION
    Keep Flaim-Team-Test.ps1 in the same folder and use the existing session.
    Returns a safe export summary. Does not save or refresh any credentials.
#>
[CmdletBinding()]
param(
    [object]$Session,
    [string]$OutputPath = (Join-Path $PSScriptRoot 'RayBookDown.json'),
    [ValidateRange(5, 120)]
    [int]$RequestTimeoutSeconds = 30
)

function Stop-RayBookDownExport {
    param([string]$Kind)
    $failure = [InvalidOperationException]::new('RayBookDown export failed.')
    $failure.Data['ExportKind'] = $Kind
    throw $failure
}

function ConvertTo-RayBookDownLabel {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -isnot [string] -or $Value.Length -gt 200) { Stop-RayBookDownExport 'InvalidSnapshot' }
    return [Text.RegularExpressions.Regex]::Replace($Value, '[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', ' ')
}

function Assert-RayBookDownNoCredentials {
    param([object]$Session, [Collections.Generic.List[string]]$Labels)
    foreach ($name in @('AccessToken', 'RefreshToken')) {
        $property = $Session.PSObject.Properties[$name]
        if ($null -eq $property -or $property -isnot [Management.Automation.PSNoteProperty] -or
            $null -eq $property.Value) { continue }
        if ($property.Value -isnot [Security.SecureString]) { Stop-RayBookDownExport 'InvalidSession' }
        $bstr = [IntPtr]::Zero
        $plain = $null
        try {
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($property.Value)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            if ([string]::IsNullOrEmpty($plain)) { Stop-RayBookDownExport 'InvalidSession' }
            foreach ($label in $Labels) {
                if ($null -ne $label -and $label.IndexOf($plain, [StringComparison]::Ordinal) -ge 0) {
                    Stop-RayBookDownExport 'CredentialDataDetected'
                }
            }
        }
        finally {
            if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
            $plain = $null
        }
    }
}

function Read-RayBookDownExportTeam {
    param([object]$Session, [int]$Seconds)
    $readerPath = Join-Path $PSScriptRoot 'Flaim-Team-Test.ps1'
    return (& $readerPath -Session $Session -RequestTimeoutSeconds $Seconds)
}

function Invoke-RayBookDownExport {
    param([object]$Session, [string]$Destination, [int]$Seconds = 30)
    $ErrorActionPreference = 'Stop'
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version 2.0
    $temporary = $null
    $kind = 'ExportFailed'
    $status = 0
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop') { Stop-RayBookDownExport 'UnsupportedRuntime' }
        if ($null -eq $Session) { Stop-RayBookDownExport 'MissingSession' }
        $readerPath = Join-Path $PSScriptRoot 'Flaim-Team-Test.ps1'
        if (-not [IO.File]::Exists($readerPath)) { Stop-RayBookDownExport 'TeamReaderMissing' }
        $fullDestination = [IO.Path]::GetFullPath($Destination)
        if ([IO.Path]::GetExtension($fullDestination) -ine '.json') { Stop-RayBookDownExport 'InvalidOutputPath' }
        $directory = [IO.Path]::GetDirectoryName($fullDestination)
        if (-not [IO.Directory]::Exists($directory)) { Stop-RayBookDownExport 'OutputFolderMissing' }
        $readResult = Read-RayBookDownExportTeam -Session $Session -Seconds $Seconds
        if ($readResult -isnot [pscustomobject]) {
            Stop-RayBookDownExport 'InvalidSnapshot'
        }
        $readFlag = $readResult.PSObject.Properties['DataRead']
        if ($null -eq $readFlag -or $readFlag -isnot [Management.Automation.PSNoteProperty] -or $readFlag.Value -isnot [bool]) {
            Stop-RayBookDownExport 'InvalidSnapshot'
        }
        $httpProperty = $readResult.PSObject.Properties['HttpStatus']
        if ($null -ne $httpProperty -and $httpProperty -is [Management.Automation.PSNoteProperty] -and
            $httpProperty.Value -is [int] -and $httpProperty.Value -ge 0 -and $httpProperty.Value -le 599) {
            $status = $readResult.HttpStatus
        }
        if ($readResult.DataRead -ne $true) {
            $safeReadErrors = @('AccessTokenExpired', 'AccessTokenRejected', 'MissingSession', 'InvalidSession',
                'AccessDenied', 'RequestTimeout', 'DataTransportError', 'TeamDataReadError', 'UnsupportedRosterSchema',
                'LeagueNotFound', 'AmbiguousLeague', 'TeamIdentityMismatch', 'MissingTeamIdentifiers')
            $errorProperty = $readResult.PSObject.Properties['ErrorType']
            if ($null -ne $errorProperty -and $errorProperty -is [Management.Automation.PSNoteProperty] -and
                $safeReadErrors -ccontains $errorProperty.Value) {
                Stop-RayBookDownExport $readResult.ErrorType
            }
            Stop-RayBookDownExport 'TeamReadFailed'
        }
        foreach ($name in @('Connected','League','Team','Platform','Season','ScoringFormat','ScoringType','TeamCount','Players')) {
            $requiredProperty = $readResult.PSObject.Properties[$name]
            if ($null -eq $requiredProperty -or $requiredProperty -isnot [Management.Automation.PSNoteProperty]) {
                Stop-RayBookDownExport 'InvalidSnapshot'
            }
        }
        if ($readResult.Connected -isnot [bool] -or $readResult.Connected -ne $true -or $readResult.League -cne 'Funny League 2026-27' -or
            $readResult.Team -cne 'RayBookDown' -or $readResult.Platform -cne 'yahoo' -or
            $readResult.Season -isnot [int] -or $readResult.Season -ne 2026 -or
            $readResult.Players -isnot [Array] -or $readResult.Players.Count -gt 100) { Stop-RayBookDownExport 'InvalidSnapshot' }
        $labels = [Collections.Generic.List[string]]::new()
        foreach ($fixedLabel in @('Funny League 2026-27','RayBookDown','yahoo','2026')) { $labels.Add($fixedLabel) }
        $players = [Collections.Generic.List[object]]::new()
        $namedPlayers = 0
        foreach ($entry in $readResult.Players) {
            $player = [ordered]@{}
            foreach ($name in @('Player','Position','Status','EligiblePositions')) {
                $property = $entry.PSObject.Properties[$name]
                if ($null -eq $property -or $property -isnot [Management.Automation.PSNoteProperty]) {
                    Stop-RayBookDownExport 'InvalidSnapshot'
                }
                $value = ConvertTo-RayBookDownLabel $property.Value
                $player[$name] = $value
                $labels.Add($value)
            }
            if (-not [string]::IsNullOrWhiteSpace($player['Player'])) { $namedPlayers++ }
            $players.Add([pscustomobject]$player)
        }
        $scoringFormat = $null
        if ($null -ne $readResult.ScoringFormat) {
            if (@('points','categories','roto','unknown') -cnotcontains $readResult.ScoringFormat) { Stop-RayBookDownExport 'InvalidSnapshot' }
            $scoringFormat = $readResult.ScoringFormat
            $labels.Add($scoringFormat)
        }
        $scoringType = ConvertTo-RayBookDownLabel $readResult.ScoringType
        $labels.Add($scoringType)
        $teamCount = $null
        if ($null -ne $readResult.TeamCount) {
            if ($readResult.TeamCount -isnot [int] -or $readResult.TeamCount -le 0 -or $readResult.TeamCount -gt 1000) {
                Stop-RayBookDownExport 'InvalidSnapshot'
            }
            $teamCount = $readResult.TeamCount
        }
        Assert-RayBookDownNoCredentials $Session $labels
        $safeSnapshot = [ordered]@{
            SchemaVersion = 1; Connected = $true; DataRead = $true
            League = 'Funny League 2026-27'; Team = 'RayBookDown'; Platform = 'yahoo'; Season = 2026
            ScoringFormat = $scoringFormat; ScoringType = $scoringType; TeamCount = $teamCount
            PlayerCount = $players.Count; NamedPlayerCount = $namedPlayers
            Players = $players.ToArray(); RetrievedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        }
        $json = ConvertTo-Json -InputObject $safeSnapshot -Depth 5
        $temporary = Join-Path $directory ('.raybookdown-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($fullDestination)) {
            [IO.File]::Replace($temporary, $fullDestination, [Management.Automation.Language.NullString]::Value)
        }
        else { [IO.File]::Move($temporary, $fullDestination) }
        $temporary = $null
        return [pscustomobject]@{
            Exported = $true; PlayerCount = $players.Count; OutputFile = $fullDestination
            ErrorType = $null; HttpStatus = $status; NextAction = 'ImportJsonIntoDashboard'
        }
    }
    catch {
        $allowed = @('UnsupportedRuntime','MissingSession','InvalidSession','TeamReaderMissing','InvalidOutputPath',
            'OutputFolderMissing','InvalidSnapshot','CredentialDataDetected','TeamReadFailed','AccessTokenExpired',
            'AccessTokenRejected','AccessDenied','RequestTimeout','DataTransportError','TeamDataReadError',
            'UnsupportedRosterSchema','LeagueNotFound','AmbiguousLeague','TeamIdentityMismatch','MissingTeamIdentifiers')
        if ($allowed -ccontains $_.Exception.Data['ExportKind']) { $kind = [string]$_.Exception.Data['ExportKind'] }
        $next = 'ReportSafeSummary'
        if ($kind -in @('AccessTokenExpired','AccessTokenRejected')) { $next = 'RefreshThenRetry' }
        return [pscustomobject]@{
            Exported = $false; PlayerCount = $null; OutputFile = $null
            ErrorType = $kind; HttpStatus = $status; NextAction = $next
        }
    }
    finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        $readResult = $null
        $safeSnapshot = $null
        $json = $null
        $labels = $null
    }
}

Invoke-RayBookDownExport -Session $Session -Destination $OutputPath -Seconds $RequestTimeoutSeconds
