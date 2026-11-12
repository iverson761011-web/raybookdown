#requires -Version 5.1
# Synthetic transport only. No network or real credentials.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Flaim-Export-Dashboard.ps1') -FunctionsOnly
$script:passed=0;$script:failed=0
function Assert-HistoryTest {param([bool]$Value) if (-not $Value) {throw 'AssertionFailed'}}
function Test-HistoryCase {
    param([string]$Name,[scriptblock]$Body)
    try {& $Body;$script:passed++;Write-Output ('PASS '+$Name)}
    catch {$script:failed++;Write-Output ('FAIL '+$Name)}
}
$testFolder=Join-Path $env:TEMP ('FlaimHistory-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testFolder)
$dashboardFile=Join-Path $testFolder 'dashboard.json';$historyFile=Join-Path $testFolder 'history.json'
$access=ConvertTo-SecureString 'synthetic-history-access' -AsPlainText -Force
$refresh=ConvertTo-SecureString 'synthetic-history-refresh' -AsPlainText -Force
$session=[pscustomobject]@{AccessToken=$access;RefreshToken=$refresh;ExpiresAtUtc=[DateTimeOffset]::UtcNow.AddHours(1)}
$script:requests=[Collections.Generic.List[object]]::new();$script:schemas=@()
foreach ($name in @('get_user_session','get_league_info','get_roster','get_matchups','get_transactions','get_standings','get_free_agents')) {
    $properties=@{};foreach ($key in @('league_id','team_id','platform','sport','start_date','end_date')) {$properties[$key]=@{type='string'}}
    foreach ($key in @('season_year','week','count')) {$properties[$key]=@{type='integer'}}
    $script:schemas+=@{name=$name;inputSchema=@{type='object';properties=$properties;required=@()}}
}
$script:failWeek=0;$script:wrongWeek=0;$script:noIdsWeek=0;$script:duplicateWeek=0;$script:secretWeek=0
$script:currentWeek=4;$script:startWeek=1;$script:endWeek=21;$script:omitBounds=$false;$script:omitWinner=$false
function New-FlaimDataHttpClient {param([int]$Seconds) return [IO.MemoryStream]::new()}
function Send-FlaimMcpRequest {
    param([object]$Context,[string]$Method,[Collections.IDictionary]$Params,[switch]$AllowBadRequest)
    $Context.LastHttpStatus=200
    if ($Method -ceq 'tools/list') {return @{result=@{tools=$script:schemas}}}
    if ($Method -cne 'tools/call') {throw 'UnexpectedSyntheticMethod'}
    $name=$Params['name'];$a=$Params['arguments'];$script:requests.Add([pscustomobject]@{Name=$name;Arguments=$a})
    if ($name -ceq 'get_user_session') {return @{result=@{structuredContent=@{success=$true;allLeagues=@(@{platform='yahoo';sport='basketball';leagueId='478.l.dynamic-history';teamId='42';leagueName='Funny League 2026-27';teamName='RayBookDown';seasonYear=2026})}}}}
    $data=@{}
    switch ($name) {
        'get_league_info' {
            $data=@{name='Funny League 2026-27';numTeams=14;scoringType='head';scoringFormat='categories';currentWeek=$script:currentWeek;startWeek=$script:startWeek;endWeek=$script:endWeek;rosterPositions=@();usesFaab=$true;maxWeeklyAdds=6}
            if ($script:omitBounds) {$data.Remove('startWeek')}
        }
        'get_roster' {$data=@{teamName='RayBookDown';snapshot=@{type='current'};players=@()}}
        'get_matchups' {
            $week=[int]$a['week'];if ($week -eq $script:failWeek) {Stop-FlaimDataFailure 'RequestTimeout'}
            $own=@{teamId='42';teamName='RayBookDown';categoryScore=@{wins=7;losses=6;ties=0};categories=@(@{statId='12';name='Points';displayName='PTS';value='328';result='win';isDisplayOnly=$false},@{statId='ratio';name='Field Goals';displayName='FGM/A';value='122/251';result=$null;isDisplayOnly=$true})}
            $opp=@{teamId='99';teamName=('Opponent '+$week);categoryScore=@{wins=6;losses=7;ties=0};categories=@(@{statId='12';name='Points';displayName='PTS';value='293';result='loss';isDisplayOnly=$false},@{statId='ratio';name='Field Goals';displayName='FGM/A';value='97/216';result=$null;isDisplayOnly=$true})}
            if ($week -eq $script:secretWeek) {$opp['teamName']='prefix-synthetic-history-refresh-suffix'}
            if ($week -eq $script:noIdsWeek) {$own.Remove('teamId')}
            $status='final';if ($week -eq $script:currentWeek) {$status='in_progress'}
            $pair=@{week=$week;status=$status;home=$own;away=$opp;winner='home'}
            if ($script:omitWinner) {$pair.Remove('winner')}
            if ($week -eq 2) {$pair['winner']='tie';$own['categoryScore']=@{wins=6;losses=6;ties=1};$opp['categoryScore']=@{wins=6;losses=6;ties=1}}
            if ($week -eq 3) {$pair['home']=$opp;$pair['away']=$own;$pair['winner']='away'}
            if ($week -eq $script:wrongWeek) {$pair['week']=99}
            $pairs=@($pair);if ($week -eq $script:duplicateWeek) {$pairs=@($pair,$pair)}
            $data=@{matchups=$pairs;matchupWeek=$week;currentWeek=$script:currentWeek}
        }
        'get_transactions' {$data=@{transactions=@();limitations=@{omitted_unrecognized_rows=0}}}
        'get_standings' {$data=@{standings=@(@{teamId='42';faabBalance=0;waiverPriority=1})}}
        'get_free_agents' {$data=@{capabilities=@{rosteredRate=$true};freeAgents=@()}}
        default {throw 'UnexpectedSyntheticTool'}
    }
    return @{result=@{structuredContent=@{success=$true;data=$data}}}
}
function Invoke-HistoryTestExport {
    $script:requests.Clear()
    return Invoke-FlaimDashboardExport -Session $session -Destination $dashboardFile -HistoryDestination $historyFile -Seconds 5
}
Test-HistoryCase 'History uses session identifiers and only provider start through current week' {
    $r=Invoke-HistoryTestExport;Assert-HistoryTest ($r.Exported -and $r.HistoryExported)
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($h.Status -ceq 'ok' -and $h.CurrentWeek -eq 4 -and $h.Weeks.Count -eq 4)
    $historyQueries=@($script:requests|Where-Object {$_.Name -ceq 'get_matchups'})
    Assert-HistoryTest (($historyQueries.Arguments.week -join ',') -ceq '4,1,2,3,4')
    foreach ($q in $historyQueries) {Assert-HistoryTest ($q.Arguments.league_id -ceq '478.l.dynamic-history' -and $q.Arguments.season_year -eq 2026)}
    Assert-HistoryTest ($script:requests[1].Name -ceq 'get_league_info')
}
Test-HistoryCase 'Final provider winners map from either side and ties while current lead has no winner' {
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($h.Weeks[0].Winner -ceq 'own' -and $h.Weeks[1].Winner -ceq 'tie' -and $h.Weeks[2].Winner -ceq 'own')
    Assert-HistoryTest ($h.Weeks[3].Status -ceq 'in_progress' -and $null -eq $h.Weeks[3].Winner)
}
Test-HistoryCase 'Unreported final winner remains unknown despite a category lead' {
    $script:omitWinner=$true;$r=Invoke-HistoryTestExport;$script:omitWinner=$false
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $null -eq $h.Weeks[0].Winner -and $h.Weeks[0].OwnScore.Wins -eq 7)
}
Test-HistoryCase 'A failed historical week leaves other weeks intact and is explicitly unavailable' {
    $script:failWeek=2;$r=Invoke-HistoryTestExport;$script:failWeek=0
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $h.Status -ceq 'partial' -and $h.Weeks.Count -eq 3 -and $h.UnavailableWeeks.Count -eq 1 -and $h.UnavailableWeeks[0] -eq 2)
}
Test-HistoryCase 'A wrong response week is rejected rather than relabelled' {
    $script:wrongWeek=1;$r=Invoke-HistoryTestExport;$script:wrongWeek=0
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $h.Status -ceq 'partial' -and $h.UnavailableWeeks[0] -eq 1)
}
Test-HistoryCase 'A matching name without provider identifiers is not accepted as this team' {
    $script:noIdsWeek=1;$r=Invoke-HistoryTestExport;$script:noIdsWeek=0
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $h.UnavailableWeeks[0] -eq 1)
}
Test-HistoryCase 'Ambiguous matching pairs do not become a guessed historical result' {
    $script:duplicateWeek=3;$r=Invoke-HistoryTestExport;$script:duplicateWeek=0
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $h.UnavailableWeeks[0] -eq 3)
}
Test-HistoryCase 'Missing provider week boundaries do not trigger guessed week numbers' {
    $script:omitBounds=$true;$r=Invoke-HistoryTestExport;$script:omitBounds=$false
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    $queries=@($script:requests|Where-Object {$_.Name -ceq 'get_matchups'})
    Assert-HistoryTest ($r.Exported -and $h.Status -ceq 'unavailable' -and $h.ErrorType -ceq 'HistoryWeekRangeUnknown' -and $h.Weeks.Count -eq 0 -and $queries.Count -eq 1)
}
Test-HistoryCase 'Season end bounds requests even when provider current week is later' {
    $script:endWeek=2;$r=Invoke-HistoryTestExport;$script:endWeek=21
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    Assert-HistoryTest ($r.Exported -and $h.Weeks.Count -eq 2 -and $h.Weeks[-1].Week -eq 2)
}
Test-HistoryCase 'An excessive provider range is bounded and the skipped weeks remain unknown' {
    $script:currentWeek=60;$script:endWeek=100;$r=Invoke-HistoryTestExport;$script:currentWeek=4;$script:endWeek=21
    $h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    $queries=@($script:requests|Where-Object {$_.Name -ceq 'get_matchups'})
    Assert-HistoryTest ($r.Exported -and $h.Status -ceq 'partial' -and $h.Weeks.Count -eq 53 -and $h.UnavailableWeeks.Count -eq 7 -and $h.UnavailableWeeks[0] -eq 54 -and $queries.Count -eq 54)
}
Test-HistoryCase 'History keeps unknown source update dates and display-only category results' {
    $r=Invoke-HistoryTestExport;$h=Get-Content -Raw -LiteralPath $historyFile|ConvertFrom-Json
    foreach ($w in $h.Weeks) {Assert-HistoryTest ($null -eq $w.SourceUpdatedAtUtc -and $null -eq $w.WeekStartDate -and $null -eq $w.Categories[1].Result -and $w.Categories[1].DisplayOnly -eq $true)}
    $raw=[IO.File]::ReadAllText($historyFile)
    Assert-HistoryTest ($raw -notmatch 'dynamic-history|"(?:leagueId|teamId|teamKey|statId|token)"\s*:')
}
Test-HistoryCase 'A credential in a historical label prevents either output from being replaced' {
    $beforeDashboard=[IO.File]::ReadAllText($dashboardFile);$beforeHistory=[IO.File]::ReadAllText($historyFile)
    $script:secretWeek=3;$r=Invoke-HistoryTestExport;$script:secretWeek=0
    Assert-HistoryTest (-not $r.Exported -and -not $r.HistoryExported -and $r.ErrorType -ceq 'CredentialDataDetected')
    Assert-HistoryTest ([IO.File]::ReadAllText($dashboardFile) -ceq $beforeDashboard -and [IO.File]::ReadAllText($historyFile) -ceq $beforeHistory)
}
Test-HistoryCase 'History output cannot overwrite the dashboard path' {
    $r=Invoke-FlaimDashboardExport -Session $session -Destination $dashboardFile -HistoryDestination $dashboardFile -Seconds 5
    Assert-HistoryTest (-not $r.Exported -and $r.ErrorType -ceq 'InvalidOutputPath')
}
$access.Dispose();$refresh.Dispose()
Get-ChildItem -LiteralPath $testFolder -File | ForEach-Object {[IO.File]::Delete($_.FullName)}
[IO.Directory]::Delete($testFolder)
Write-Output ('HistoryTests Passed='+$script:passed+'; Failed='+$script:failed)
if ($script:failed) {exit 1}
