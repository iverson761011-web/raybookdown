#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1')
$tokens = $null
$parseErrors = $null
$syncAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Flaim-Scheduled-Sync.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'SyncSyntaxFailed' }
foreach ($statement in $syncAst.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$script:passed = 0
$script:failed = 0
function Test-Case {
    param([string]$Name,[scriptblock]$Body)
    try { & $Body; $script:passed++; Write-Output ('PASS '+$Name) }
    catch { $script:failed++; Write-Output ('FAIL '+$Name) }
}
function Assert-Cloud { param([bool]$Value) if (-not $Value) { throw 'AssertionFailed' } }
$scratch = Join-Path $PSScriptRoot ('.test-work\'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory((Join-Path $scratch 'data'))
[IO.File]::WriteAllText((Join-Path $scratch 'data\team.json'),'{}')
$writer = New-FlaimCloudSecret 'fake-writer'
$inputSecret = New-FlaimCloudSecret 'fake-refresh'
$repositoryToken = New-FlaimCloudSecret 'fake-repo-token'
$script:fakeGh = Join-Path $scratch 'FakeGh.exe'
Add-Type -OutputType ConsoleApplication -OutputAssembly $script:fakeGh -TypeDefinition @'
using System;
public class FakeGh {
  public static int Main(string[] args) {
    if (Environment.GetEnvironmentVariable("GH_TOKEN") != "fake-writer") return 7;
    if (string.Join(" ",args).Contains("fake-refresh")) return 8;
    var input=Console.In.ReadToEnd();
    if (args[0]=="probe" && input!="fake-refresh") return 9;
    Console.Out.Write("ok");
    Console.Error.Write("fake diagnostic must stay private");
    return 0;
  }
}
'@
function Get-Command {
    param([string]$Name,[object]$CommandType,[object]$ErrorAction)
    if ($Name -ceq 'gh.exe') { return [pscustomobject]@{ Source=$script:fakeGh } }
    throw 'UnexpectedCommandLookup'
}
Test-Case 'CLI passes secret by stdin and suppresses diagnostics' {
    $captured=@(Invoke-FlaimGh -GhArguments @('probe') -Token $writer -InputSecret $inputSecret 2>&1 6>&1)
    Assert-Cloud ($captured.Count -eq 0)
    Assert-Cloud ($writer.Length -gt 0 -and $inputSecret.Length -gt 0)
}
Test-Case 'CLI returns only explicitly requested successful output' {
    $captured=Invoke-FlaimGh -GhArguments @('read') -Token $writer -ReturnOutput
    Assert-Cloud ($captured -ceq 'ok')
}
Test-Case 'CLI rejects unsafe arguments before launching' {
    $rejected=$false
    try { Invoke-FlaimGh -GhArguments @('bad argument') -Token $writer } catch { $rejected=$_.Exception.Data['CloudKind'] -ceq 'InvalidCloudRequest' }
    Assert-Cloud $rejected
}
Test-Case 'Empty environment secrets are rejected before writing' {
    $rejected=$false
    try { Set-FlaimEnvironmentSecret -Name 'FLAIM_REFRESH_TOKEN' -Value $null -WriterToken $writer }
    catch { $rejected=$_.Exception.Data['CloudKind'] -ceq 'InvalidCredential' }
    Assert-Cloud $rejected
}

$script:events=[Collections.Generic.List[string]]::new()
$script:mode='ok'
$script:saves=0
function Set-FlaimEnvironmentSecret {
    param([string]$Name,[Security.SecureString]$Value,[Security.SecureString]$WriterToken)
    $script:saves++
    $script:events.Add('save'+$script:saves)
    if (($script:mode -eq 'preflight' -and $script:saves -eq 1) -or ($script:mode -eq 'persist' -and $script:saves -eq 2)) { Stop-FlaimCloudFailure 'GitHubCommandFailed' }
}
function Update-FlaimScheduledSession {
    param([object]$Session)
    $script:events.Add('refresh')
    if ($script:mode -eq 'refresh') { return [pscustomobject]@{Refreshed=$false} }
    $Session.AccessToken.Dispose()
    $Session.RefreshToken.Dispose()
    $Session.AccessToken=New-FlaimCloudSecret 'fake-new-access'
    $Session.RefreshToken=New-FlaimCloudSecret 'fake-new-refresh'
    return [pscustomobject]@{Refreshed=$true}
}
function Export-FlaimScheduledData {
    param([object]$Session,[string]$Destination)
    $script:events.Add('export')
    return [pscustomobject]@{Exported=($script:mode -ne 'export');PlayerCount=12}
}
function Publish-FlaimScheduledData {
    param([string]$Path,[Security.SecureString]$RepositoryToken)
    $script:events.Add('publish')
    if ($script:mode -eq 'publish') { Stop-FlaimCloudFailure 'GitHubCommandFailed' }
}
function Run-CloudCase {
    param([string]$Mode)
    $script:mode=$Mode; $script:saves=0; $script:events.Clear()
    return (Invoke-FlaimScheduledSync -RefreshToken $inputSecret -WriterToken $writer -RepositoryToken $repositoryToken -Root $scratch)
}
Test-Case 'Rotated state is saved before export and publish' {
    $result=Run-CloudCase 'ok'
    Assert-Cloud ($result.Synced -and $result.CredentialStateSaved)
    Assert-Cloud (($script:events -join ',') -ceq 'save1,refresh,save2,export,publish')
    Assert-Cloud ($inputSecret.Length -gt 0)
}
Test-Case 'Preflight failure does not consume refresh token' {
    $result=Run-CloudCase 'preflight'
    Assert-Cloud (-not $result.Synced -and -not $result.CredentialStateSaved)
    Assert-Cloud (($script:events -join ',') -ceq 'save1')
    Assert-Cloud ($result.NextAction -cne 'ReauthorizeAndConfigureAgain')
}
Test-Case 'Refresh failure never publishes data' {
    $result=Run-CloudCase 'refresh'
    Assert-Cloud (-not $result.Synced -and $result.NextAction -ceq 'ReauthorizeAndConfigureAgain')
    Assert-Cloud (($script:events -join ',') -ceq 'save1,refresh')
}
Test-Case 'Persistence failure stops all data operations' {
    $result=Run-CloudCase 'persist'
    Assert-Cloud ($result.ErrorType -ceq 'RefreshPersistenceFailed')
    Assert-Cloud (($script:events -join ',') -ceq 'save1,refresh,save2')
}
Test-Case 'Export failure retains newly saved cloud state' {
    $result=Run-CloudCase 'export'
    Assert-Cloud (-not $result.Synced -and $result.CredentialStateSaved)
    Assert-Cloud ($result.ErrorType -ceq 'DataExportFailed')
    Assert-Cloud (($script:events -join ',') -ceq 'save1,refresh,save2,export')
}
Test-Case 'Publish failure retains state and exposes no secrets' {
    $result=Run-CloudCase 'publish'
    Assert-Cloud (-not $result.Synced -and $result.CredentialStateSaved)
    $text=$result|Out-String
    Assert-Cloud (-not $text.Contains('fake-new-refresh') -and -not $text.Contains('fake-new-access'))
}
$writer.Dispose(); $inputSecret.Dispose(); $repositoryToken.Dispose()
Write-Output ('CloudTests Passed='+$script:passed+'; Failed='+$script:failed)
if ($script:failed) { exit 1 }
