#requires -Version 5.1
<#
.SYNOPSIS
    Read-only Flaim league settings and RayBookDown roster test.
.DESCRIPTION
    Run in the console that holds the OAuth session:
      & .\Flaim-Team-Test.ps1 -Session $FlaimSession | Format-List
    Returns a selected, sanitized summary only. No credential files are created.
    Does not refresh tokens or modify the supplied OAuth session.
    Supports modern 2026-07-28 and legacy Streamable HTTP JSON / SSE.
#>
[CmdletBinding()]
param(
    [object]$Session,
    [ValidateRange(5, 120)]
    [int]$RequestTimeoutSeconds = 30,
    [ValidateLength(1, 200)]
    [string]$LeagueName = 'Funny League 2026-27',
    [ValidateLength(1, 200)]
    [string]$TeamName = 'RayBookDown',
    [ValidateRange(2000, 2200)]
    [int]$SeasonYear = 2026,
    [switch]$ShowPlayers
)

function Stop-FlaimDataFailure {
    param([string]$Kind, [int]$HttpStatus = 0)
    $failure = [InvalidOperationException]::new('Flaim data test failed.')
    $failure.Data['FlaimKind'] = $Kind
    $failure.Data['FlaimHttpStatus'] = $HttpStatus
    throw $failure
}

function New-FlaimDataHttpClient {
    param([int]$Seconds)
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseDefaultCredentials = $false
    $handler.Credentials = $null
    $handler.UseCookies = $false
    $handler.UseProxy = $false
    $handler.CheckCertificateRevocationList = $true
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds($Seconds)
    [void]$client.DefaultRequestHeaders.Accept.ParseAdd('application/json, text/event-stream')
    return $client
}

function ConvertFrom-FlaimDataJson {
    param([string]$Text)
    $parser = [Web.Script.Serialization.JavaScriptSerializer]::new()
    $parser.MaxJsonLength = 1048576
    $parser.RecursionLimit = 64
    try { return ,($parser.DeserializeObject($Text)) }
    catch { Stop-FlaimDataFailure 'InvalidDataResponse' }
}

function Get-FlaimSseMessage {
    param([string]$Text, [int]$ExpectedId)
    $normalized = $Text.TrimStart([char]0xfeff).Replace("`r`n", "`n").Replace("`r", "`n")
    $blocks = $normalized -split "`n`n"
    if ($blocks.Count -gt 257) { Stop-FlaimDataFailure 'ResponseTooLarge' }
    # The last block is incomplete until its terminating blank line arrives.
    for ($blockIndex = 0; $blockIndex -lt $blocks.Count - 1; $blockIndex++) {
        $dataLines = [Collections.Generic.List[string]]::new()
        foreach ($line in ($blocks[$blockIndex] -split "`n")) {
            if ($line.StartsWith('data:', [StringComparison]::Ordinal)) {
                $value = $line.Substring(5)
                if ($value.StartsWith(' ', [StringComparison]::Ordinal)) { $value = $value.Substring(1) }
                $dataLines.Add($value)
            }
        }
        if ($dataLines.Count -eq 0) { continue }
        $message = ConvertFrom-FlaimDataJson ($dataLines -join "`n")
        if ($message -isnot [Collections.IDictionary]) { Stop-FlaimDataFailure 'InvalidRpcResponse' }
        # Ignore progress/log notifications. Never display them or invoke server requests.
        if ($message.ContainsKey('method')) {
            if ($message.ContainsKey('id')) { Stop-FlaimDataFailure 'UnsupportedServerRequest' }
            continue
        }
        if ($message.ContainsKey('id') -and $message['id'] -is [int] -and $message['id'] -eq $ExpectedId) { return $message }
    }
    return $null
}

