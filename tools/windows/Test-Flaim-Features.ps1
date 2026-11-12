#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1')
$parseTokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Flaim-Scheduled-Sync.ps1'),[ref]$parseTokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'SyncSyntaxFailed' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$script:passed = 0
$script:failed = 0
$script:calls = [Collections.Generic.List[object]]::new()
$script:fakeSha = 'a' * 40
$repositoryToken = New-FlaimCloudSecret 'synthetic-repository-credential'
$allowedPaths = @('data/dashboard.json','data/team.json','data/matchup-history.json','data/team-week-schedule.json','data/recommendations.json','data/recommendation-evidence.json','data/recommendation-history.json')
function Assert-Features { param([bool]$Value) if (-not $Value) { throw 'AssertionFailed' } }
function Test-Case {
    param([string]$Name,[scriptblock]$Body)
    $script:calls.Clear()
    $script:fakeSha = 'a' * 40
    try { & $Body; $script:passed++; Write-Output ('PASS '+$Name) }
    catch { $script:failed++; Write-Output ('FAIL '+$Name) }
}
function Invoke-FlaimGh {
    param([string[]]$GhArguments,[Security.SecureString]$Token,[switch]$ReturnOutput,[string]$InputText)
    Assert-Features ([object]::ReferenceEquals($Token,$repositoryToken))
    $script:calls.Add([pscustomobject]@{Arguments=$GhArguments;InputText=$InputText})
    if ($ReturnOutput) { return $script:fakeSha }
}
function Assert-Rejected {
    param([string]$Path,[byte[]]$Bytes,[string]$Kind='InvalidSnapshot')
    $rejected = $false
    try { Publish-FlaimPublicFile $Path $Bytes $repositoryToken }
    catch { $rejected = $_.Exception.Data['CloudKind'] -ceq $Kind }
    Assert-Features $rejected
    Assert-Features (@($script:calls | Where-Object { $_.Arguments -ccontains 'PUT' }).Count -eq 0)
}
$scratchParent = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.test-work'))
$scratch = [IO.Path]::GetFullPath((Join-Path $scratchParent ('features-'+[Guid]::NewGuid().ToString('N'))))
if (-not $scratch.StartsWith($scratchParent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'InvalidTestDirectory' }
try {
    Test-Case 'Only seven exact public paths are accepted and publisher stays silent' {
        foreach ($path in $allowedPaths) {
            $before = $script:calls.Count
            $output = @(Publish-FlaimPublicFile $path ([Text.Encoding]::UTF8.GetBytes('{"synthetic":true}')) $repositoryToken 2>&1 3>&1 4>&1 5>&1 6>&1)
            Assert-Features ($output.Count -eq 0 -and $script:calls.Count -eq $before+2)
            $read = $script:calls[$before]
            $write = $script:calls[$before+1]
            $endpoint = 'repos/iverson761011-web/raybookdown/contents/'+$path
            Assert-Features ($read.Arguments[1] -ceq $endpoint -and $write.Arguments[3] -ceq $endpoint)
            Assert-Features ($read.Arguments -ccontains 'Accept:application/vnd.github.object+json')
            Assert-Features (@($read.Arguments | Where-Object { $_ -match '\s' }).Count -eq 0)
            Assert-Features (($write.Arguments -join ',') -ceq ('api,--method,PUT,'+$endpoint+',--input,-'))
            $body = ConvertFrom-Json -InputObject $write.InputText
            Assert-Features ($body.branch -ceq 'main' -and $body.sha -ceq ('a'*40))
            Assert-Features ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($body.content)) -ceq '{"synthetic":true}')
            Assert-Features (-not $write.InputText.Contains('synthetic-repository-credential'))
        }
    }
    Test-Case 'Traversal alternate case private paths and backslashes reject before GitHub' {
        foreach ($path in @('data/../.github/workflows/daily-update.yml','data\recommendations.json','Data/recommendations.json','data/FLAIM_REFRESH_TOKEN','data/recommendations.json?x=1','data/not-public.json')) {
            Assert-Rejected $path ([byte[]]@(1))
        }
        Assert-Features ($script:calls.Count -eq 0)
    }
    Test-Case 'Every non-cache public feed accepts exactly one MiB' {
        $bytes = New-Object byte[] 1048576
        foreach ($path in @($allowedPaths | Where-Object { $_ -cne 'data/recommendation-history.json' })) {
            Publish-FlaimPublicFile $path $bytes $repositoryToken
            $body = ConvertFrom-Json -InputObject $script:calls[$script:calls.Count-1].InputText
            Assert-Features ([Convert]::FromBase64String($body.content).Length -eq 1048576)
        }
    }
    Test-Case 'Every non-cache public feed rejects larger than one MiB without a write' {
        $bytes = New-Object byte[] 1048577
        foreach ($path in @($allowedPaths | Where-Object { $_ -cne 'data/recommendation-history.json' })) {
            Assert-Rejected $path $bytes
        }
    }
    Test-Case 'Only the observed public game-history cache accepts eight MiB' {
        $bytes = New-Object byte[] 8388608
        Publish-FlaimPublicFile 'data/recommendation-history.json' $bytes $repositoryToken
        $body = ConvertFrom-Json -InputObject $script:calls[$script:calls.Count-1].InputText
        Assert-Features ([Convert]::FromBase64String($body.content).Length -eq 8388608)
    }
    Test-Case 'Game-history cache rejects even one byte above eight MiB' {
        Assert-Rejected 'data/recommendation-history.json' (New-Object byte[] 8388609)
    }
    Test-Case 'Invalid remote blob identity stops before publishing' {
        $script:fakeSha = 'invalid-blob-identity'
        Assert-Rejected 'data/recommendations.json' ([Text.Encoding]::UTF8.GetBytes('{}')) 'InvalidCloudResponse'
    }
    Test-Case 'Scheduled publication includes all feature feeds and preserves legacy roster' {
        $folder = Join-Path $scratch 'data'
        [void][IO.Directory]::CreateDirectory($folder)
        foreach ($name in @('matchup-history.json','team-week-schedule.json','recommendations.json','recommendation-evidence.json','recommendation-history.json')) {
            [IO.File]::WriteAllText((Join-Path $folder $name),'{}')
        }
        $dashboard = @{
            League='Funny League 2026-27'; Team='RayBookDown'; Platform='yahoo'; Season=2026
            Sections=@{
                Rules=@{Data=@{ScoringFormat='categories';ScoringType='head';TeamCount=14}}
                Roster=@{Status='ok';RetrievedAtUtc='2026-11-12T16:37:50Z';Data=@{Players=@(@{Player='Synthetic Player';Position='PG';Status=$null;EligiblePositions=@('PG')})}}
            }
        }
        $path = Join-Path $folder 'dashboard.json'
        [IO.File]::WriteAllText($path,(ConvertTo-Json -InputObject $dashboard -Depth 12))
        $output = @(Publish-FlaimScheduledData $path $repositoryToken 2>&1 3>&1 4>&1 5>&1 6>&1)
        Assert-Features ($output.Count -eq 0)
        $writes = @($script:calls | Where-Object { $_.Arguments -ccontains 'PUT' })
        Assert-Features ($writes.Count -eq 7)
        $paths = @($writes | ForEach-Object { $_.Arguments[3].Substring('repos/iverson761011-web/raybookdown/contents/'.Length) })
        foreach ($expected in $allowedPaths) { Assert-Features ($paths -ccontains $expected) }
        $legacyWrite = @($writes | Where-Object { $_.Arguments[3].EndsWith('/data/team.json') })[0]
        $legacyBody = ConvertFrom-Json -InputObject $legacyWrite.InputText
        $legacy = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($legacyBody.content)))
        Assert-Features ($legacy.SchemaVersion -eq 1 -and $legacy.PlayerCount -eq 1 -and $legacy.Players[0].Player -ceq 'Synthetic Player')
    }
}
finally {
    $repositoryToken.Dispose()
    $script:calls.Clear()
    if ([IO.Directory]::Exists($scratch)) {
        $resolvedScratch = [IO.Path]::GetFullPath($scratch)
        if (-not $resolvedScratch.StartsWith($scratchParent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'InvalidTestDirectory' }
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
}
Write-Output ('FeaturesTests Passed='+$script:passed+'; Failed='+$script:failed)
if ($script:failed) { exit 1 }
