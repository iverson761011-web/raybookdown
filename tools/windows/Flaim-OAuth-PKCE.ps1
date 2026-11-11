#requires -Version 5.1
<#
.SYNOPSIS
    Flaim public-client OAuth 2.0 authorization code flow with PKCE S256.
.DESCRIPTION
    Run: $FlaimSession = & .\Flaim-OAuth-PKCE.ps1
    Success returns ONLY SecureString tokens and non-secret metadata.
    No credentials, raw HTTP bodies, callback URLs or exceptions are printed.
    No credential files, environment variables, or registry entries are created.
    Use an ordinary Windows PowerShell 5.1 console. No administrator is needed.
    Plaintext necessarily exists briefly during HTTPS exchange / JSON parsing;
    managed strings cannot be reliably erased. See the accompanying README.
#>
[CmdletBinding()]
param(
    [ValidateRange(10, 1800)]
    [int]$TimeoutSeconds = 300,
    [ValidateRange(5, 120)]
    [int]$TokenTimeoutSeconds = 30
)

function Stop-FlaimFailure {
    param([string]$Kind, [int]$HttpStatus = 0)
    $failure = New-Object System.InvalidOperationException -ArgumentList 'Flaim OAuth request failed.'
    $failure.Data['FlaimKind'] = $Kind
    $failure.Data['FlaimHttpStatus'] = $HttpStatus
    throw $failure
}

function New-FlaimRandomValue {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $rng.Dispose()
    }
}

function Get-FlaimS256Challenge {
    param([string]$Verifier)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [Text.Encoding]::ASCII.GetBytes($Verifier)
    $digest = $null
    try {
        $digest = $sha.ComputeHash($bytes)
        return [Convert]::ToBase64String($digest).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        if ($null -ne $digest) { [Array]::Clear($digest, 0, $digest.Length) }
        $sha.Dispose()
    }
}

function Test-FlaimState {
    param([string]$Expected, [string]$Actual)
    if ($null -eq $Actual -or $Actual.Length -ne $Expected.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        $difference = $difference -bor ([int][char]$Expected[$i] -bxor [int][char]$Actual[$i])
    }
    return ($difference -eq 0)
}

function ConvertTo-FlaimForm {
    param([System.Collections.IDictionary]$Values)
    $pairs = foreach ($key in $Values.Keys) {
        [Uri]::EscapeDataString([string]$key) + '=' + [Uri]::EscapeDataString([string]$Values[$key])
    }
    return ($pairs -join '&')
}

function Get-FlaimSafeOAuthError {
    param([object]$Value)
    # Only fixed, standard labels may reach the terminal.
    if ($Value -isnot [string]) { return 'oauth_error' }
    switch -CaseSensitive ($Value) {
        'access_denied' { return 'access_denied' }
        'invalid_request' { return 'invalid_request' }
        'invalid_client' { return 'invalid_client' }
        'invalid_grant' { return 'invalid_grant' }
        'unauthorized_client' { return 'unauthorized_client' }
        'unsupported_grant_type' { return 'unsupported_grant_type' }
        'unsupported_response_type' { return 'unsupported_response_type' }
        'invalid_scope' { return 'invalid_scope' }
        'server_error' { return 'server_error' }
        'temporarily_unavailable' { return 'temporarily_unavailable' }
        default { return 'oauth_error' }
    }
}

