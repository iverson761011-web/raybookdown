#requires -Version 5.1
<#
Run in the original console: & .\Flaim-Configure-GitHub.ps1 -Session $FlaimSession
Requires GitHub CLI and a fine-grained token for this repo with Environments write.
The token is requested with hidden input, never command-line arguments or files.
Requires the user-created environment flaim to allow ONLY the main branch.
#>
[CmdletBinding()]
param([object]$Session)

$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$writer = $null
try {
    if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'UnsupportedRuntime' }
    . (Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1')
    if ($null -eq $Session) { Stop-FlaimCloudFailure 'MissingRefreshToken' }
    $refreshProperty = $Session.PSObject.Properties['RefreshToken']
    if ($null -eq $refreshProperty -or $refreshProperty -isnot [Management.Automation.PSNoteProperty] -or
        -not $refreshProperty.IsSettable -or $refreshProperty.Value -isnot [Security.SecureString] -or $refreshProperty.Value.Length -le 0) {
        Stop-FlaimCloudFailure 'MissingRefreshToken'
    }
    $null = Resolve-FlaimGitHubCli
    Write-Host 'Destination: GitHub environment flaim in iverson761011-web/raybookdown.'
    Write-Host 'This stores the refresh token and its environment-only writer in GitHub Secrets.'
    $writer = Read-Host 'Enter the fine-grained GitHub token (hidden input)' -AsSecureString
    $environmentText = Invoke-FlaimGh -GhArguments @('api','repos/iverson761011-web/raybookdown/environments/flaim') -Token $writer -ReturnOutput
    $environment = ConvertFrom-Json -InputObject $environmentText -ErrorAction Stop
    if ($null -eq $environment.PSObject.Properties['deployment_branch_policy'] -or
        $null -eq $environment.deployment_branch_policy -or
        $environment.deployment_branch_policy.custom_branch_policies -ne $true) {
        Stop-FlaimCloudFailure 'MainBranchRestrictionRequired'
    }
    $policyText = Invoke-FlaimGh -GhArguments @('api','repos/iverson761011-web/raybookdown/environments/flaim/deployment-branch-policies') -Token $writer -ReturnOutput
    $policy = ConvertFrom-Json -InputObject $policyText -ErrorAction Stop
    if ($policy.total_count -ne 1 -or @($policy.branch_policies).Count -ne 1 -or
        $policy.branch_policies[0].name -cne 'main' -or $policy.branch_policies[0].type -cne 'branch') {
        Stop-FlaimCloudFailure 'MainBranchRestrictionRequired'
    }
    # Store the non-rotating writer first; then the current refresh token.
    Set-FlaimEnvironmentSecret 'FLAIM_SECRET_WRITER' $writer $writer
    Set-FlaimEnvironmentSecret 'FLAIM_REFRESH_TOKEN' $Session.RefreshToken $writer
    # Transfer refresh ownership to the serial cloud job. Do not reuse this family locally.
    $Session.RefreshToken.Dispose()
    $Session.RefreshToken = $null
    [pscustomobject]@{ Configured = $true; Repository = 'iverson761011-web/raybookdown'; Environment = 'flaim'; ErrorType = $null; NextAction = 'RunMainBranchWorkflow' }
}
catch {
    $kind = 'ConfigurationFailed'
    $allowed = @('MissingRefreshToken','GitHubCliMissing','InvalidCredential','GitHubCommandFailed','GitHubCommandTimeout','MainBranchRestrictionRequired')
    if ($allowed -ccontains $_.Exception.Data['CloudKind']) { $kind = [string]$_.Exception.Data['CloudKind'] }
    [pscustomobject]@{ Configured = $false; Repository = 'iverson761011-web/raybookdown'; Environment = 'flaim'; ErrorType = $kind; NextAction = 'CheckCloudSetupGuide' }
}
finally {
    if ($null -ne $writer) { $writer.Dispose() }
    $environmentText = $null
    $policyText = $null
}