function Send-FlaimMcpRequest {
    param(
        [object]$Context,
        [string]$Method,
        [System.Collections.IDictionary]$Params = @{},
        [switch]$Notification,
        [switch]$AllowBadRequest
    )
    $request = $null
    $response = $null
    $stream = $null
    $storage = $null
    $cancel = [Threading.CancellationTokenSource]::new()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $Context.LastHttpStatus = 0
        $Context.NextId++
        $requestId = $Context.NextId
        $parameters = @{}
        foreach ($key in $Params.Keys) { $parameters[$key] = $Params[$key] }
        if ($Context.Modern) {
            $parameters['_meta'] = @{
                'io.modelcontextprotocol/protocolVersion' = $Context.Version
                'io.modelcontextprotocol/clientInfo' = @{ name = 'FlaimPowerShell'; version = '1.0.0' }
                'io.modelcontextprotocol/clientCapabilities' = @{}
            }
        }
        $message = @{ jsonrpc = '2.0'; method = $Method; params = $parameters }
        if (-not $Notification) { $message['id'] = $requestId }
        $serializer = [Web.Script.Serialization.JavaScriptSerializer]::new()
        $body = $serializer.Serialize($message)
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, 'https://api.flaim.app/mcp')
        $request.Content = [Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json')
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Context.Bearer)
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', $Context.Version)
        if ($Context.Modern) {
            [void]$request.Headers.TryAddWithoutValidation('Mcp-Method', $Method)
            if ($Method -ceq 'tools/call') { [void]$request.Headers.TryAddWithoutValidation('Mcp-Name', $Params['name']) }
        }
        if (-not [string]::IsNullOrEmpty($Context.SessionId)) {
            [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $Context.SessionId)
        }
        $cancel.CancelAfter($Context.Seconds * 1000)
        $sendTask = $Context.Client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)
        if (-not $sendTask.Wait($Context.Seconds * 1000)) { Stop-FlaimDataFailure 'RequestTimeout' }
        $response = $sendTask.GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $Context.LastHttpStatus = $status
        if ($status -eq 401) { Stop-FlaimDataFailure 'AccessTokenRejected' $status }
        if ($status -eq 403) { Stop-FlaimDataFailure 'AccessDenied' $status }
        if ($status -ge 300 -and $status -le 399) { Stop-FlaimDataFailure 'DataRedirectRejected' $status }
        if ($status -eq 404 -and -not [string]::IsNullOrEmpty($Context.SessionId)) {
            Stop-FlaimDataFailure 'McpSessionExpired' $status
        }
        if (-not $response.IsSuccessStatusCode -and -not ($AllowBadRequest -and $status -eq 400)) {
            Stop-FlaimDataFailure 'DataHttpError' $status
        }
        if ($Method -ceq 'initialize' -and $response.Headers.Contains('Mcp-Session-Id')) {
            $sessionIds = @($response.Headers.GetValues('Mcp-Session-Id'))
            if ($sessionIds.Count -ne 1 -or $sessionIds[0].Length -gt 4096 -or
                $sessionIds[0] -cnotmatch '^[\x21-\x7e]+$') { Stop-FlaimDataFailure 'InvalidRpcResponse' $status }
            $Context.SessionId = $sessionIds[0]
        }
        if ($Notification) {
            if ($status -ne 202) { Stop-FlaimDataFailure 'InvalidRpcResponse' $status }
            return $null
        }
        if ($status -ne 200 -and -not ($AllowBadRequest -and $status -eq 400)) {
            Stop-FlaimDataFailure 'InvalidRpcResponse' $status
        }
        $mediaType = ''
        if ($null -ne $response.Content.Headers.ContentType) { $mediaType = $response.Content.Headers.ContentType.MediaType }
        if ($AllowBadRequest -and $status -eq 400 -and $mediaType -ine 'application/json') { return $null }
        if ($mediaType -ine 'application/json' -and $mediaType -ine 'text/event-stream') {
            Stop-FlaimDataFailure 'InvalidRpcResponse' $status
        }
        $streamTask = $response.Content.ReadAsStreamAsync()
        $remaining = [int][Math]::Max(1, ($Context.Seconds * 1000) - $clock.ElapsedMilliseconds)
        if (-not $streamTask.Wait($remaining)) { Stop-FlaimDataFailure 'RequestTimeout' $status }
        $stream = $streamTask.GetAwaiter().GetResult()
        $storage = [IO.MemoryStream]::new()
        $buffer = [byte[]]::new(4096)
        $reply = $null
        while ($true) {
            $remaining = [int](($Context.Seconds * 1000) - $clock.ElapsedMilliseconds)
            if ($remaining -le 0) { Stop-FlaimDataFailure 'RequestTimeout' $status }
            $readTask = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
            if (-not $readTask.Wait($remaining)) { Stop-FlaimDataFailure 'RequestTimeout' $status }
            $count = $readTask.GetAwaiter().GetResult()
            if ($count -eq 0) { break }
            if ($storage.Length + $count -gt 1048576) { Stop-FlaimDataFailure 'ResponseTooLarge' $status }
            $storage.Write($buffer, 0, $count)
            if ($mediaType -ieq 'text/event-stream') {
                $reply = Get-FlaimSseMessage ([Text.Encoding]::UTF8.GetString($storage.ToArray())) $requestId
                if ($null -ne $reply) { break } # Do not wait for a persistent SSE stream to close.
            }
        }
        if ($mediaType -ieq 'application/json') {
            try { $reply = ConvertFrom-FlaimDataJson ([Text.Encoding]::UTF8.GetString($storage.ToArray())) }
            catch {
                if ($AllowBadRequest -and $status -eq 400) { return $null }
                throw
            }
        }
        if ($AllowBadRequest -and $status -eq 400) { return $reply }
        if ($reply -isnot [Collections.IDictionary] -or -not $reply.ContainsKey('jsonrpc') -or
            $reply['jsonrpc'] -cne '2.0' -or -not $reply.ContainsKey('id') -or
            $reply['id'] -isnot [int] -or $reply['id'] -ne $requestId -or
            ($reply.ContainsKey('result') -eq $reply.ContainsKey('error'))) {
            Stop-FlaimDataFailure 'InvalidRpcResponse' $status
        }
        if ($reply.ContainsKey('error')) { Stop-FlaimDataFailure 'RpcError' $status }
        if ($reply['result'] -isnot [Collections.IDictionary]) { Stop-FlaimDataFailure 'InvalidRpcResponse' $status }
        if ($reply['result'].ContainsKey('resultType') -and $reply['result']['resultType'] -cne 'complete') {
            Stop-FlaimDataFailure 'UnsupportedInteraction' $status
        }
        return $reply
    }
    finally {
        try { $cancel.Cancel() } catch { }
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $storage) { $storage.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $cancel.Dispose()
        $body = $null
        $reply = $null
        $message = $null
    }
}