function Read-FlaimHttpRequest {
    param(
        [System.Net.Sockets.TcpClient]$Client,
        [System.Diagnostics.Stopwatch]$Clock,
        [int]$OverallTimeoutSeconds
    )
    $stream = $Client.GetStream()
    $stream.ReadTimeout = 500
    $buffer = New-Object byte[] 1024
    $text = New-Object Text.StringBuilder
    $requestClock = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($text.ToString().IndexOf("`r`n`r`n", [StringComparison]::Ordinal) -lt 0) {
            if ($Clock.Elapsed.TotalSeconds -ge $OverallTimeoutSeconds) { Stop-FlaimFailure 'CallbackTimeout' }
            if ($requestClock.Elapsed.TotalSeconds -ge 5) { Stop-FlaimFailure 'InvalidCallback' }
            $remainingMs = [Math]::Min((5 - $requestClock.Elapsed.TotalSeconds) * 1000,
                ($OverallTimeoutSeconds - $Clock.Elapsed.TotalSeconds) * 1000)
            $stream.ReadTimeout = [int][Math]::Max(1, [Math]::Min(500, $remainingMs))
            try { $count = $stream.Read($buffer, 0, $buffer.Length) }
            catch [System.IO.IOException] {
                # A short read timeout is not the absolute connection deadline.
                $readException = $_.Exception
                while ($null -ne $readException.InnerException) { $readException = $readException.InnerException }
                if ($readException -is [Net.Sockets.SocketException] -and
                    $readException.SocketErrorCode -eq [Net.Sockets.SocketError]::TimedOut) { continue }
                Stop-FlaimFailure 'InvalidCallback'
            }
            if ($count -le 0 -or ($text.Length + $count) -gt 16384) { Stop-FlaimFailure 'InvalidCallback' }
            for ($i = 0; $i -lt $count; $i++) {
                $value = $buffer[$i]
                if ($value -ge 127 -or ($value -lt 32 -and $value -notin @(9, 10, 13))) {
                    Stop-FlaimFailure 'InvalidCallback'
                }
            }
            [void]$text.Append([Text.Encoding]::ASCII.GetString($buffer, 0, $count))
        }
        $header = $text.ToString()
        $end = $header.IndexOf("`r`n`r`n", [StringComparison]::Ordinal)
        # No request body or pipelined requests are accepted.
        if ($end + 4 -ne $header.Length) { Stop-FlaimFailure 'InvalidCallback' }
        $lines = $header.Substring(0, $end) -split "`r`n"
        if ($lines.Count -gt 65 -or $lines[0] -cnotmatch '^GET ([^ ]+) HTTP/1\.[01]$') {
            Stop-FlaimFailure 'InvalidCallback'
        }
        $target = $Matches[1]
        if (-not $target.StartsWith('/', [StringComparison]::Ordinal) -or
            $target.StartsWith('//', [StringComparison]::Ordinal) -or $target.Contains('#')) {
            Stop-FlaimFailure 'InvalidCallback'
        }
        $headers = @{}
        for ($i = 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -cnotmatch '^([!#$%&''*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*)$') {
                Stop-FlaimFailure 'InvalidCallback'
            }
            $name = $Matches[1].ToLowerInvariant()
            if ($headers.ContainsKey($name)) { Stop-FlaimFailure 'InvalidCallback' }
            $headers[$name] = $Matches[2].Trim()
        }
        if (-not $headers.ContainsKey('host') -or $headers['host'] -cne '127.0.0.1:8765' -or
            $headers.ContainsKey('transfer-encoding') -or
            ($headers.ContainsKey('content-length') -and $headers['content-length'] -cne '0')) {
            Stop-FlaimFailure 'InvalidCallback'
        }
        return $target
    }
    finally {
        [Array]::Clear($buffer, 0, $buffer.Length)
        $text.Clear() | Out-Null
        $header = $null
        $target = $null
        $headers = $null
        $lines = $null
    }
}

function Send-FlaimBrowserResponse {
    param([System.Net.Sockets.TcpClient]$Client, [bool]$Accepted)
    # Fixed content only: never interpolate request, state, code, or error text.
    $nonce = New-FlaimRandomValue
    $message = 'Callback received. Check PowerShell for the result. You may close this tab.'
    $status = '200 OK'
    if (-not $Accepted) {
        $status = '400 Bad Request'
        $message = 'Request rejected. Check PowerShell for the result. You may close this tab.'
    }
    $html = '<!doctype html><meta charset="utf-8"><title>Flaim OAuth</title><p>' + $message +
        '</p><script nonce="' + $nonce + '">history.replaceState(null,"","/done");</script>'
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($html)
    $head = 'HTTP/1.1 ' + $status + "`r`nContent-Type: text/html; charset=utf-8`r`n" +
        'Content-Length: ' + $bodyBytes.Length + "`r`nConnection: close`r`nCache-Control: no-store`r`n" +
        "Pragma: no-cache`r`nReferrer-Policy: no-referrer`r`nX-Content-Type-Options: nosniff`r`n" +
        "Content-Security-Policy: default-src 'none'; script-src 'nonce-" + $nonce +
        "'; base-uri 'none'; frame-ancestors 'none'`r`n`r`n"
    try {
        $stream = $Client.GetStream()
        $stream.WriteTimeout = 1000
        $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($bodyBytes, 0, $bodyBytes.Length)
        $stream.Flush()
    }
    catch { } # A browser disconnect must not expose diagnostics or lose a valid code.
}

