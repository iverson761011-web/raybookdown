#requires -Version 5.1
# Synthetic transport only: no network or real credentials.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Flaim-Export-Dashboard.ps1') -FunctionsOnly
$script:passed=0;$script:failed=0
function Assert-FDDTest {param([bool]$Condition) if (-not $Condition) {throw 'AssertionFailed'}}
function Test-FDDCase {
    param([string]$Name,[scriptblock]$Body)
    try {& $Body;$script:passed++;Write-Output ('PASS '+$Name)}
    catch {$script:failed++;Write-Output ('FAIL '+$Name)}
}
$testFolder=Join-Path $env:TEMP ('FlaimDashboard-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testFolder)
$outputFile=Join-Path $testFolder 'dashboard.json'
$access=ConvertTo-SecureString 'synthetic-access-credential' -AsPlainText -Force
$refresh=ConvertTo-SecureString 'synthetic-refresh-credential' -AsPlainText -Force
$testSession=[pscustomobject]@{AccessToken=$access;RefreshToken=$refresh;ExpiresAtUtc=[DateTimeOffset]::UtcNow.AddHours(1)}
$script:requests=[Collections.Generic.List[object]]::new()
$script:failTool=$null;$script:wrongTeam=$false;$script:badRoster=$false;$script:secretName=$null;$script:missingValues=$false
$script:schemas=@()
foreach ($name in @('get_user_session','get_league_info','get_roster','get_matchups','get_transactions','get_standings','get_free_agents')) {
    $properties=@{}
    foreach ($key in @('league_id','team_id','platform','sport','start_date','end_date')) {$properties[$key]=@{type='string'}}
    foreach ($key in @('season_year','week','count')) {$properties[$key]=@{type='integer'}}
    $script:schemas+=@{name=$name;inputSchema=@{type='object';properties=$properties;required=@()}}
}
function New-FlaimDataHttpClient {param([int]$Seconds) return [IO.MemoryStream]::new()}
function Send-FlaimMcpRequest {
    param([object]$Context,[string]$Method,[Collections.IDictionary]$Params,[switch]$AllowBadRequest)
    $Context.LastHttpStatus=200
    if ($Method -ceq 'tools/list') {return @{result=@{tools=$script:schemas}}}
    if ($Method -cne 'tools/call') {throw 'UnexpectedSyntheticMethod'}
    $name=$Params['name'];$arguments=$Params['arguments'];$script:requests.Add([pscustomobject]@{Name=$name;Arguments=$arguments})
    if ($name -ceq $script:failTool) {Stop-FlaimDataFailure 'RequestTimeout'}
    if ($name -ceq 'get_user_session') {return @{result=@{structuredContent=@{success=$true;allLeagues=@(@{platform='yahoo';sport='basketball';leagueId='478.l.dynamic123';teamId='42';leagueName='Funny League 2026-27';teamName='RayBookDown';seasonYear=2026})}}}}
    $data=@{}
    switch ($name) {
        'get_league_info' {$data=@{name='Funny League 2026-27';numTeams=14;scoringType='head';scoringFormat='categories';currentWeek=4;maxWeeklyAdds=6;usesFaab=$true;waiverTime=1;rosterPositions=@(@{position='PG';count=1},@{position='IL';count=3});weeklyDeadline='intraday';tradeEndDate='2027-03-04'}}
        'get_roster' {
            $playerName='Synthetic Player';if ($null -ne $script:secretName) {$playerName=$script:secretName}
            $player=@{name=$playerName;selectedPosition='PG';eligiblePositions=@('PG','G','Util');team='CLE';playerKey='478.p.private';token='unselected-fixture-field'}
            if ($script:missingValues) {$player.Remove('eligiblePositions');$player.Remove('team')}
            $data=@{teamName='RayBookDown';snapshot=@{type='current'};players=@($player)}
            if ($script:wrongTeam) {$data['teamName']='Other Team'}
            if ($script:badRoster) {$data['players']='invalid'}
        }
        'get_matchups' {
            $matchHome=@{teamId='42';teamName='RayBookDown';categoryScore=@{wins=7;losses=6;ties=0};gamesRemaining=21;categories=@(@{statId='12';name='Points Scored';displayName='PTS';value='328';result='win';isDisplayOnly=$false},@{statId='ratio';name='Field Goals';displayName='FGM/A';value='122/251';result=$null;isDisplayOnly=$true})}
            $away=@{teamId='99';teamName='Synthetic Opponent';categoryScore=@{wins=6;losses=7;ties=0};gamesRemaining=20;categories=@(@{statId='12';name='Points Scored';displayName='PTS';value='293';result='loss';isDisplayOnly=$false},@{statId='ratio';name='Field Goals';displayName='FGM/A';value='97/216';result=$null;isDisplayOnly=$true})}
            if ($script:missingValues) {$matchHome['categories'][0]['value']=$null;$matchHome.Remove('categoryScore')}
            $data=@{matchups=@(@{week=4;status='in_progress';home=$matchHome;away=$away})}
        }
        'get_transactions' {$data=@{transactions=@(@{type='add';timestamp=1794297790000;players_added=@(@{name='Synthetic Addition';id='private-id'});players_dropped=@();faab_bid=$null});limitations=@{omitted_unrecognized_rows=5}}}
        'get_standings' {$data=@{standings=@(@{teamId='42';name='RayBookDown';faabBalance=0;waiverPriority=1})}}
        'get_free_agents' {
            $data=@{capabilities=@{rosteredRate=$true};freeAgents=@(@{name='Available Player';position='PF,C';team='DEN';acquisitionState='waivers';percentOwned=0;waiverDate='2026-11-13';playerId='secret-internal-id'})}
            if ($script:missingValues) {$data['capabilities']['rosteredRate']=$false;$data['freeAgents'][0]['acquisitionState']=$null}
        }
        default {throw 'UnexpectedSyntheticTool'}
    }
    return @{result=@{structuredContent=@{success=$true;data=$data}}}
}
function Invoke-FDDTestExport {
    $script:requests.Clear()
    return Invoke-FlaimDashboardExport -Session $testSession -Destination $outputFile -Seconds 5
}
Test-FDDCase 'Successful export reads every requested source with exact session identifiers' {
    $result=Invoke-FDDTestExport
    Assert-FDDTest ($result.Exported -and $result.SectionErrors -eq 0)
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($data.SchemaVersion -eq 2 -and $data.Sections.Roster.Data.PlayerCount -eq 1)
    $names=@($script:requests|ForEach-Object {$_.Name})
    Assert-FDDTest (($names -join ',') -ceq 'get_user_session,get_league_info,get_roster,get_matchups,get_transactions,get_standings,get_free_agents')
    foreach ($request in $script:requests) {
        if ($request.Name -ceq 'get_user_session') {continue}
        Assert-FDDTest ($request.Arguments['league_id'] -ceq '478.l.dynamic123')
        if (@('get_roster','get_transactions') -ccontains $request.Name) {Assert-FDDTest ($request.Arguments['team_id'] -ceq '42')}
    }
    Assert-FDDTest ($data.Sections.Schedule.Status -ceq 'unavailable')
}
Test-FDDCase 'Queries use explicit 30 UTC calendar days and current matchup week' {
    $tx=@($script:requests|Where-Object {$_.Name -ceq 'get_transactions'})[0]
    $match=@($script:requests|Where-Object {$_.Name -ceq 'get_matchups'})[0]
    Assert-FDDTest ($tx.Arguments['start_date'] -ceq [DateTime]::UtcNow.Date.AddDays(-29).ToString('yyyy-MM-dd'))
    Assert-FDDTest ($tx.Arguments['end_date'] -ceq [DateTime]::UtcNow.ToString('yyyy-MM-dd') -and $tx.Arguments['count'] -eq 100)
    Assert-FDDTest ($match.Arguments['week'] -eq 4)
}
Test-FDDCase 'Export never copies unknown payload keys or internal platform IDs' {
    $text=Get-Content -Raw -LiteralPath $outputFile
    Assert-FDDTest ($text -notmatch 'dynamic123|private-id|478\.p\.private|secret-internal-id|unselected-fixture-field|synthetic-access-credential|synthetic-refresh-credential')
    Assert-FDDTest ($text -notmatch '"(?:playerId|playerKey|teamId|teamKey|leagueId|token)"\s*:')
}
Test-FDDCase 'Zero balances and rates remain zero while unknown counters remain null' {
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($data.Sections.Budget.Data.FaabBalance -eq 0 -and $data.Sections.Market.Data.Players[0].PercentOwned -eq 0)
    Assert-FDDTest ($null -eq $data.Sections.Budget.Data.AddsRemainingThisWeek -and $null -eq $data.Sections.Transactions.Data.Rows[0].FaabBid)
    Assert-FDDTest ($data.Sections.Transactions.Data.CompletenessVerified -eq $false -and $data.Sections.Transactions.Data.UnrecognizedRows -eq 5)
}
Test-FDDCase 'Individual source failure is explicit and does not prevent later queries' {
    $script:failTool='get_matchups';$result=Invoke-FDDTestExport;$script:failTool=$null
    Assert-FDDTest ($result.Exported -and $result.SectionErrors -eq 1)
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($data.Sections.Matchup.Status -ceq 'error' -and $null -eq $data.Sections.Matchup.Data -and $null -eq $data.Sections.Matchup.RetrievedAtUtc)
    Assert-FDDTest ($data.Sections.Market.Status -ceq 'ok' -and $data.Sections.Matchup.ErrorType -ceq 'RequestTimeout')
}
Test-FDDCase 'Missing values remain unknown and never become scores or eligibility' {
    $script:missingValues=$true;$result=Invoke-FDDTestExport;$script:missingValues=$false
    Assert-FDDTest $result.Exported
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($null -eq $data.Sections.Roster.Data.Players[0].EligiblePositions -and $null -eq $data.Sections.Roster.Data.Players[0].TeamCode)
    Assert-FDDTest ($null -eq $data.Sections.Matchup.Data.OwnScore -and $null -eq $data.Sections.Matchup.Data.Categories[0].OwnValue)
    Assert-FDDTest ($null -eq $data.Sections.Market.Data.Players[0].PercentOwned -and $null -eq $data.Sections.Market.Data.Players[0].Availability)
}
Test-FDDCase 'Wrong roster team is withheld while unrelated sections still load' {
    $script:wrongTeam=$true;$result=Invoke-FDDTestExport;$script:wrongTeam=$false
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($result.Exported -and $data.Sections.Roster.Status -ceq 'error' -and $data.Sections.Roster.ErrorType -ceq 'IdentityMismatch')
    Assert-FDDTest ($data.Sections.Matchup.Status -ceq 'ok')
}
Test-FDDCase 'Malformed array is isolated rather than published' {
    $script:badRoster=$true;$result=Invoke-FDDTestExport;$script:badRoster=$false
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($result.Exported -and $data.Sections.Roster.Status -ceq 'error')
}
Test-FDDCase 'Script-like player labels are preserved strictly as inert JSON strings' {
    $script:secretName='<script>throw 1</script>';$result=Invoke-FDDTestExport;$script:secretName=$null
    $data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    Assert-FDDTest ($result.Exported -and $data.Sections.Roster.Data.Players[0].Player -ceq '<script>throw 1</script>')
}
Test-FDDCase 'A provider label containing a refresh credential never overwrites the last snapshot' {
    $before=[IO.File]::ReadAllText($outputFile)
    $script:secretName='prefix-synthetic-refresh-credential-suffix';$result=Invoke-FDDTestExport;$script:secretName=$null
    Assert-FDDTest (-not $result.Exported -and $result.ErrorType -ceq 'CredentialDataDetected')
    Assert-FDDTest ([IO.File]::ReadAllText($outputFile) -ceq $before)
}
Test-FDDCase 'Input credential checks occur before source text truncation' {
    $before=[IO.File]::ReadAllText($outputFile)
    $script:secretName=('x'*250)+'synthetic-access-credential';$result=Invoke-FDDTestExport;$script:secretName=$null
    Assert-FDDTest (-not $result.Exported -and $result.ErrorType -ceq 'CredentialDataDetected' -and [IO.File]::ReadAllText($outputFile) -ceq $before)
}
Test-FDDCase 'Every successful section has its own read time and unknown source update time' {
    $result=Invoke-FDDTestExport;$data=Get-Content -Raw -LiteralPath $outputFile|ConvertFrom-Json
    foreach ($name in @('Rules','Roster','Matchup','Transactions','Budget','Market')) {
        $section=$data.Sections.$name
        Assert-FDDTest ($section.Status -ceq 'ok' -and $section.RetrievedAtUtc -match '^\d{4}-' -and $null -eq $section.SourceUpdatedAtUtc)
    }
}
Test-FDDCase 'Actual PowerShell JSON satisfies the browser Node dashboard contract' {
    $repositoryRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $validatorPath=Join-Path $repositoryRoot 'scripts\check-dashboard.mjs'
    $nodeCommand=Get-Command node.exe -CommandType Application -ErrorAction Stop
    $process=$null;$outTask=$null;$errorTask=$null
    try {
        $start=[Diagnostics.ProcessStartInfo]::new()
        $start.FileName=$nodeCommand.Source
        $start.Arguments='"'+$validatorPath+'" "'+$outputFile+'"'
        $start.WorkingDirectory=$repositoryRoot
        $start.UseShellExecute=$false;$start.CreateNoWindow=$true
        $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
        $process=[Diagnostics.Process]::new();$process.StartInfo=$start
        [void]$process.Start()
        $outTask=$process.StandardOutput.ReadToEndAsync()
        $errorTask=$process.StandardError.ReadToEndAsync()
        $finished=$process.WaitForExit(30000)
        if (-not $finished) {try {$process.Kill()} catch {}}
        Assert-FDDTest $finished
        # Consume diagnostics without forwarding source data or child output.
        $null=$outTask.GetAwaiter().GetResult();$null=$errorTask.GetAwaiter().GetResult()
        Assert-FDDTest ($process.ExitCode -eq 0)
    }
    finally {if ($null -ne $process) {$process.Dispose()};$outTask=$null;$errorTask=$null}
}
# Import only the required declarations; never execute the scheduled entry point.
foreach ($sourceSpec in @(
    @{Path=(Join-Path $PSScriptRoot 'Flaim-GitHub-Common.ps1');Name='Stop-FlaimCloudFailure'},
    @{Path=(Join-Path $PSScriptRoot 'Flaim-Scheduled-Sync.ps1');Name='Invoke-FlaimPublicNode'}
)) {
    $sourceTokens=$null;$sourceErrors=$null
    $sourceAst=[Management.Automation.Language.Parser]::ParseFile($sourceSpec.Path,[ref]$sourceTokens,[ref]$sourceErrors)
    if ($sourceErrors.Count) {throw 'PublicNodeTestSyntaxFailed'}
    $definition=@($sourceAst.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $sourceSpec.Name})
    if ($definition.Count -ne 1) {throw 'PublicNodeTestDefinitionMissing'}
    . ([scriptblock]::Create($definition[0].Extent.Text))
}
$publicNodeFixture=Join-Path $testFolder 'public node fixture.mjs'
[IO.File]::WriteAllText($publicNodeFixture,@'
const forbidden=['FLAIM_REFRESH_TOKEN','FLAIM_SECRET_WRITER','GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS'];
if(forbidden.some(key=>process.env[key]))process.exit(77);
console.log('synthetic public-node stdout must remain private');
if(process.argv[2]==='malformed'){
  console.error('synthetic private diagnostic not JSON');
  process.exitCode=1;
}else{
  console.error(JSON.stringify({InvalidSections:['Rules','synthetic-private-marker','Market','GITHUB_TOKEN',123,{private:'synthetic'}],Detail:'synthetic private diagnostic'}));
  process.exitCode=process.argv[2]==='failure'?1:0;
}
'@,[Text.UTF8Encoding]::new($false))
$publicNodeEnvNames=@('FLAIM_REFRESH_TOKEN','FLAIM_SECRET_WRITER','GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS')
$publicNodePreviousEnv=@{}
try {
    foreach ($name in $publicNodeEnvNames) {
        $publicNodePreviousEnv[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
        [Environment]::SetEnvironmentVariable($name,'synthetic-public-node-env','Process')
    }
    Test-FDDCase 'Public Node success suppresses both diagnostics streams and strips credential environment' {
        $captured=@(Invoke-FlaimPublicNode -ScriptPath $publicNodeFixture -DataPath 'success' -FailureKind 'DashboardValidationFailed' *>&1)
        Assert-FDDTest ($captured.Count -eq 0)
        foreach ($name in $publicNodeEnvNames) {Assert-FDDTest ([Environment]::GetEnvironmentVariable($name,'Process') -ceq 'synthetic-public-node-env')}
    }
    Test-FDDCase 'Public Node failure preserves only the fixed kind and recognized section names' {
        $script:publicNodeCaught=$null
        $captured=@(& {
            try {Invoke-FlaimPublicNode -ScriptPath $publicNodeFixture -DataPath 'failure' -FailureKind 'DashboardValidationFailed'}
            catch {$script:publicNodeCaught=$_}
        } *>&1)
        Assert-FDDTest ($captured.Count -eq 0 -and $null -ne $script:publicNodeCaught)
        Assert-FDDTest ($script:publicNodeCaught.Exception.Data['CloudKind'] -ceq 'DashboardValidationFailed')
        Assert-FDDTest ($script:publicNodeCaught.Exception.Data['InvalidSections'] -ceq 'Rules,Market')
        Assert-FDDTest ($script:publicNodeCaught.Exception.Message -ceq 'Public data subprocess failed.')
        Assert-FDDTest (@($script:publicNodeCaught.Exception.Data.Keys).Count -eq 2)
        $script:publicNodeCaught=$null
    }
    Test-FDDCase 'Malformed public Node diagnostics never escape the fixed failure summary' {
        $script:publicNodeCaught=$null
        $captured=@(& {
            try {Invoke-FlaimPublicNode -ScriptPath $publicNodeFixture -DataPath 'malformed' -FailureKind 'DashboardValidationFailed'}
            catch {$script:publicNodeCaught=$_}
        } *>&1)
        Assert-FDDTest ($captured.Count -eq 0 -and $null -ne $script:publicNodeCaught)
        Assert-FDDTest ($script:publicNodeCaught.Exception.Data['CloudKind'] -ceq 'DashboardValidationFailed')
        Assert-FDDTest ($null -eq $script:publicNodeCaught.Exception.Data['InvalidSections'])
        Assert-FDDTest (@($script:publicNodeCaught.Exception.Data.Keys).Count -eq 1)
        $script:publicNodeCaught=$null
    }
}
finally {
    foreach ($name in $publicNodeEnvNames) {
        if ($publicNodePreviousEnv.ContainsKey($name)) {[Environment]::SetEnvironmentVariable($name,$publicNodePreviousEnv[$name],'Process')}
    }
    $publicNodePreviousEnv=$null;$script:publicNodeCaught=$null
}
$access.Dispose();$refresh.Dispose()
# Remove only individual test files and then the known empty test directory.
Get-ChildItem -LiteralPath $testFolder -File | ForEach-Object {[IO.File]::Delete($_.FullName)}
[IO.Directory]::Delete($testFolder)
Write-Output ('DashboardTests Passed='+$script:passed+'; Failed='+$script:failed)
if ($script:failed -gt 0) {exit 1}