function Start-FlaimLegacyMcp {
    param([object]$Context, [string]$PreferredVersion = '2025-11-25')
    $Context.Modern = $false
    $Context.Version = $PreferredVersion
    $Context.SessionId = $null
    $reply = Send-FlaimMcpRequest -Context $Context -Method 'initialize' -Params @{
        protocolVersion = $PreferredVersion
        capabilities = @{}
        clientInfo = @{ name = 'FlaimPowerShell'; version = '1.0.0' }
    }
    $result = $reply['result']
    if (-not $result.ContainsKey('protocolVersion') -or
        @('2025-11-25', '2025-06-18', '2025-03-26') -cnotcontains $result['protocolVersion']) {
        Stop-FlaimDataFailure 'ProtocolUnsupported' $Context.LastHttpStatus
    }
    if (-not $result.ContainsKey('capabilities') -or $result['capabilities'] -isnot [Collections.IDictionary] -or
        -not $result['capabilities'].ContainsKey('tools')) { Stop-FlaimDataFailure 'ToolsUnavailable' }
    $Context.Version = $result['protocolVersion']
    $null = Send-FlaimMcpRequest -Context $Context -Method 'notifications/initialized' -Notification
}

function ConvertTo-FlaimDataLabel {
    param([object]$Value, [string]$Bearer)
    if ($Value -isnot [string] -and $Value -isnot [int] -and $Value -isnot [long]) { return $null }
    $label = [string]$Value
    if (-not [string]::IsNullOrEmpty($Bearer) -and $label.IndexOf($Bearer, [StringComparison]::Ordinal) -ge 0) {
        return '[redacted]'
    }
    $label = [Text.RegularExpressions.Regex]::Replace($label, '[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', ' ')
    if ($label.Length -gt 200) { $label = $label.Substring(0, 200) }
    return $label
}

function Assert-FlaimTeamArguments {
    param([Collections.IDictionary]$Tools, [string]$Name, [Collections.IDictionary]$Arguments)
    if (-not $Tools.ContainsKey($Name)) { Stop-FlaimDataFailure 'TeamToolUnavailable' }
    $tool = $Tools[$Name]
    if (-not $tool.ContainsKey('inputSchema') -or $tool['inputSchema'] -isnot [Collections.IDictionary]) {
        Stop-FlaimDataFailure 'UnsupportedToolSchema'
    }
    $schema = $tool['inputSchema']
    if (-not $schema.ContainsKey('properties') -or $schema['properties'] -isnot [Collections.IDictionary]) {
        Stop-FlaimDataFailure 'UnsupportedToolSchema'
    }
    if ($schema.ContainsKey('required')) {
        if ($schema['required'] -isnot [Array]) { Stop-FlaimDataFailure 'UnsupportedToolSchema' }
        foreach ($required in $schema['required']) {
            if ($required -isnot [string] -or -not $Arguments.Contains($required)) { Stop-FlaimDataFailure 'UnsupportedToolSchema' }
        }
    }
    foreach ($key in $Arguments.Keys) {
        if (-not $schema['properties'].ContainsKey($key) -or $schema['properties'][$key] -isnot [Collections.IDictionary]) {
            Stop-FlaimDataFailure 'UnsupportedToolSchema'
        }
        $definition = $schema['properties'][$key]
        if ($definition.ContainsKey('type')) {
            $types = @($definition['type'])
            $valid = (($types -ccontains 'string') -and $Arguments[$key] -is [string]) -or
                (($types -ccontains 'integer') -and $Arguments[$key] -is [int]) -or
                (($types -ccontains 'number') -and $Arguments[$key] -is [int])
            if (-not $valid) { Stop-FlaimDataFailure 'UnsupportedToolSchema' }
        }
        if ($definition.ContainsKey('enum') -and @($definition['enum']) -cnotcontains $Arguments[$key]) {
            Stop-FlaimDataFailure 'UnsupportedToolSchema'
        }
    }
}