function Get-FlaimCallbackCode {
    param([string]$Target, [string]$ExpectedState)
    $question = $Target.IndexOf('?')
    if ($question -lt 0 -or $Target.Substring(0, $question) -cne '/callback') {
        Stop-FlaimFailure 'InvalidCallback'
    }
    $queryText = $Target.Substring($question + 1)
    if ($queryText -match '%(?![0-9A-Fa-f]{2})') { Stop-FlaimFailure 'InvalidCallback' }
    $query = New-Object 'System.Collections.Generic.Dictionary[string,string]' -ArgumentList ([StringComparer]::Ordinal)
    # OAuth parameter names are case-sensitive. Decode before checking duplicates.
    foreach ($pair in ($queryText -split '&')) {
        $equals = $pair.IndexOf('=')
        if ($equals -le 0) { Stop-FlaimFailure 'InvalidCallback' }
        $key = [System.Web.HttpUtility]::UrlDecode($pair.Substring(0, $equals))
        $value = [System.Web.HttpUtility]::UrlDecode($pair.Substring($equals + 1))
        if ($key -match '[\x00-\x20\x7f]' -or $query.ContainsKey($key)) { Stop-FlaimFailure 'InvalidCallback' }
        $query.Add($key, $value)
    }
    if (-not $query.ContainsKey('state') -or -not (Test-FlaimState $ExpectedState $query['state'])) {
        Stop-FlaimFailure 'StateMismatch'
    }
    $hasCode = $query.ContainsKey('code')
    $hasError = $query.ContainsKey('error')
    if ($hasCode -eq $hasError) { Stop-FlaimFailure 'InvalidCallback' }
    if ($hasError) {
        if ([string]::IsNullOrWhiteSpace($query['error'])) { Stop-FlaimFailure 'InvalidCallback' }
        Stop-FlaimFailure (Get-FlaimSafeOAuthError $query['error'])
    }
    $code = $query['code']
    if ([string]::IsNullOrWhiteSpace($code) -or $code.Length -gt 8192 -or $code -match '[^\x21-\x7e]') {
        Stop-FlaimFailure 'InvalidCallback'
    }
    return $code
}

function Open-FlaimBrowser {
    param([string]$Url)
    # A real browser must be visible for the user's sign-in and consent.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Url
    $start.UseShellExecute = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($null -ne $process) { $process.Dispose() }
}

function New-FlaimHttpClient {
    param([int]$Seconds)
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseDefaultCredentials = $false
    $handler.Credentials = $null
    $handler.UseCookies = $false
    # Direct connection: do not forward the exchange through a configured proxy.
    $handler.UseProxy = $false
    $handler.CheckCertificateRevocationList = $true
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler, $true
    $client.Timeout = [TimeSpan]::FromSeconds($Seconds)
    $client.MaxResponseContentBufferSize = 65536
    [void]$client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
    return $client
}

