#requires -Version 5.1
# All responses and credentials are synthetic; this file performs no network calls.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Flaim-Export-Dashboard.ps1') -FunctionsOnly
$script:passed=0;$script:failed=0
function Assert-League {param([bool]$Value) if (-not $Value) {throw 'AssertionFailed'}}
function Test-LeagueCase {param([string]$Name,[scriptblock]$Body) try {& $Body;$script:passed++;Write-Output ('PASS '+$Name)} catch {$script:failed++;Write-Output ('FAIL '+$Name);if($Name.StartsWith('Actual PowerShell league')) {Write-Output ('ContractStage='+$script:contractStage+'; ExceptionType='+$_.Exception.GetType().Name)}}}
$folder=Join-Path $env:TEMP ('FlaimLeague-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($folder)
$dashboard=Join-Path $folder 'dashboard.json';$league=Join-Path $folder 'league.json';$history=Join-Path $folder 'history.json'
$access=ConvertTo-SecureString 'synthetic-league-access' -AsPlainText -Force;$refresh=ConvertTo-SecureString 'synthetic-league-refresh' -AsPlainText -Force
$session=[pscustomobject]@{AccessToken=$access;RefreshToken=$refresh;ExpiresAtUtc=[DateTimeOffset]::UtcNow.AddHours(1)}
$script:requests=[Collections.Generic.List[object]]::new();$script:schemas=@()
foreach ($name in @('get_user_session','get_league_info','get_roster','get_matchups','get_transactions','get_standings','get_free_agents')) {
    $props=@{};foreach ($key in @('league_id','team_id','platform','sport','start_date','end_date')) {$props[$key]=@{type='string'}}
    foreach ($key in @('season_year','week','count')) {$props[$key]=@{type='integer'}}
    $script:schemas+=@{name=$name;inputSchema=@{type='object';properties=$props;required=@()}}
}
$script:mode='normal';$script:failRoster=$null;$script:wrongRoster=$null;$script:secretRoster=$null
$script:teamIds=@('42','7','301','444');$script:teamNames=@('RayBookDown','Alpha Team','Beta Team','Gamma Team')
function New-FlaimDataHttpClient {param([int]$Seconds) return [IO.MemoryStream]::new()}
function New-LeagueSide {
    param([string]$Id,[string]$Name,[string]$Value,[string]$Result)
    return @{teamId=$Id;teamKey=('478.l.actual-source.t.'+$Id);teamName=$Name;gamesRemaining=8;categoryScore=@{wins=1;losses=0;ties=0};categories=@(@{statId='12';name='Points';displayName='PTS';value=$Value;result=$Result;isDisplayOnly=$false},@{statId='display';name='Field Goals';displayName='FGM/A';value='12/24';result=$null;isDisplayOnly=$true})}
}
function Send-FlaimMcpRequest {
    param([object]$Context,[string]$Method,[Collections.IDictionary]$Params,[switch]$AllowBadRequest)
    $Context.LastHttpStatus=200
    if ($Method -ceq 'tools/list') {return @{result=@{tools=$script:schemas}}}
    if ($Method -cne 'tools/call') {throw 'UnexpectedSyntheticMethod'}
    $name=$Params['name'];$toolArguments=$Params['arguments'];$script:requests.Add([pscustomobject]@{Name=$name;Arguments=$toolArguments})
    if ($name -ceq 'get_user_session') {return @{result=@{structuredContent=@{success=$true;allLeagues=@(@{platform='yahoo';sport='basketball';leagueId='478.l.actual-source';teamId='42';leagueName='Funny League 2026-27';teamName='RayBookDown';seasonYear=2026})}}}}
    $data=@{}
    switch ($name) {
        'get_league_info' {
            $entries=@();for ($i=0;$i -lt 4;$i++) {$entries+=@{teamId=$script:teamIds[$i];teamKey=('478.l.actual-source.t.'+$script:teamIds[$i]);teamName=$script:teamNames[$i];ownerName='must-never-publish'}}
            if ($script:mode -ceq 'duplicateNames') {$entries[2]['teamName']='Alpha Team'}
            if ($script:mode -ceq 'duplicateIds') {$entries[2]['teamId']='7';$entries[2]['teamKey']='478.l.actual-source.t.7'}
            if ($script:mode -ceq 'missingId') {$entries[1].Remove('teamId')}
            if ($script:mode -ceq 'conflictingKey') {$entries[1]['teamKey']='478.l.actual-source.t.999'}
            if ($script:mode -ceq 'noCatalog') {$entries=$null}
            if ($script:mode -ceq 'tooMany') {$entries=@();for($i=0;$i -lt 33;$i++) {$entries+=@{teamId=[string]($i+1000);teamName=('Team '+$i)}}}
            if ($script:mode -ceq 'secretCatalog') {$entries[1]['teamName']='prefix-synthetic-league-refresh-suffix'}
            $data=@{name='Funny League 2026-27';numTeams=4;scoringType='head';scoringFormat='categories';currentWeek=4;startWeek=1;endWeek=21;maxWeeklyAdds=6;usesFaab=$true;rosterPositions=@();teams=$entries}
        }
        'get_roster' {
            $id=[string]$toolArguments['team_id'];if ($id -ceq $script:failRoster) {Stop-FlaimDataFailure 'RequestTimeout'}
            $index=[Array]::IndexOf($script:teamIds,$id);if ($index -lt 0) {throw 'UnexpectedTeamId'}
            $playerName='Player for '+$id;if ($id -ceq $script:secretRoster) {$playerName='prefix-synthetic-league-access-suffix'}
            $data=@{teamId=$id;teamKey=('478.l.actual-source.t.'+$id);teamName=$script:teamNames[$index];snapshot=@{type='current'};players=@(@{name=$playerName;team='CLE';selectedPosition='PG';eligiblePositions=@('PG','G');isUndroppable=($id -ceq '42');playerId='private-player-id';token='unselected-field'})}
            if ($id -ceq $script:wrongRoster) {$data['teamId']='999';$data['teamKey']='478.l.actual-source.t.999'}
            if ($script:mode -ceq 'nameOnlyRoster' -and $id -ceq '7') {$data.Remove('teamId');$data.Remove('teamKey')}
        }
        'get_matchups' {
            $week=4;if ($toolArguments.Contains('week')) {$week=[int]$toolArguments['week']}
            $a=New-LeagueSide '42' 'RayBookDown' '100' 'win';$b=New-LeagueSide '7' 'Alpha Team' '90' 'loss'
            $c=New-LeagueSide '301' 'Beta Team' '80' 'loss';$d=New-LeagueSide '444' 'Gamma Team' '110' 'win'
            $pairs=@(@{week=$week;home=$a;away=$b;status='in_progress'},@{week=$week;home=$d;away=$c;status='in_progress'})
            if ($script:mode -ceq 'duplicateMatchup') {$pairs+=@{week=$week;home=$a;away=$b;status='in_progress'}}
            if ($script:mode -ceq 'wrongWeek') {$pairs[1]['week']=99}
            $data=@{matchups=$pairs;matchupWeek=$week}
        }
        'get_transactions' {$data=@{transactions=@();limitations=@{omitted_unrecognized_rows=0}}}
        'get_standings' {
            $standings=@();for($i=0;$i -lt 4;$i++) {$standings+=@{teamId=$script:teamIds[$i];name=$script:teamNames[$i];faabBalance=($i*10);waiverPriority=($i+1)}}
            if ($script:mode -ceq 'missingStanding') {$standings=@($standings|Where-Object {$_.teamId -cne '301'})}
            $data=@{standings=$standings}
        }
        'get_free_agents' {$data=@{capabilities=@{rosteredRate=$true};freeAgents=@()}}
        default {throw 'UnexpectedSyntheticTool'}
    }
    return @{result=@{structuredContent=@{success=$true;data=$data}}}
}
function Invoke-LeagueTest {
    param([switch]$ReadHistory)
    $script:requests.Clear();$arguments=@{Session=$session;Destination=$dashboard;LeagueDestination=$league;Seconds=5}
    if ($ReadHistory) {$arguments['HistoryDestination']=$history}
    return Invoke-FlaimDashboardExport @arguments
}
try {
    Test-LeagueCase 'League export uses actual non-sequential IDs and reuses current league-wide reads' {
        $r=Invoke-LeagueTest;Assert-League ($r.Exported -and $r.LeagueExported)
        $script:last=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($script:last.Status -ceq 'ok' -and $script:last.Teams.Count -eq 4 -and $script:last.TeamCount -eq 4)
        $rosters=@($script:requests|Where-Object {$_.Name -ceq 'get_roster'})
        Assert-League (($rosters.Arguments.team_id -join ',') -ceq '42,7,301,444')
        foreach($request in @($script:requests|Where-Object {$_.Name -cne 'get_user_session'})) {Assert-League ($request.Arguments.league_id -ceq '478.l.actual-source')}
        foreach($name in @('get_league_info','get_matchups','get_standings')) {Assert-League (@($script:requests|Where-Object {$_.Name -ceq $name}).Count -eq 1)}
        Assert-League ($script:requests[1].Name -ceq 'get_league_info')
    }
    Test-LeagueCase 'Each team keeps its own roster matchup perspective and budget including real zero' {
        $a=$script:last.Teams[1];$b=$script:last.Teams[2]
        Assert-League ($a.Roster.Data.Players[0].Player -ceq 'Player for 7' -and $a.Matchup.Data.OwnScore.Wins -eq 1)
        Assert-League ($a.Matchup.Data.Categories[0].OwnValue -ceq '90' -and $a.Matchup.Data.Categories[0].OpponentValue -ceq '100' -and $a.Matchup.Data.Categories[0].Result -ceq 'loss')
        Assert-League ($b.Matchup.Data.Opponent -ceq 'Gamma Team' -and $b.Matchup.Data.Categories[0].OwnValue -ceq '80')
        Assert-League ($script:last.Teams[0].Budget.Data.FaabBalance -eq 0 -and $a.Budget.Data.FaabBalance -eq 10)
        Assert-League ($null -eq $a.Budget.Data.AddsUsedThisWeek -and $null -eq $a.Budget.Data.AddsRemainingThisWeek)
        Assert-League ($script:last.Teams[0].IsUserTeam -eq $true -and $a.IsUserTeam -eq $false)
    }
    Test-LeagueCase 'Reused matchup budget and own roster retain exact original section read times' {
        $d=Get-Content -Raw -LiteralPath $dashboard|ConvertFrom-Json
        foreach($team in $script:last.Teams) {Assert-League ($team.Matchup.RetrievedAtUtc -ceq $d.Sections.Matchup.RetrievedAtUtc -and $team.Budget.RetrievedAtUtc -ceq $d.Sections.Budget.RetrievedAtUtc -and $null -eq $team.Roster.SourceUpdatedAtUtc)}
        Assert-League ($script:last.Teams[0].Roster.RetrievedAtUtc -ceq $d.Sections.Roster.RetrievedAtUtc)
    }
    Test-LeagueCase 'Public selection keys are stable public-name hashes and private fields never appear' {
        $before=$script:last.Teams[1].SelectionKey;$r=Invoke-LeagueTest;$after=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $before -ceq $after.Teams[1].SelectionKey -and $before -cmatch '^team-[a-f0-9]{64}$')
        $raw=[IO.File]::ReadAllText($league);Assert-League ($raw -notmatch '478\.l\.actual-source|private-player-id|must-never-publish|"teamId"|"teamKey"|"token"|"ownerName"')
    }
    Test-LeagueCase 'Actual PowerShell league JSON passes the strict Node analysis contract without borrowing the user team budget' {
        $script:contractStage='LoadRuntime'
        $runtimeTokens=$null;$runtimeErrors=$null
        $runtimeAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Flaim-Scheduled-Sync.ps1'),[ref]$runtimeTokens,[ref]$runtimeErrors)
        Assert-League ($runtimeErrors.Count -eq 0)
        $definition=@($runtimeAst.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Invoke-FlaimPublicNode'})
        Assert-League ($definition.Count -eq 1)
        . ([scriptblock]::Create($definition[0].Extent.Text))
        $contractFolder=Join-Path $folder 'contract';[void][IO.Directory]::CreateDirectory($contractFolder)
        $contractDashboard=Join-Path $contractFolder 'dashboard.json'
        [IO.File]::Copy($dashboard,$contractDashboard,$true)
        [IO.File]::Copy($league,(Join-Path $contractFolder 'league-teams.json'),$true)
        $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $script:contractStage='RunNode'
        $captured=@(Invoke-FlaimPublicNode (Join-Path $root 'scripts\build-league-analysis.mjs') $contractDashboard 'LeagueContractFailed' *>&1)
        Assert-League ($captured.Count -eq 0)
        $script:contractStage='ReadOutput'
        $analysis=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText((Join-Path $contractFolder 'league-analysis.json')))
        $producer=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        $script:contractStage='TeamCount'
        Assert-League ($analysis.Teams.Count -eq 4 -and $analysis.TeamCount -eq 4 -and $analysis.ComparedTeamCount -eq 4)
        $script:contractStage='SelectedTeam'
        Assert-League ($analysis.Teams[1].SelectionKey -ceq $producer.Teams[1].SelectionKey -and $analysis.Teams[1].Team -ceq 'Alpha Team')
        $script:contractStage='Budget'
        Assert-League ($analysis.Teams[1].Budget.Data.FaabBalance -eq 10 -and $analysis.Teams[0].Budget.Data.FaabBalance -eq 0)
        $script:contractStage='Matchup'
        Assert-League ($analysis.Teams[1].Matchup.Data.Categories[0].OwnValue -ceq '90' -and $analysis.Teams[1].Matchup.RetrievedAtUtc -ceq $producer.Teams[1].Matchup.RetrievedAtUtc)
        $script:contractStage='Assessment'
        Assert-League ($analysis.Teams[2].Categories[0].Label -ceq 'PTS' -and $analysis.Teams[2].Categories[0].Assessment -ceq 'weakness')
    }
    Test-LeagueCase 'A failed roster is isolated and later actual team reads continue' {
        $script:failRoster='7';$r=Invoke-LeagueTest;$script:failRoster=$null;$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Status -ceq 'partial' -and $l.Teams[1].Roster.Status -ceq 'error' -and $l.Teams[1].Status -ceq 'partial' -and $l.Teams[3].Roster.Status -ceq 'ok')
        Assert-League ($null -eq $l.Teams[1].Roster.Data -and $null -eq $l.Teams[1].Roster.RetrievedAtUtc)
    }
    Test-LeagueCase 'Wrong or absent roster IDs never accept a matching name as identity' {
        $script:wrongRoster='7';$r=Invoke-LeagueTest;$script:wrongRoster=$null;$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Teams[1].Roster.ErrorType -ceq 'IdentityMismatch')
        $script:mode='nameOnlyRoster';$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Teams[1].Roster.Status -ceq 'error')
    }
    Test-LeagueCase 'Duplicate public names remain unavailable with unique keys and are not queried' {
        $script:mode='duplicateNames';$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Status -ceq 'partial' -and $l.Teams[1].Status -ceq 'unavailable' -and $l.Teams[2].Status -ceq 'unavailable')
        Assert-League ($l.Teams[1].SelectionKey -cne $l.Teams[2].SelectionKey -and @($script:requests|Where-Object {$_.Name -ceq 'get_roster'}).Count -eq 2)
    }
    Test-LeagueCase 'Duplicate missing or contradictory catalog identifiers do not trigger guessed roster requests' {
        foreach($mode in @('duplicateIds','missingId','conflictingKey')) {
            $script:mode=$mode;$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
            Assert-League ($r.Exported -and $l.Status -ceq 'partial' -and $l.Teams[1].Status -ceq 'unavailable')
            Assert-League (@($script:requests|Where-Object {$_.Name -ceq 'get_roster' -and $_.Arguments.team_id -ceq '7'}).Count -eq 0)
        }
    }
    Test-LeagueCase 'Wrong matchup week and duplicate pairs are unknown without relabelling or name guessing' {
        $script:mode='wrongWeek';$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Teams[2].Matchup.Status -ceq 'error' -and $l.Teams[0].Matchup.Status -ceq 'ok')
        $script:mode='duplicateMatchup';$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Teams[0].Matchup.Status -ceq 'error' -and $l.Teams[2].Matchup.Status -ceq 'ok')
    }
    Test-LeagueCase 'A missing standing leaves only that team budget unknown' {
        $script:mode='missingStanding';$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json
        Assert-League ($r.Exported -and $l.Teams[2].Budget.Status -ceq 'error' -and $null -eq $l.Teams[2].Budget.Data -and $l.Teams[1].Budget.Data.FaabBalance -eq 10)
    }
    Test-LeagueCase 'Missing or excessive team catalogs do not fan out or claim complete coverage' {
        foreach($mode in @('noCatalog','tooMany')) {$script:mode=$mode;$r=Invoke-LeagueTest;$script:mode='normal';$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json;Assert-League ($r.Exported -and $l.Status -ceq 'error' -and $l.Teams.Count -eq 0 -and @($script:requests|Where-Object {$_.Name -ceq 'get_roster'}).Count -eq 1)}
    }
    Test-LeagueCase 'History and all-team export share context without overwriting the current matchup read' {
        $r=Invoke-LeagueTest -ReadHistory;$l=Get-Content -Raw -LiteralPath $league|ConvertFrom-Json;$d=Get-Content -Raw -LiteralPath $dashboard|ConvertFrom-Json
        Assert-League ($r.Exported -and $r.HistoryExported -and $r.LeagueExported -and $l.Teams[1].Matchup.Data.Week -eq 4)
        Assert-League ($l.Teams[1].Matchup.RetrievedAtUtc -ceq $d.Sections.Matchup.RetrievedAtUtc)
        Assert-League (@($script:requests|Where-Object {$_.Name -ceq 'get_matchups'}).Count -eq 5)
    }
    Test-LeagueCase 'Credential-bearing new-team labels prevent every output from being replaced' {
        $beforeDashboard=[IO.File]::ReadAllText($dashboard);$beforeLeague=[IO.File]::ReadAllText($league)
        $script:secretRoster='7';$r=Invoke-LeagueTest;$script:secretRoster=$null
        Assert-League (-not $r.Exported -and $r.ErrorType -ceq 'CredentialDataDetected' -and [IO.File]::ReadAllText($dashboard) -ceq $beforeDashboard -and [IO.File]::ReadAllText($league) -ceq $beforeLeague)
        $script:mode='secretCatalog';$r=Invoke-LeagueTest;$script:mode='normal';Assert-League (-not $r.Exported -and $r.ErrorType -ceq 'CredentialDataDetected')
    }
    Test-LeagueCase 'League destination cannot alias dashboard or history and rejects before any read' {
        $script:requests.Clear();$r=Invoke-FlaimDashboardExport -Session $session -Destination $dashboard -LeagueDestination $dashboard -Seconds 5
        Assert-League (-not $r.Exported -and $r.ErrorType -ceq 'InvalidOutputPath' -and $script:requests.Count -eq 0)
        $r=Invoke-FlaimDashboardExport -Session $session -Destination $dashboard -LeagueDestination $history -HistoryDestination $history -Seconds 5
        Assert-League (-not $r.Exported -and $r.ErrorType -ceq 'InvalidOutputPath' -and $script:requests.Count -eq 0)
    }
} finally {
    $access.Dispose();$refresh.Dispose()
    $expected=[IO.Path]::GetFullPath($folder);$temp=[IO.Path]::GetFullPath($env:TEMP)
    if ($expected.StartsWith($temp+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {Remove-Item -LiteralPath $expected -Recurse -Force -ErrorAction SilentlyContinue}
}
Write-Output ('LeagueTests Passed='+$script:passed+'; Failed='+$script:failed)
if ($script:failed -gt 0) {exit 1}