function Read-FlaimTeamToolData {
    param([object]$Context, [string]$Name, [Collections.IDictionary]$Arguments)
    $reply = Send-FlaimMcpRequest -Context $Context -Method 'tools/call' -Params @{ name = $Name; arguments = $Arguments }
    $result = $reply['result']
    if ($result.ContainsKey('isError') -and $result['isError'] -ne $false) { Stop-FlaimDataFailure 'TeamDataReadError' }
    $payload = $null
    if ($result.ContainsKey('structuredContent') -and $result['structuredContent'] -is [Collections.IDictionary]) {
        $payload = $result['structuredContent']
    }
    elseif ($result.ContainsKey('content') -and $result['content'] -is [Array]) {
        foreach ($block in $result['content']) {
            if ($block -is [Collections.IDictionary] -and $block.ContainsKey('type') -and $block['type'] -ceq 'text' -and
                $block.ContainsKey('text') -and $block['text'] -is [string]) {
                try {
                    $candidate = ConvertFrom-FlaimDataJson $block['text']
                    if ($candidate -is [Collections.IDictionary] -and $candidate.ContainsKey('data')) { $payload = $candidate; break }
                }
                catch { }
            }
        }
    }
    if ($payload -isnot [Collections.IDictionary] -or
        ($payload.ContainsKey('success') -and $payload['success'] -ne $true) -or
        -not $payload.ContainsKey('data') -or $payload['data'] -isnot [Collections.IDictionary]) {
        Stop-FlaimDataFailure 'TeamDataReadError'
    }
    return $payload['data']
}