function Invoke-FlaimTokenExchange {
    param([string]$Code, [string]$Verifier, [int]$Seconds)
    $client = $null
    $request = $null
    $response = $null
    $payload = $null
    $jsonText = $null
    $secureAccess = $null
    $secureRefresh = $null
    $returned = $false
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        # Refuse an existing process-wide certificate-validation bypass.
        if ($null -ne [Net.ServicePointManager]::ServerCertificateValidationCallback) {
            Stop-FlaimFailure 'UnsafeTlsConfiguration'
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $client = New-FlaimHttpClient $Seconds
        $form = ConvertTo-FlaimForm ([ordered]@{
            grant_type = 'authorization_code'
            client_id = 'mcp_49dedf8e-77cf-4160-bb40-20c656c6b9cb'
            redirect_uri = 'http://127.0.0.1:8765/callback'
            code = $Code
            code_verifier = $Verifier
        })
        $request = New-Object Net.Http.HttpRequestMessage -ArgumentList ([Net.Http.HttpMethod]::Post), 'https://api.flaim.app/auth/token'
        $request.Content = New-Object Net.Http.StringContent -ArgumentList $form, ([Text.Encoding]::UTF8), 'application/x-www-form-urlencoded'
        try {
            $task = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseContentRead)
            $response = $task.GetAwaiter().GetResult()
        }
        catch {
            $exception = $_.Exception
            while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
            if ($exception -is [OperationCanceledException]) { Stop-FlaimFailure 'TokenTimeout' }
            if ($exception -is [Net.WebException] -and
                $exception.Status -in @([Net.WebExceptionStatus]::TrustFailure, [Net.WebExceptionStatus]::SecureChannelFailure)) {
                Stop-FlaimFailure 'TlsFailure'
            }
            Stop-FlaimFailure 'TokenTransportError'
        }
        $httpStatus = [int]$response.StatusCode
        if ($httpStatus -ge 300 -and $httpStatus -le 399) { Stop-FlaimFailure 'TokenRedirectRejected' $httpStatus }
        $readTask = $response.Content.ReadAsStringAsync()
        $jsonText = $readTask.GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $kind = 'TokenHttpError'
            # Inspect only the standardized error field; never report the body.
            try {
                $errorPayload = ConvertFrom-Json -InputObject $jsonText -ErrorAction Stop
                if ($null -ne $errorPayload -and $null -ne $errorPayload.PSObject.Properties['error']) {
                    $kind = Get-FlaimSafeOAuthError $errorPayload.error
                }
            }
            catch { }
            finally { $errorPayload = $null }
            Stop-FlaimFailure $kind $httpStatus
        }
        if ($httpStatus -ne 200) { Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus }
        $mediaType = $response.Content.Headers.ContentType
        if ($null -eq $mediaType -or $mediaType.MediaType -ine 'application/json') {
            Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus
        }
        try { $payload = ConvertFrom-Json -InputObject $jsonText -ErrorAction Stop }
        catch { Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus }
        if ($null -eq $payload -or $payload -is [Array] -or
            $null -eq $payload.PSObject.Properties['access_token'] -or
            $payload.access_token -isnot [string] -or [string]::IsNullOrWhiteSpace($payload.access_token) -or
            $payload.access_token.Length -gt 32768 -or $payload.access_token -match '[\x00-\x20\x7f]' -or
            $null -eq $payload.PSObject.Properties['token_type'] -or
            $payload.token_type -isnot [string] -or $payload.token_type -ine 'Bearer' -or
            $null -ne $payload.PSObject.Properties['error']) {
            Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus
        }
        $expiresAt = $null
        if ($null -ne $payload.PSObject.Properties['expires_in']) {
            $expiresSeconds = 0L
            if (-not [long]::TryParse([string]$payload.expires_in, [ref]$expiresSeconds) -or
                $expiresSeconds -le 0 -or $expiresSeconds -gt 315360000) {
                Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus
            }
            $expiresAt = [DateTimeOffset]::UtcNow.AddSeconds($expiresSeconds)
        }
        $secureAccess = ConvertTo-SecureString -String $payload.access_token -AsPlainText -Force
        $secureAccess.MakeReadOnly()
        if ($null -ne $payload.PSObject.Properties['refresh_token']) {
            if ($payload.refresh_token -isnot [string] -or [string]::IsNullOrWhiteSpace($payload.refresh_token) -or
                $payload.refresh_token.Length -gt 32768 -or $payload.refresh_token -match '[\x00-\x20\x7f]') {
                Stop-FlaimFailure 'InvalidTokenResponse' $httpStatus
            }
            $secureRefresh = ConvertTo-SecureString -String $payload.refresh_token -AsPlainText -Force
            $secureRefresh.MakeReadOnly()
        }
        $session = [pscustomobject]@{
            AccessToken = $secureAccess
            RefreshToken = $secureRefresh
            TokenType = 'Bearer'
            ExpiresAtUtc = $expiresAt
            ObtainedAtUtc = [DateTimeOffset]::UtcNow
        }
        $returned = $true
        return $session
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        if (-not $returned) {
            if ($null -ne $secureAccess) { $secureAccess.Dispose() }
            if ($null -ne $secureRefresh) { $secureRefresh.Dispose() }
        }
        # Drop references; immutable .NET strings cannot be guaranteed zeroed.
        $payload = $null
        $jsonText = $null
        $form = $null
        $Code = $null
        $Verifier = $null
        $task = $null
        $readTask = $null
        $exception = $null
    }
}

