#requires -Version 5.1
# Internal helpers. Never invoke gh with a token in command-line arguments.
function Stop-FlaimCloudFailure {
    param([string]$Kind)
    $failure = [InvalidOperationException]::new('Flaim cloud operation failed.')
    $failure.Data['CloudKind'] = $Kind
    throw $failure
}

function New-FlaimCloudSecret {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 32768) { Stop-FlaimCloudFailure 'InvalidCredential' }
    $secret = [Security.SecureString]::new()
    for ($i = 0; $i -lt $Text.Length; $i++) { $secret.AppendChar($Text[$i]) }
    $secret.MakeReadOnly()
    return $secret
}

function Resolve-FlaimGitHubCli {
    $gh = Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $gh) { return $gh.Source }
    # An existing console may not have the PATH installed by the new GitHub CLI.
    $standardPath = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GitHub CLI\gh.exe'
    if ([IO.File]::Exists($standardPath)) { return $standardPath }
    Stop-FlaimCloudFailure 'GitHubCliMissing'
}

function Invoke-FlaimGh {
    param(
        [string[]]$GhArguments, [Security.SecureString]$Token,
        [Security.SecureString]$InputSecret, [string]$InputText,
        [switch]$ReturnOutput
    )
    $process = $null
    $start = $null
    $stdinWriter = $null
    $tokenText = $null
    $inputValue = $null
    $output = $null
    $tokenBstr = [IntPtr]::Zero
    $inputBstr = [IntPtr]::Zero
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($null -eq $Token -or $Token.Length -le 0) { Stop-FlaimCloudFailure 'InvalidCredential' }
        $hasInputText = $PSBoundParameters.ContainsKey('InputText')
        if ($null -ne $InputSecret -and $hasInputText) { Stop-FlaimCloudFailure 'InvalidCloudRequest' }
        foreach ($argument in $GhArguments) {
            if ($argument -cnotmatch '^[-A-Za-z0-9_./:=+@\[\]]+$') { Stop-FlaimCloudFailure 'InvalidCloudRequest' }
        }
        $ghPath = Resolve-FlaimGitHubCli
        $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
        $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ghPath
        $start.Arguments = $GhArguments -join ' '
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $start.EnvironmentVariables['GH_TOKEN'] = $tokenText
        $start.EnvironmentVariables['GH_HOST'] = 'github.com'
        $start.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
        $start.EnvironmentVariables['GH_NO_UPDATE_NOTIFIER'] = '1'
        $start.EnvironmentVariables.Remove('GH_DEBUG')
        $start.EnvironmentVariables.Remove('GITHUB_TOKEN')
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        # Framework 4.x can emit the inherited input encoding's BOM at Start().
        # Select BOM-free UTF8 just for pipe creation, then restore immediately.
        $originalInputEncoding = [Console]::InputEncoding
        try {
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [void]$process.Start()
        }
        finally { [Console]::InputEncoding = $originalInputEncoding }
        $stdinWriter = [IO.StreamWriter]::new($process.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputSecret) {
            $inputBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($InputSecret)
            $inputValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($inputBstr)
            $writeTask = $stdinWriter.WriteAsync($inputValue)
        }
        elseif ($hasInputText) { $writeTask = $stdinWriter.WriteAsync($InputText) }
        else { $writeTask = $null }
        if ($null -ne $writeTask -and -not $writeTask.Wait([int][Math]::Max(1,45000-$clock.ElapsedMilliseconds))) {
            try { $process.Kill() } catch { }
            Stop-FlaimCloudFailure 'GitHubCommandTimeout'
        }
        $flushTask = $stdinWriter.FlushAsync()
        if (-not $flushTask.Wait([int][Math]::Max(1,45000-$clock.ElapsedMilliseconds))) {
            try { $process.Kill() } catch { }
            Stop-FlaimCloudFailure 'GitHubCommandTimeout'
        }
        $stdinWriter.Close()
        if (-not $process.WaitForExit([int][Math]::Max(1,45000-$clock.ElapsedMilliseconds))) {
            try { $process.Kill() } catch { }
            Stop-FlaimCloudFailure 'GitHubCommandTimeout'
        }
        if ($process.ExitCode -ne 0) { Stop-FlaimCloudFailure 'GitHubCommandFailed' }
        if ($ReturnOutput) {
            $output = $outTask.GetAwaiter().GetResult()
            if ($output.Length -gt 1048576) { Stop-FlaimCloudFailure 'InvalidCloudResponse' }
            return $output.Trim()
        }
        # Never forward subprocess diagnostics, which could include sensitive data.
    }
    finally {
        if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
        if ($inputBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($inputBstr) }
        if ($null -ne $start) { $start.EnvironmentVariables.Remove('GH_TOKEN') }
        if ($null -ne $stdinWriter) { try { $stdinWriter.Dispose() } catch { } }
        if ($null -ne $process) { $process.Dispose() }
        $tokenText = $null
        $inputValue = $null
        $output = $null
        $outTask = $null
        $errorTask = $null
        $writeTask = $null
        $flushTask = $null
    }
}

function Set-FlaimEnvironmentSecret {
    param([string]$Name, [Security.SecureString]$Value, [Security.SecureString]$WriterToken)
    if (@('FLAIM_REFRESH_TOKEN','FLAIM_SECRET_WRITER') -cnotcontains $Name) { Stop-FlaimCloudFailure 'InvalidCloudRequest' }
    if ($null -eq $Value -or $Value.Length -le 0) { Stop-FlaimCloudFailure 'InvalidCredential' }
    $null = Invoke-FlaimGh -GhArguments @('secret','set',$Name,'--app','actions','--repo','iverson761011-web/raybookdown','--env','flaim') -Token $WriterToken -InputSecret $Value
}