function Read-FlaimTeamContext {
    param(
        [object]$Context, [Collections.IDictionary]$Tools, [Collections.IDictionary]$Data,
        [string]$LeagueName, [string]$TeamName, [int]$SeasonYear
    )
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($league in $Data['allLeagues']) {
        if ($league -isnot [Collections.IDictionary]) { continue }
        if (-not $league.ContainsKey('sport') -or $league['sport'] -cne 'basketball' -or
            -not $league.ContainsKey('platform') -or $league['platform'] -cne 'yahoo' -or
            -not $league.ContainsKey('leagueName') -or $league['leagueName'] -cne $LeagueName -or
            -not $league.ContainsKey('seasonYear') -or [string]$league['seasonYear'] -cne [string]$SeasonYear) { continue }
        $matches.Add($league)
    }
    if ($matches.Count -eq 0) { Stop-FlaimDataFailure 'LeagueNotFound' }
    if ($matches.Count -ne 1) { Stop-FlaimDataFailure 'AmbiguousLeague' }
    $selected = $matches[0]
    if (-not $selected.ContainsKey('teamName') -or $selected['teamName'] -cne $TeamName) {
        Stop-FlaimDataFailure 'TeamIdentityMismatch'
    }
    foreach ($idKey in @('leagueId', 'teamId')) {
        if (-not $selected.ContainsKey($idKey) -or $selected[$idKey] -isnot [string] -or
            $selected[$idKey].Length -gt 512 -or $selected[$idKey] -cnotmatch '^[\x21-\x7e]+$') {
            Stop-FlaimDataFailure 'MissingTeamIdentifiers'
        }
    }
    # Use the exact IDs and start year returned by get_user_session.
    $leagueArguments = [ordered]@{
        league_id = $selected['leagueId']; platform = $selected['platform']
        season_year = [int]$selected['seasonYear']; sport = 'basketball'
    }
    $rosterArguments = [ordered]@{
        league_id = $selected['leagueId']; platform = $selected['platform']
        season_year = [int]$selected['seasonYear']; sport = 'basketball'; team_id = $selected['teamId']
    }
    Assert-FlaimTeamArguments $Tools 'get_league_info' $leagueArguments
    Assert-FlaimTeamArguments $Tools 'get_roster' $rosterArguments
    $settings = Read-FlaimTeamToolData $Context 'get_league_info' $leagueArguments
    if (($settings.ContainsKey('name') -and $settings['name'] -cne $LeagueName) -or
        ($settings.ContainsKey('sport') -and $settings['sport'] -cne 'basketball')) {
        Stop-FlaimDataFailure 'LeagueIdentityMismatch'
    }
    if ($settings.ContainsKey('season') -and [string]$settings['season'] -cmatch '^[0-9]{4}$' -and
        [string]$settings['season'] -cne [string]$SeasonYear) { Stop-FlaimDataFailure 'LeagueIdentityMismatch' }
    $roster = Read-FlaimTeamToolData $Context 'get_roster' $rosterArguments
    if ($roster.ContainsKey('teamName') -and $roster['teamName'] -cne $TeamName) { Stop-FlaimDataFailure 'TeamIdentityMismatch' }
    if ($roster.ContainsKey('snapshot') -and $roster['snapshot'] -is [Collections.IDictionary] -and
        $roster['snapshot'].ContainsKey('type') -and $roster['snapshot']['type'] -cne 'current') {
        Stop-FlaimDataFailure 'UnexpectedRosterSnapshot'
    }
    if (-not $roster.ContainsKey('players') -or $roster['players'] -isnot [Array]) {
        Stop-FlaimDataFailure 'UnsupportedRosterSchema'
    }
    if ($roster['players'].Count -gt 100) { Stop-FlaimDataFailure 'ResponseTooLarge' }
    $players = [Collections.Generic.List[object]]::new()
    $namedPlayers = 0
    foreach ($entry in $roster['players']) {
        if ($entry -isnot [Collections.IDictionary]) { Stop-FlaimDataFailure 'UnsupportedRosterSchema' }
        $playerName = $null
        foreach ($field in @('name', 'fullName', 'playerName')) {
            if ($entry.ContainsKey($field) -and $entry[$field] -is [string]) {
                $playerName = ConvertTo-FlaimDataLabel $entry[$field] $Context.Bearer
                break
            }
        }
        if ($null -eq $playerName -and $entry.ContainsKey('name') -and $entry['name'] -is [Collections.IDictionary] -and
            $entry['name'].ContainsKey('full') -and $entry['name']['full'] -is [string]) {
            $playerName = ConvertTo-FlaimDataLabel $entry['name']['full'] $Context.Bearer
        }
        if (-not [string]::IsNullOrWhiteSpace($playerName)) { $namedPlayers++ }
        $position = $null
        foreach ($field in @('selectedPosition', 'position', 'lineupSlot')) {
            if ($entry.ContainsKey($field) -and $entry[$field] -is [string]) {
                $position = ConvertTo-FlaimDataLabel $entry[$field] $Context.Bearer
                break
            }
        }
        $status = $null
        foreach ($field in @('injuryStatus', 'status')) {
            if ($entry.ContainsKey($field) -and $entry[$field] -is [string]) {
                $status = ConvertTo-FlaimDataLabel $entry[$field] $Context.Bearer
                break
            }
        }
        $eligibility = $null
        if ($entry.ContainsKey('eligiblePositions') -and $entry['eligiblePositions'] -is [Array]) {
            if ($entry['eligiblePositions'].Count -gt 32) { Stop-FlaimDataFailure 'ResponseTooLarge' }
            $values = [Collections.Generic.List[string]]::new()
            foreach ($value in $entry['eligiblePositions']) {
                if ($value -is [string]) { $values.Add((ConvertTo-FlaimDataLabel $value $Context.Bearer)) }
            }
            if ($values.Count -gt 0) { $eligibility = $values -join ', ' }
        }
        $players.Add([pscustomobject]@{ Player = $playerName; Position = $position; Status = $status; EligiblePositions = $eligibility })
    }
    $format = $null
    if ($settings.ContainsKey('scoringFormat') -and @('points', 'categories', 'roto', 'unknown') -ccontains $settings['scoringFormat']) {
        $format = $settings['scoringFormat']
    }
    $scoringType = $null
    if ($settings.ContainsKey('scoringType')) { $scoringType = ConvertTo-FlaimDataLabel $settings['scoringType'] $Context.Bearer }
    $teamCount = $null
    foreach ($field in @('numTeams', 'size')) {
        if ($settings.ContainsKey($field) -and [string]$settings[$field] -cmatch '^[0-9]{1,3}$' -and [int]$settings[$field] -gt 0) {
            $teamCount = [int]$settings[$field]
            break
        }
    }
    $modifiers = [Collections.Generic.List[object]]::new()
    if ($settings.ContainsKey('statModifiers') -and $settings['statModifiers'] -is [Array]) {
        if ($settings['statModifiers'].Count -gt 100) { Stop-FlaimDataFailure 'ResponseTooLarge' }
        foreach ($modifier in $settings['statModifiers']) {
            if ($modifier -isnot [Collections.IDictionary]) { continue }
            $statName = $null
            foreach ($field in @('displayName', 'name')) {
                if ($modifier.ContainsKey($field) -and $modifier[$field] -is [string]) {
                    $statName = ConvertTo-FlaimDataLabel $modifier[$field] $Context.Bearer
                    break
                }
            }
            $value = $null
            if ($modifier.ContainsKey('value') -and ($modifier['value'] -is [int] -or $modifier['value'] -is [long] -or
                $modifier['value'] -is [decimal] -or $modifier['value'] -is [double])) { $value = $modifier['value'] }
            $modifiers.Add([pscustomobject]@{ Stat = $statName; Value = $value })
        }
    }
    $nextAction = 'ReadyForDashboard'
    if ($players.Count -gt 0 -and $namedPlayers -ne $players.Count) { $nextAction = 'CheckRosterNameMapping' }
    return [pscustomobject]@{
        Connected = $true; DataRead = $true
        League = (ConvertTo-FlaimDataLabel $selected['leagueName'] $Context.Bearer)
        Team = (ConvertTo-FlaimDataLabel $selected['teamName'] $Context.Bearer)
        Platform = 'yahoo'; Season = [int]$selected['seasonYear']
        ScoringFormat = $format; ScoringType = $scoringType; TeamCount = $teamCount
        StatModifiers = $modifiers.ToArray(); PlayerCount = $players.Count; NamedPlayerCount = $namedPlayers
        Players = $players.ToArray(); ErrorType = $null; HttpStatus = $Context.LastHttpStatus; NextAction = $nextAction
    }
}