function Invoke-FlaimOAuth {
    param([int]$CallbackSeconds, [int]$ExchangeSeconds)
    $ErrorActionPreference = 'Stop'
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version 2.0
    $listener = $null
    $connection = $null
    $verifier = $null
    $state = $null
    $code = $null
    $session = $null
    $stage = 'InitializationError'
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            Stop-FlaimFailure 'UnsupportedRuntime'
        }
        Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
        Add-Type -AssemblyName System.Web -ErrorAction Stop
        $state = New-FlaimRandomValue
        $verifier = New-FlaimRandomValue
        $challenge = Get-FlaimS256Challenge $verifier
        $authorizationUrl = 'https://api.flaim.app/auth/authorize?' + (ConvertTo-FlaimForm ([ordered]@{
            response_type = 'code'
            client_id = 'mcp_49dedf8e-77cf-4160-bb40-20c656c6b9cb'
            redirect_uri = 'http://127.0.0.1:8765/callback'
            state = $state
            code_challenge = $challenge
            code_challenge_method = 'S256'
        }))
        $stage = 'ListenerStartError'
        $listener = New-Object Net.Sockets.TcpListener -ArgumentList ([Net.IPAddress]::Loopback), 8765
        $listener.ExclusiveAddressUse = $true
        $listener.Start(8)
        # The listening socket MUST exist before opening the external browser.
        Write-Host 'Local callback listener ready. Opening your browser for Flaim sign-in.'
        $stage = 'BrowserLaunchError'
        Open-FlaimBrowser $authorizationUrl
        $authorizationUrl = $null
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $stage = 'InvalidCallback'
        while ($null -eq $code) {
            if ($clock.Elapsed.TotalSeconds -ge $CallbackSeconds) { Stop-FlaimFailure 'CallbackTimeout' }
            if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
            $connection = $listener.AcceptTcpClient()
            try {
                if (-not [Net.IPAddress]::IsLoopback($connection.Client.RemoteEndPoint.Address)) {
                    Stop-FlaimFailure 'InvalidCallback'
                }
                $connection.NoDelay = $true
                $connection.SendTimeout = 1000
                $target = Read-FlaimHttpRequest $connection $clock $CallbackSeconds
                $path = ($target -split '\?', 2)[0]
                if ($path -cne '/callback') {
                    Send-FlaimBrowserResponse $connection $false
                    continue # Ignore favicon / unrelated paths without ending sign-in.
                }
                $code = Get-FlaimCallbackCode $target $state
                Send-FlaimBrowserResponse $connection $true
            }
            catch {
                Send-FlaimBrowserResponse $connection $false
                throw
            }
            finally {
                $connection.Close()
                $connection = $null
                $target = $null
            }
        }
        $listener.Stop()
        $listener = $null
        $stage = 'TokenTransportError'
        $session = Invoke-FlaimTokenExchange $code $verifier $ExchangeSeconds
        Write-Host 'Flaim authorization completed. Tokens returned as SecureString values in memory only.'
        return $session
    }
    catch {
        $kind = $stage
        $status = 0
        $safeKinds = @('UnsupportedRuntime', 'UnsafeTlsConfiguration', 'CallbackTimeout', 'InvalidCallback',
            'StateMismatch', 'TokenTimeout', 'TlsFailure', 'TokenTransportError',
            'TokenRedirectRejected', 'TokenHttpError', 'InvalidTokenResponse', 'access_denied',
            'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
            'unsupported_grant_type', 'unsupported_response_type', 'invalid_scope', 'server_error',
            'temporarily_unavailable', 'oauth_error')
        $failure = $_.Exception
        if ($safeKinds -ccontains $failure.Data['FlaimKind']) { $kind = [string]$failure.Data['FlaimKind'] }
        if ($failure.Data['FlaimHttpStatus'] -is [int]) { $status = [int]$failure.Data['FlaimHttpStatus'] }
        # Create a fresh, sanitized ErrorRecord. Never reuse the caught record.
        Write-Error -Message ('Flaim OAuth failed. Type={0}; HTTP={1}. No credentials were displayed.' -f $kind, $status) `
            -ErrorId ('FlaimOAuth.' + $kind) -Category InvalidOperation -ErrorAction Continue
    }
    finally {
        if ($null -ne $connection) { $connection.Close() }
        if ($null -ne $listener) { $listener.Stop() }
        $state = $null
        $verifier = $null
        $code = $null
        $authorizationUrl = $null
        $failure = $null
    }
}

Invoke-FlaimOAuth -CallbackSeconds $TimeoutSeconds -ExchangeSeconds $TokenTimeoutSeconds
