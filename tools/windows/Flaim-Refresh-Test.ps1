#requires -Version 5.1
<#
.SYNOPSIS
    Test a single Flaim refresh grant without displaying or saving credentials.
.DESCRIPTION
    Run in the SAME Windows PowerShell 5.1 console as the successful OAuth flow:
      & .\Flaim-Refresh-Test.ps1 -Session $FlaimSession
    Updates that session object only after validating a complete success response.
    Returns a safe status summary, never a token or a session object.
    Do NOT assign this script's output back to $FlaimSession.
    No automatic retry: a lost response can hide refresh-token rotation.
#>
[CmdletBinding()]
param(
    [object]$Session,
    [ValidateRange(5, 120)]
    [int]$TokenTimeoutSeconds = 30
)

function Stop-FlaimRefreshFailure {
    param([string]$Kind, [int]$HttpStatus = 0)
    $failure = [InvalidOperationException]::new('Flaim refresh failed.')
    $failure.Data['FlaimKind'] = $Kind
    $failure.Data['FlaimHttpStatus'] = $HttpStatus
    throw $failure
}

function Get-FlaimRefreshSafeError {
    param([object]$Value)
    if ($Value -isnot [string]) { return 'oauth_error' }
    switch -CaseSensitive ($Value) {
        'invalid_request' { return 'invalid_request' }
        'invalid_client' { return 'invalid_client' }
        'invalid_grant' { return 'invalid_grant' }
        'unauthorized_client' { return 'unauthorized_client' }
        'unsupported_grant_type' { return 'unsupported_grant_type' }
        'invalid_scope' { return 'invalid_scope' }
        'server_error' { return 'server_error' }
        'temporarily_unavailable' { return 'temporarily_unavailable' }
        default { return 'oauth_error' }
    }
}

function New-FlaimRefreshHttpClient {
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
    $client.MaxResponseContentBufferSize = 65536
    [void]$client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
    return $client
}