function Invoke-FlaimDataTest {
    param(
        [object]$Session, [int]$Seconds = 30, [switch]$ReadTeam,
        [string]$LeagueName = 'Funny League 2026-27', [string]$TeamName = 'RayBookDown', [int]$SeasonYear = 2026
    )
    $ErrorActionPreference = 'Stop'
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version 2.0
    $client = $null
    $context = $null
    $bearer = $null
    $bstr = [IntPtr]::Zero
    $connected = $false
    $toolCount = 0
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            Stop-FlaimDataFailure 'UnsupportedRuntime'
        }
        if ($null -eq $Session) { Stop-FlaimDataFailure 'MissingSession' }
        $accessProperty = $Session.PSObject.Properties['AccessToken']
        if ($null -eq $accessProperty -or $accessProperty -isnot [Management.Automation.PSNoteProperty] -or
            $accessProperty.Value -isnot [Security.SecureString] -or $accessProperty.Value.Length -le 0) {
            Stop-FlaimDataFailure 'InvalidSession'
        }
        $expiry = $Session.PSObject.Properties['ExpiresAtUtc']
        if ($null -ne $expiry -and $expiry -is [Management.Automation.PSNoteProperty] -and
            $expiry.Value -is [DateTimeOffset] -and $expiry.Value -le [DateTimeOffset]::UtcNow) {
            Stop-FlaimDataFailure 'AccessTokenExpired'
        }
        Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        if ($null -ne [Net.ServicePointManager]::ServerCertificateValidationCallback) {
            Stop-FlaimDataFailure 'UnsafeTlsConfiguration'
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($accessProperty.Value)
        try { $bearer = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            $bstr = [IntPtr]::Zero
        }
        if ($bearer.Length -gt 32768 -or $bearer -cnotmatch '^[A-Za-z0-9._~+/-]+=*$') {
            Stop-FlaimDataFailure 'InvalidSession'
        }
        $client = New-FlaimDataHttpClient -Seconds $Seconds
        $context = [pscustomobject]@{
            Client = $client; Bearer = $bearer; Version = '2026-07-28'; Modern = $true
            SessionId = $null; NextId = 0; Seconds = $Seconds; LastHttpStatus = 0
        }
        $reply = Send-FlaimMcpRequest -Context $context -Method 'tools/list' -AllowBadRequest
        if ($context.LastHttpStatus -eq 400) {
            $legacyVersion = '2025-11-25'
            if ($reply -is [Collections.IDictionary] -and $reply.ContainsKey('error') -and
                $reply['error'] -is [Collections.IDictionary] -and $reply['error'].ContainsKey('code')) {
                $rpcCode = $reply['error']['code']
                if ($rpcCode -in @(-32020, -32021)) { Stop-FlaimDataFailure 'ProtocolMetadataRejected' 400 }
                if ($rpcCode -eq -32022) {
                    $legacyVersion = $null
                    if ($reply['error'].ContainsKey('data') -and $reply['error']['data'] -is [Collections.IDictionary] -and
                        $reply['error']['data'].ContainsKey('supported')) {
                        $supported = @($reply['error']['data']['supported'])
                        foreach ($known in @('2025-11-25', '2025-06-18', '2025-03-26')) {
                            if ($supported -ccontains $known) { $legacyVersion = $known; break }
                        }
                    }
                    if ($null -eq $legacyVersion) { Stop-FlaimDataFailure 'ProtocolUnsupported' 400 }
                }
            }
            Start-FlaimLegacyMcp $context $legacyVersion
            $reply = Send-FlaimMcpRequest -Context $context -Method 'tools/list'
        }
        $tools = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        $seenCursors = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $sessionTool = $null
        for ($page = 0; $page -lt 10; $page++) {
            $result = $reply['result']
            if (-not $result.ContainsKey('tools') -or $result['tools'] -isnot [Array]) {
                Stop-FlaimDataFailure 'InvalidToolList' $context.LastHttpStatus
            }
            $connected = $true
            foreach ($tool in $result['tools']) {
                if ($tool -isnot [Collections.IDictionary] -or -not $tool.ContainsKey('name') -or
                    $tool['name'] -isnot [string] -or $tool['name'].Length -gt 128) {
                    Stop-FlaimDataFailure 'InvalidToolList'
                }
                if (-not $tools.ContainsKey($tool['name'])) { $tools.Add($tool['name'], $tool) }
                if ($tool['name'] -ceq 'get_user_session') { $sessionTool = $tool }
            }
            $toolCount = $tools.get_Count()
            if (-not $result.ContainsKey('nextCursor')) { break }
            $cursor = $result['nextCursor']
            if ($cursor -isnot [string] -or [string]::IsNullOrEmpty($cursor) -or $cursor.Length -gt 4096 -or
                -not $seenCursors.Add($cursor)) { Stop-FlaimDataFailure 'InvalidPagination' }
            if ($page -eq 9) { Stop-FlaimDataFailure 'PaginationLimit' }
            $reply = Send-FlaimMcpRequest -Context $context -Method 'tools/list' -Params @{ cursor = $cursor }
        }
        if ($null -eq $sessionTool) { Stop-FlaimDataFailure 'SessionToolUnavailable' }
        if (-not $sessionTool.ContainsKey('inputSchema') -or $sessionTool['inputSchema'] -isnot [Collections.IDictionary]) {
            Stop-FlaimDataFailure 'UnsupportedToolSchema'
        }
        $schema = $sessionTool['inputSchema']
        if ($schema.ContainsKey('required') -and @($schema['required']).Count -gt 0) {
            Stop-FlaimDataFailure 'UnsupportedToolSchema'
        }
        $reply = Send-FlaimMcpRequest -Context $context -Method 'tools/call' -Params @{ name = 'get_user_session'; arguments = @{} }
        $result = $reply['result']
        if ($result.ContainsKey('isError') -and $result['isError'] -ne $false) { Stop-FlaimDataFailure 'SessionReadError' }
        $data = $null
        if ($result.ContainsKey('structuredContent') -and $result['structuredContent'] -is [Collections.IDictionary]) {
            $data = $result['structuredContent']
        }
        elseif ($result.ContainsKey('content') -and $result['content'] -is [Array]) {
            foreach ($block in $result['content']) {
                if ($block -is [Collections.IDictionary] -and $block.ContainsKey('type') -and $block['type'] -ceq 'text' -and
                    $block.ContainsKey('text') -and $block['text'] -is [string]) {
                    try {
                        $candidate = ConvertFrom-FlaimDataJson $block['text']
                        if ($candidate -is [Collections.IDictionary] -and $candidate.ContainsKey('allLeagues')) { $data = $candidate; break }
                    }
                    catch { }
                }
            }
        }
        if ($data -isnot [Collections.IDictionary] -or -not $data.ContainsKey('allLeagues') -or
            $data['allLeagues'] -isnot [Array] -or
            ($data.ContainsKey('success') -and $data['success'] -ne $true)) {
            Stop-FlaimDataFailure 'SessionReadError'
        }
        if ($data['allLeagues'].Count -gt 1000) { Stop-FlaimDataFailure 'ResponseTooLarge' }
        if ($ReadTeam) { return Read-FlaimTeamContext $context $tools $data $LeagueName $TeamName $SeasonYear }
        $leagues = [Collections.Generic.List[object]]::new()
        foreach ($league in $data['allLeagues']) {
            if ($league -isnot [Collections.IDictionary] -or -not $league.ContainsKey('sport')) { continue }
            if ($league['sport'] -isnot [string] -or $league['sport'] -ine 'basketball') { continue }
            $selected = [ordered]@{}
            foreach ($mapping in @(@('League', 'leagueName'), @('Platform', 'platform'), @('Team', 'teamName'), @('Season', 'seasonYear'))) {
                $selected[$mapping[0]] = $null
                if ($league.ContainsKey($mapping[1])) { $selected[$mapping[0]] = ConvertTo-FlaimDataLabel $league[$mapping[1]] $bearer }
            }
            $leagues.Add([pscustomobject]$selected)
        }
        $next = 'ChooseBasketballLeague'
        if ($leagues.Count -eq 0) { $next = 'ConnectBasketballLeagueInFlaim' }
        return [pscustomobject]@{
            Connected = $true; DataRead = $true; ToolCount = $toolCount
            BasketballLeagueCount = $leagues.Count; BasketballLeagues = $leagues.ToArray()
            ErrorType = $null; HttpStatus = $context.LastHttpStatus; NextAction = $next
        }
    }
    catch {
        $kind = 'DataTransportError'
        $status = 0
        if ($null -ne $context) { $status = $context.LastHttpStatus }
        $caught = $_.Exception
        $allowed = @('UnsupportedRuntime', 'MissingSession', 'InvalidSession', 'UnsafeTlsConfiguration', 'AccessTokenExpired',
            'RequestTimeout', 'AccessTokenRejected', 'AccessDenied', 'DataRedirectRejected', 'DataHttpError', 'McpSessionExpired',
            'InvalidDataResponse', 'InvalidRpcResponse', 'UnsupportedServerRequest', 'RpcError', 'UnsupportedInteraction',
            'ResponseTooLarge', 'ProtocolUnsupported', 'ProtocolMetadataRejected', 'ToolsUnavailable', 'InvalidToolList',
            'SessionToolUnavailable', 'UnsupportedToolSchema', 'InvalidPagination', 'PaginationLimit', 'SessionReadError',
            'TeamToolUnavailable', 'TeamDataReadError', 'LeagueNotFound', 'AmbiguousLeague', 'TeamIdentityMismatch',
            'LeagueIdentityMismatch', 'MissingTeamIdentifiers', 'UnexpectedRosterSnapshot', 'UnsupportedRosterSchema')
        if ($allowed -ccontains $caught.Data['FlaimKind']) { $kind = [string]$caught.Data['FlaimKind'] }
        if ($caught.Data['FlaimHttpStatus'] -is [int] -and $caught.Data['FlaimHttpStatus'] -gt 0) {
            $status = [int]$caught.Data['FlaimHttpStatus']
        }
        $deepest = $caught
        while ($null -ne $deepest.InnerException) { $deepest = $deepest.InnerException }
        if ($deepest -is [OperationCanceledException]) { $kind = 'RequestTimeout' }
        $next = 'ReportSafeSummary'
        if ($kind -in @('AccessTokenExpired', 'AccessTokenRejected')) { $next = 'RefreshThenRetry' }
        if ($kind -eq 'McpSessionExpired') { $next = 'RunDataTestAgain' }
        if ($ReadTeam) {
            return [pscustomobject]@{
                Connected = $connected; DataRead = $false; League = $null; Team = $null; Platform = $null; Season = $null
                ScoringFormat = $null; ScoringType = $null; TeamCount = $null; StatModifiers = @()
                PlayerCount = $null; NamedPlayerCount = $null; Players = @()
                ErrorType = $kind; HttpStatus = $status; NextAction = $next
            }
        }
        return [pscustomobject]@{
            Connected = $connected; DataRead = $false; ToolCount = $toolCount
            BasketballLeagueCount = $null; BasketballLeagues = @()
            ErrorType = $kind; HttpStatus = $status; NextAction = $next
        }
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if ($null -ne $context) { $context.Bearer = $null; $context.SessionId = $null }
        if ($null -ne $client) { $client.Dispose() }
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        $bearer = $null
        $reply = $null
        $data = $null
        $candidate = $null
        $caught = $null
    }
}

$teamResult = Invoke-FlaimDataTest -Session $Session -Seconds $RequestTimeoutSeconds -ReadTeam -LeagueName $LeagueName -TeamName $TeamName -SeasonYear $SeasonYear
if ($ShowPlayers) {
    $teamResult | Select-Object Connected,DataRead,League,Team,Platform,Season,ScoringFormat,ScoringType,TeamCount,PlayerCount,NamedPlayerCount,ErrorType,HttpStatus,NextAction | Format-List
    if ($teamResult.DataRead -and $teamResult.Players.Count -gt 0) {
        Write-Host 'Players (position and status values are copied from the provider):'
        $teamResult.Players | Format-Table Player,Position,Status,EligiblePositions -AutoSize -Wrap
    }
    if ($teamResult.DataRead -and $teamResult.StatModifiers.Count -gt 0) {
        Write-Host 'Configured stat modifiers (bonus rules are not included in this table):'
        $teamResult.StatModifiers | Format-Table Stat,Value -AutoSize -Wrap
    }
}
else { $teamResult }