function Invoke-FlaimRefresh {
    param([object]$Session, [int]$Seconds = 30)
    $ErrorActionPreference = 'Stop'
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version 2.0
    $client = $null
    $request = $null
    $response = $null
    $payload = $null
    $errorPayload = $null
    $rawJson = $null
    $refreshText = $null
    $form = $null
    $bstr = [IntPtr]::Zero
    $newAccess = $null
    $newRefresh = $null
    $oldAccess = $null
    $oldRefresh = $null
    $secretsTransferred = $false
    $requestStarted = $false
    $status = 0
    $stage = 'InitializationError'
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        if ($PSVersionTable.PSEdition -ne 'Desktop' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            Stop-FlaimRefreshFailure 'UnsupportedRuntime'
        }
        if ($null -eq $Session) { Stop-FlaimRefreshFailure 'MissingSession' }
        foreach ($name in @('AccessToken', 'RefreshToken', 'TokenType', 'ExpiresAtUtc', 'ObtainedAtUtc')) {
            $property = $Session.PSObject.Properties[$name]
            if ($null -eq $property -or $property -isnot [Management.Automation.PSNoteProperty] -or -not $property.IsSettable) {
                Stop-FlaimRefreshFailure 'InvalidSession'
            }
        }
        if ($null -eq $Session.RefreshToken) { Stop-FlaimRefreshFailure 'MissingRefreshToken' }
        if ($Session.AccessToken -isnot [Security.SecureString] -or
            $Session.RefreshToken -isnot [Security.SecureString] -or
            $Session.AccessToken.Length -le 0 -or $Session.RefreshToken.Length -le 0 -or
            $Session.RefreshToken.Length -gt 32768) {
            Stop-FlaimRefreshFailure 'InvalidSession'
        }
        Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        if ($null -ne [Net.ServicePointManager]::ServerCertificateValidationCallback) {
            Stop-FlaimRefreshFailure 'UnsafeTlsConfiguration'
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $oldAccess = $Session.AccessToken
        $oldRefresh = $Session.RefreshToken
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($oldRefresh)
        try { $refreshText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            $bstr = [IntPtr]::Zero
        }
        if ($refreshText -match '[^\x21-\x7e]') { Stop-FlaimRefreshFailure 'InvalidSession' }
        $form = 'grant_type=refresh_token&client_id=mcp_49dedf8e-77cf-4160-bb40-20c656c6b9cb&refresh_token=' +
            [Uri]::EscapeDataString($refreshText)
        $client = New-FlaimRefreshHttpClient -Seconds $Seconds
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, 'https://api.flaim.app/auth/token')
        # Direct .NET constructors avoid binding plaintext to logging cmdlets.
        $request.Content = [Net.Http.StringContent]::new($form, [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
        $stage = 'RefreshTransportError'
        $requestStarted = $true
        try {
            $sendTask = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseContentRead)
            $response = $sendTask.GetAwaiter().GetResult()
        }
        catch {
            $transportFailure = $_.Exception
            while ($null -ne $transportFailure.InnerException) { $transportFailure = $transportFailure.InnerException }
            if ($transportFailure -is [OperationCanceledException]) { Stop-FlaimRefreshFailure 'RefreshTimeout' }
            if ($transportFailure -is [Net.WebException] -and
                $transportFailure.Status -in @([Net.WebExceptionStatus]::TrustFailure, [Net.WebExceptionStatus]::SecureChannelFailure)) {
                Stop-FlaimRefreshFailure 'TlsFailure'
            }
            Stop-FlaimRefreshFailure 'RefreshTransportError'
        }
        $status = [int]$response.StatusCode
        if ($status -ge 300 -and $status -le 399) { Stop-FlaimRefreshFailure 'RefreshRedirectRejected' $status }
        $readTask = $response.Content.ReadAsStringAsync()
        $rawJson = $readTask.GetAwaiter().GetResult()
        $parser = [Web.Script.Serialization.JavaScriptSerializer]::new()
        $parser.MaxJsonLength = 65536
        $parser.RecursionLimit = 16
        if (-not $response.IsSuccessStatusCode) {
            $kind = 'RefreshHttpError'
            try {
                $errorPayload = $parser.DeserializeObject($rawJson)
                if ($errorPayload -is [Collections.IDictionary] -and $errorPayload.ContainsKey('error')) {
                    $kind = Get-FlaimRefreshSafeError $errorPayload['error']
                }
            }
            catch { }
            Stop-FlaimRefreshFailure $kind $status
        }
        $stage = 'InvalidTokenResponse'
        if ($status -ne 200 -or $null -eq $response.Content.Headers.ContentType -or
            $response.Content.Headers.ContentType.MediaType -ine 'application/json') {
            Stop-FlaimRefreshFailure 'InvalidTokenResponse' $status
        }
        try { $payload = $parser.DeserializeObject($rawJson) }
        catch { Stop-FlaimRefreshFailure 'InvalidTokenResponse' $status }
        if ($payload -isnot [Collections.IDictionary] -or -not $payload.ContainsKey('access_token') -or
            $payload['access_token'] -isnot [string] -or [string]::IsNullOrWhiteSpace($payload['access_token']) -or
            $payload['access_token'].Length -gt 32768 -or $payload['access_token'] -match '[^\x21-\x7e]' -or
            -not $payload.ContainsKey('token_type') -or $payload['token_type'] -isnot [string] -or
            $payload['token_type'] -ine 'Bearer' -or $payload.ContainsKey('error')) {
            Stop-FlaimRefreshFailure 'InvalidTokenResponse' $status
        }
        $expiresAt = $null
        $obtainedAt = [DateTimeOffset]::UtcNow
        if ($payload.ContainsKey('expires_in')) {
            $expirySeconds = 0L
            if (-not [long]::TryParse([string]$payload['expires_in'], [ref]$expirySeconds) -or
                $expirySeconds -le 0 -or $expirySeconds -gt 315360000) {
                Stop-FlaimRefreshFailure 'InvalidTokenResponse' $status
            }
            $expiresAt = $obtainedAt.AddSeconds($expirySeconds)
        }
        $rotated = $false
        if ($payload.ContainsKey('refresh_token')) {
            if ($payload['refresh_token'] -isnot [string] -or [string]::IsNullOrWhiteSpace($payload['refresh_token']) -or
                $payload['refresh_token'].Length -gt 32768 -or $payload['refresh_token'] -match '[^\x21-\x7e]') {
                Stop-FlaimRefreshFailure 'InvalidTokenResponse' $status
            }
            $rotated = -not [string]::Equals($refreshText, $payload['refresh_token'], [StringComparison]::Ordinal)
        }
        $newAccess = [Security.SecureString]::new()
        for ($i = 0; $i -lt $payload['access_token'].Length; $i++) { $newAccess.AppendChar($payload['access_token'][$i]) }
        $newAccess.MakeReadOnly()
        if ($rotated) {
            $newRefresh = [Security.SecureString]::new()
            for ($i = 0; $i -lt $payload['refresh_token'].Length; $i++) { $newRefresh.AppendChar($payload['refresh_token'][$i]) }
            $newRefresh.MakeReadOnly()
        }
        # All validation and allocations are complete before changing the session.
        # Store a replacement refresh token first to minimize interruption risk.
        $secretsTransferred = $true
        if ($rotated) { $Session.RefreshToken = $newRefresh }
        $Session.AccessToken = $newAccess
        $Session.TokenType = 'Bearer'
        $Session.ExpiresAtUtc = $expiresAt
        $Session.ObtainedAtUtc = $obtainedAt
        try { $oldAccess.Dispose() } catch { }
        if ($rotated) { try { $oldRefresh.Dispose() } catch { } }
        return [pscustomobject]@{
            Refreshed = $true
            RefreshTokenRotated = $rotated
            ExpiresAtUtc = $expiresAt
            ErrorType = $null
            HttpStatus = $status
            NextAction = 'ReadyForDataAccess'
        }
    }
    catch {
        $kind = $stage
        $caught = $_.Exception
        $allowed = @('UnsupportedRuntime', 'MissingSession', 'InvalidSession', 'MissingRefreshToken',
            'UnsafeTlsConfiguration', 'RefreshTimeout', 'TlsFailure', 'RefreshTransportError',
            'RefreshRedirectRejected', 'RefreshHttpError', 'InvalidTokenResponse', 'invalid_request',
            'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type',
            'invalid_scope', 'server_error', 'temporarily_unavailable', 'oauth_error')
        if ($allowed -ccontains $caught.Data['FlaimKind']) { $kind = [string]$caught.Data['FlaimKind'] }
        if ($caught.Data['FlaimHttpStatus'] -is [int]) { $status = [int]$caught.Data['FlaimHttpStatus'] }
        $nextAction = 'CheckSessionOrRuntime'
        if ($requestStarted) { $nextAction = 'ReauthorizeBeforeRetry' }
        if ($kind -in @('invalid_client', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope')) {
            $nextAction = 'CheckClientConfiguration'
        }
        # Only fixed labels, booleans, and a numeric status reach the caller.
        return [pscustomobject]@{
            Refreshed = $false
            RefreshTokenRotated = $null
            ExpiresAtUtc = $null
            ErrorType = $kind
            HttpStatus = $status
            NextAction = $nextAction
        }
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        if (-not $secretsTransferred) {
            if ($null -ne $newAccess) { $newAccess.Dispose() }
            if ($null -ne $newRefresh) { $newRefresh.Dispose() }
        }
        # Drop references. Immutable managed plaintext strings cannot be zeroed.
        $payload = $null
        $errorPayload = $null
        $rawJson = $null
        $refreshText = $null
        $form = $null
        $sendTask = $null
        $readTask = $null
        $oldAccess = $null
        $oldRefresh = $null
        $transportFailure = $null
        $caught = $null
    }
}

Invoke-FlaimRefresh -Session $Session -Seconds $TokenTimeoutSeconds
