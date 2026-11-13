#requires -Version 5.1
<# Exports only public dashboard fields. Never refreshes or persists credentials. #>
[CmdletBinding()]
param(
    [object]$Session,
    [string]$OutputPath = (Join-Path $PSScriptRoot 'dashboard.json'),
    [string]$HistoryOutputPath,
    [string]$LeagueOutputPath,
    [ValidateRange(5,120)][int]$RequestTimeoutSeconds = 30,
    [switch]$FunctionsOnly
)

# Import declarations only: the existing script's final invocation is never run.
$transportPath = Join-Path $PSScriptRoot 'Flaim-Team-Test.ps1'
$transportTokens = $null; $transportErrors = $null
$transportAst = [Management.Automation.Language.Parser]::ParseFile($transportPath,[ref]$transportTokens,[ref]$transportErrors)
if ($transportErrors.Count -gt 0) { throw 'DashboardTransportSyntaxFailed' }
foreach ($statement in $transportAst.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}

function Get-FDDField {
    param([object]$Map,[string]$Key)
    if ($Map -is [Collections.IDictionary] -and @($Map.Keys) -ccontains $Key) { return ,$Map[$Key] }
    return $null
}
function ConvertTo-FDDText {
    param([object]$Value,[int]$Limit=200)
    if ($null -eq $Value) { return $null }
    if ($Value -isnot [string]) { return $null }
    # Keep the original for credential comparison before any normalization/truncation.
    $script:FDDLabels.Add($Value)
    $clean = [Text.RegularExpressions.Regex]::Replace($Value,'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]',' ')
    if ([string]::IsNullOrWhiteSpace($clean)) { return $null }
    if ($clean.Length -gt $Limit) { $clean=$clean.Substring(0,$Limit) }
    return $clean
}
function ConvertTo-FDDNumber {
    param([object]$Value,[double]$Minimum=0,[double]$Maximum=1000000000,[switch]$Integer)
    if ($null -eq $Value -or $Value -is [bool]) { return $null }
    $number=0.0
    if ($Value -is [string]) {
        if ($Value -cnotmatch '^[0-9]{1,10}(?:\.[0-9]{1,8})?$') { return $null }
        if (-not [double]::TryParse($Value,[Globalization.NumberStyles]::AllowDecimalPoint,[Globalization.CultureInfo]::InvariantCulture,[ref]$number)) { return $null }
    }
    elseif ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { $number=[double]$Value }
    else { return $null }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -gt $Maximum) { return $null }
    if ($Integer) { if ($number -ne [Math]::Floor($number)) { return $null }; return [int]$number }
    return $number
}
function ConvertTo-FDDDate {
    param([object]$Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}$') { return $null }
    $parsed=[DateTime]::MinValue
    if ([DateTime]::TryParseExact($Value,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { return $Value }
    return $null
}
function Get-FDDArray {
    param([object]$Value,[int]$Maximum=100)
    if ($Value -isnot [Array] -or $Value.Count -gt $Maximum) { Stop-FlaimDataFailure 'InvalidDashboardData' }
    return ,$Value
}
function Get-FDDNameList {
    param([object]$Value)
    $items=Get-FDDArray $Value
    $names=[Collections.Generic.List[object]]::new()
    foreach ($item in $items) { $names.Add((ConvertTo-FDDText (Get-FDDField $item 'name'))) }
    return ,$names.ToArray()
}
function ConvertTo-FDDScore {
    param([object]$Value)
    if ($Value -isnot [Collections.IDictionary]) { return $null }
    $wins=ConvertTo-FDDNumber (Get-FDDField $Value 'wins') -Maximum 100 -Integer
    $losses=ConvertTo-FDDNumber (Get-FDDField $Value 'losses') -Maximum 100 -Integer
    $ties=ConvertTo-FDDNumber (Get-FDDField $Value 'ties') -Maximum 100 -Integer
    if ($null -eq $wins -or $null -eq $losses -or $null -eq $ties) { return $null }
    return [ordered]@{ Wins=$wins; Losses=$losses; Ties=$ties }
}
function ConvertTo-FDDStatValue {
    param([object]$Value)
    if ($Value -is [string]) {return ConvertTo-FDDText $Value 100}
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [decimal]) {return ConvertTo-FDDText ($Value.ToString([Globalization.CultureInfo]::InvariantCulture)) 100}
    if ($Value -is [double] -and -not [double]::IsNaN($Value) -and -not [double]::IsInfinity($Value)) {return ConvertTo-FDDText ($Value.ToString([Globalization.CultureInfo]::InvariantCulture)) 100}
    return $null
}
function Test-FDDTeam {
    param([object]$Entry,[object]$Selected)
    if ($Entry -isnot [Collections.IDictionary]) { return $false }
    $id=Get-FDDField $Entry 'teamId'; $key=Get-FDDField $Entry 'teamKey'
    $selectedId=[string]$Selected['teamId'];$selectedKey=$Selected['leagueId']+'.t.'+$selectedId
    if ($selectedId.Contains('.t.')) {$selectedKey=$selectedId;$selectedId=($selectedId -split '\.t\.')[-1]}
    if ($null -ne $id) { return [string]$id -ceq $selectedId -or [string]$id -ceq $selectedKey }
    if ($null -ne $key) { return [string]$key -ceq $selectedKey }
    $name=Get-FDDField $Entry 'teamName'; if ($null -eq $name) { $name=Get-FDDField $Entry 'name' }
    return $name -ceq $Selected['teamName']
}
function New-FDDSection {
    param([string]$Status,[object]$Data,[string]$ErrorType,[string]$Source='Flaim Fantasy / Yahoo')
    $now=[DateTimeOffset]::UtcNow.ToString('o')
    return [ordered]@{ Status=$Status; Source=$Source; CheckedAtUtc=$now; RetrievedAtUtc=$(if ($Status -eq 'ok') { $now } else { $null }); SourceUpdatedAtUtc=$null; ErrorType=$(if ([string]::IsNullOrEmpty($ErrorType)) {$null} else {$ErrorType}); Data=$Data }
}
function Read-FDDSection {
    param([object]$Context,[Collections.IDictionary]$Tools,[string]$Tool,[Collections.IDictionary]$Arguments,[scriptblock]$Convert)
    try {
        Assert-FlaimTeamArguments $Tools $Tool $Arguments
        $data=Read-FlaimTeamToolData $Context $Tool $Arguments
        $safe=& $Convert $data
        if ($safe -isnot [Collections.IDictionary]) { Stop-FlaimDataFailure 'InvalidDashboardData' }
        return New-FDDSection 'ok' $safe $null
    }
    catch {
        $kind='DashboardDataReadFailed'
        $allowed=@('TeamToolUnavailable','UnsupportedToolSchema','TeamDataReadError','RequestTimeout','AccessDenied','AccessTokenRejected','DataHttpError','DataRedirectRejected','InvalidDataResponse','InvalidRpcResponse','RpcError','ResponseTooLarge','IdentityMismatch','InvalidDashboardData')
        if ($allowed -ccontains $_.Exception.Data['FlaimKind']) { $kind=[string]$_.Exception.Data['FlaimKind'] }
        return New-FDDSection 'error' $null $kind
    }
}

function Test-FDDHistoryTeam {
    param([object]$Entry,[object]$Selected)
    if ($Entry -isnot [Collections.IDictionary]) {return $false}
    # History must be tied to the session identifier, not a similar team name.
    if ($null -eq (Get-FDDField $Entry 'teamId') -and $null -eq (Get-FDDField $Entry 'teamKey')) {return $false}
    return Test-FDDTeam $Entry $Selected
}
function ConvertFrom-FDDHistoryMatchup {
    param([object]$Data,[object]$Selected,[int]$RequestedWeek)
    $allPairs=Get-FDDArray (Get-FDDField $Data 'matchups')
    $pairs=@($allPairs | Where-Object {
        (Test-FDDHistoryTeam (Get-FDDField $_ 'home') $Selected) -or (Test-FDDHistoryTeam (Get-FDDField $_ 'away') $Selected)
    })
    if ($pairs.Count -ne 1) {Stop-FlaimDataFailure 'IdentityMismatch'}
    $pair=$pairs[0];$homeEntry=Get-FDDField $pair 'home';$awayEntry=Get-FDDField $pair 'away'
    $homeIsOwn=Test-FDDHistoryTeam $homeEntry $Selected;$awayIsOwn=Test-FDDHistoryTeam $awayEntry $Selected
    if ($homeIsOwn -eq $awayIsOwn) {Stop-FlaimDataFailure 'IdentityMismatch'}
    $week=ConvertTo-FDDNumber (Get-FDDField $pair 'week') -Minimum 1 -Maximum 100 -Integer
    if ($null -eq $week) {$week=ConvertTo-FDDNumber (Get-FDDField $Data 'matchupWeek') -Minimum 1 -Maximum 100 -Integer}
    if ($week -ne $RequestedWeek) {Stop-FlaimDataFailure 'InvalidDashboardData'}
    $own=$homeEntry;$opp=$awayEntry;$ownSide='home'
    if (-not $homeIsOwn) {$own=$awayEntry;$opp=$homeEntry;$ownSide='away'}
    if ($opp -isnot [Collections.IDictionary]) {Stop-FlaimDataFailure 'InvalidDashboardData'}
    $rows=[Collections.Generic.List[object]]::new()
    $ownCategories=Get-FDDField $own 'categories';$oppCategories=Get-FDDField $opp 'categories'
    if ($ownCategories -is [Array]) {
        foreach ($category in (Get-FDDArray $ownCategories 200)) {
            $other=$null
            foreach ($candidate in (Get-FDDArray $oppCategories 200)) {
                if ((Get-FDDField $candidate 'statId') -ceq (Get-FDDField $category 'statId')) {$other=$candidate;break}
            }
            $result=Get-FDDField $category 'result';if (@('win','loss','tie') -cnotcontains $result) {$result=$null}
            $display=Get-FDDField $category 'isDisplayOnly';if ($display -isnot [bool]) {$display=$null}
            $rows.Add([ordered]@{
                Name=(ConvertTo-FDDText (Get-FDDField $category 'name'));Label=(ConvertTo-FDDText (Get-FDDField $category 'displayName') 40)
                OwnValue=(ConvertTo-FDDStatValue (Get-FDDField $category 'value'));OpponentValue=(ConvertTo-FDDStatValue (Get-FDDField $other 'value'))
                Result=$result;DisplayOnly=$display
            })
        }
    }
    $status=Get-FDDField $pair 'status';if (@('upcoming','in_progress','final') -cnotcontains $status) {$status=$null}
    $winner=$null;$providerWinner=Get-FDDField $pair 'winner'
    if ($status -ceq 'final') {
        if ($providerWinner -ceq 'tie') {$winner='tie'}
        elseif (@('home','away') -ccontains $providerWinner) {$winner=$(if ($providerWinner -ceq $ownSide) {'own'} else {'opponent'})}
    }
    return [ordered]@{
        Week=$RequestedWeek;Status=$status;Opponent=(ConvertTo-FDDText (Get-FDDField $opp 'teamName'))
        OwnScore=(ConvertTo-FDDScore (Get-FDDField $own 'categoryScore'));OpponentScore=(ConvertTo-FDDScore (Get-FDDField $opp 'categoryScore'))
        Winner=$winner;WeekStartDate=$null;WeekEndDate=$null;Categories=$rows.ToArray()
        RetrievedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');SourceUpdatedAtUtc=$null
    }
}
function Read-FDDHistory {
    param([object]$Context,[Collections.IDictionary]$Tools,[Collections.IDictionary]$Base,[object]$Selected,[object]$Bounds,[string]$LeagueName,[string]$TeamName,[int]$SeasonYear)
    $checked=[DateTimeOffset]::UtcNow.ToString('o');$weeks=[Collections.Generic.List[object]]::new();$unavailable=[Collections.Generic.List[int]]::new()
    $start=Get-FDDField $Bounds 'Start';$end=Get-FDDField $Bounds 'End';$current=Get-FDDField $Bounds 'Current'
    $valid=$null -ne $start -and $null -ne $end -and $null -ne $current -and $start -le $end -and $current -ge $start
    if ($valid) {
        $last=[Math]::Min($current,$end)
        for ($week=[int]$start;$week -le $last;$week++) {
            # A provider-supplied range is bounded; never query a future week.
            if ($week-$start -ge 53) {$unavailable.Add($week);continue}
            $arguments=[ordered]@{};foreach ($key in $Base.Keys) {$arguments[$key]=$Base[$key]};$arguments['week']=$week
            try {
                Assert-FlaimTeamArguments $Tools 'get_matchups' $arguments
                $data=Read-FlaimTeamToolData $Context 'get_matchups' $arguments
                $weeks.Add((ConvertFrom-FDDHistoryMatchup $data $Selected $week))
            }
            catch {$unavailable.Add($week)}
        }
    }
    $status='unavailable';$historyError='HistoryWeekRangeUnknown';$readAt=$null
    if ($valid) {
        if ($unavailable.Count -eq 0) {$status='ok';$historyError=$null}
        elseif ($weeks.Count -gt 0) {$status='partial';$historyError='HistoryPartial'}
        else {$status='error';$historyError='HistoryUnavailable'}
        if ($weeks.Count -gt 0) {$readAt=[DateTimeOffset]::UtcNow.ToString('o')}
    }
    return [ordered]@{
        SchemaVersion=1;League=$LeagueName;Team=$TeamName;Platform='yahoo';Season=$SeasonYear
        CheckedAtUtc=$checked;RetrievedAtUtc=$readAt;SourceUpdatedAtUtc=$null;Status=$status;ErrorType=$historyError;CurrentWeek=$current
        Weeks=$weeks.ToArray();UnavailableWeeks=$unavailable.ToArray()
    }
}

function Test-FDDLeagueIdentity {
    param([object]$Entry,[object]$Selected)
    if ($Entry -isnot [Collections.IDictionary]) {return $false}
    $id=Get-FDDField $Entry 'teamId';$key=Get-FDDField $Entry 'teamKey'
    if ($null -eq $id -and $null -eq $key) {return $false}
    if ($null -ne $id -and -not (Test-FDDTeam @{teamId=$id} $Selected)) {return $false}
    if ($null -ne $key -and -not (Test-FDDTeam @{teamKey=$key} $Selected)) {return $false}
    $name=Get-FDDField $Entry 'teamName';if ($null -eq $name) {$name=Get-FDDField $Entry 'name'}
    if ($null -ne $name -and $name -cne $Selected['teamName']) {return $false}
    return $true
}
function ConvertFrom-FDDLeagueRoster {
    param([object]$Data,[object]$Selected)
    if (-not (Test-FDDLeagueIdentity $Data $Selected)) {Stop-FlaimDataFailure 'IdentityMismatch'}
    $snapshot=Get-FDDField $Data 'snapshot'
    if ($null -ne $snapshot -and (Get-FDDField $snapshot 'type') -cne 'current') {Stop-FlaimDataFailure 'InvalidDashboardData'}
    $players=[Collections.Generic.List[object]]::new()
    foreach ($p in (Get-FDDArray (Get-FDDField $Data 'players'))) {
        $eligible=$null;$raw=Get-FDDField $p 'eligiblePositions'
        if ($raw -is [Array] -and $raw.Count -gt 0) {$list=[Collections.Generic.List[object]]::new();foreach ($position in (Get-FDDArray $raw 32)) {$list.Add((ConvertTo-FDDText $position 20))};$eligible=$list.ToArray()}
        $undroppable=Get-FDDField $p 'isUndroppable';if ($undroppable -isnot [bool]) {$undroppable=$null}
        $players.Add([ordered]@{Player=(ConvertTo-FDDText (Get-FDDField $p 'name'));Position=(ConvertTo-FDDText (Get-FDDField $p 'selectedPosition') 20);Status=(ConvertTo-FDDText (Get-FDDField $p 'status') 40);EligiblePositions=$eligible;TeamCode=(ConvertTo-FDDText (Get-FDDField $p 'team') 20);IsUndroppable=$undroppable})
    }
    return [ordered]@{PlayerCount=$players.Count;Players=$players.ToArray()}
}
function ConvertFrom-FDDLeagueMatchup {
    param([object]$Data,[object]$Selected,[object]$Week)
    if ($null -eq $Week) {Stop-FlaimDataFailure 'InvalidDashboardData'}
    $pairs=@((Get-FDDArray (Get-FDDField $Data 'matchups')) | Where-Object {
        (Test-FDDLeagueIdentity (Get-FDDField $_ 'home') $Selected) -or (Test-FDDLeagueIdentity (Get-FDDField $_ 'away') $Selected)
    })
    if ($pairs.Count -ne 1) {Stop-FlaimDataFailure 'IdentityMismatch'}
    $homeEntry=Get-FDDField $pairs[0] 'home';$awayEntry=Get-FDDField $pairs[0] 'away'
    $homeOwn=Test-FDDLeagueIdentity $homeEntry $Selected;$awayOwn=Test-FDDLeagueIdentity $awayEntry $Selected
    if ($homeOwn -eq $awayOwn) {Stop-FlaimDataFailure 'IdentityMismatch'}
    $own=$homeEntry;$opponent=$awayEntry;if (-not $homeOwn) {$own=$awayEntry;$opponent=$homeEntry}
    $converted=ConvertFrom-FDDHistoryMatchup $Data $Selected ([int]$Week)
    return [ordered]@{Week=$converted['Week'];WeekStartDate=$null;WeekEndDate=$null;Status=$converted['Status'];Opponent=$converted['Opponent'];OwnScore=$converted['OwnScore'];OpponentScore=$converted['OpponentScore'];OwnGamesRemaining=(ConvertTo-FDDNumber (Get-FDDField $own 'gamesRemaining') -Maximum 1000 -Integer);OpponentGamesRemaining=(ConvertTo-FDDNumber (Get-FDDField $opponent 'gamesRemaining') -Maximum 1000 -Integer);Categories=$converted['Categories']}
}
function ConvertFrom-FDDLeagueBudget {
    param([object]$Data,[object]$Selected,[object]$MaximumAdds)
    $rows=@((Get-FDDArray (Get-FDDField $Data 'standings') 1000) | Where-Object {Test-FDDLeagueIdentity $_ $Selected})
    if ($rows.Count -ne 1) {Stop-FlaimDataFailure 'IdentityMismatch'}
    return [ordered]@{FaabBalance=(ConvertTo-FDDNumber (Get-FDDField $rows[0] 'faabBalance'));WaiverPriority=(ConvertTo-FDDNumber (Get-FDDField $rows[0] 'waiverPriority') -Minimum 1 -Maximum 1000 -Integer);MaxWeeklyAdds=$MaximumAdds;AddsUsedThisWeek=$null;AddsRemainingThisWeek=$null}
}
function New-FDDReusedSection {
    param([object]$Data,[string]$ReadAt)
    if ([string]::IsNullOrWhiteSpace($ReadAt)) {Stop-FlaimDataFailure 'InvalidDashboardData'}
    $section=New-FDDSection 'ok' $Data $null
    $section['CheckedAtUtc']=$ReadAt;$section['RetrievedAtUtc']=$ReadAt
    return $section
}
function New-FDDSelectionKey {
    param([string]$Name)
    $hash=[Security.Cryptography.SHA256]::Create()
    try {return 'team-'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Name))).Replace('-','').ToLowerInvariant()}
    finally {$hash.Dispose()}
}
function Read-FDDLeague {
    param([object]$Context,[Collections.IDictionary]$Tools,[Collections.IDictionary]$Base,[object]$Selected,[object]$Sections,[string]$LeagueName,[int]$SeasonYear)
    $rows=[Collections.Generic.List[object]]::new();$checked=[DateTimeOffset]::UtcNow.ToString('o')
    $count=$null;$week=$null;$maximumAdds=$null
    if ($Sections['Rules']['Status'] -ceq 'ok') {$count=$Sections['Rules']['Data']['TeamCount'];$week=$Sections['Rules']['Data']['CurrentWeek'];$maximumAdds=$Sections['Rules']['Data']['MaxWeeklyAdds']}
    $catalog=$script:FDDLeagueCatalog
    $catalogValid=$catalog -is [Array] -and $catalog.Count -gt 0 -and $catalog.Count -le 32
    if ($catalogValid) {
        $names=[Collections.Generic.List[object]]::new();$ids=[Collections.Generic.List[object]]::new()
        foreach ($entry in $catalog) {
            $names.Add((ConvertTo-FDDText (Get-FDDField $entry 'teamName')))
            $id=Get-FDDField $entry 'teamId';if ($id -is [int] -or $id -is [long]) {$id=[string]$id}
            if ($id -isnot [string] -or $id.Length -gt 512 -or $id -cnotmatch '^[\x21-\x7e]+$') {$id=$null}
            $ids.Add($id)
        }
        for ($index=0;$index -lt $catalog.Count;$index++) {
            $name=$names[$index];$id=$ids[$index]
            $duplicateName=$null -eq $name -or @($names | Where-Object {$_ -ceq $name}).Count -ne 1
            $duplicateId=$null -eq $id -or @($ids | Where-Object {$_ -ceq $id}).Count -ne 1
            $label=$name;if ($null -eq $label) {$label='Unnamed team '+($index+1)}
            $selectionKey=New-FDDSelectionKey $label;if ($duplicateName) {$selectionKey+='-'+($index+1)}
            $chosen=@{leagueId=$Selected['leagueId'];teamId=$id;teamName=(Get-FDDField $catalog[$index] 'teamName')}
            $own=$null;if (-not $duplicateId) {$own=Test-FDDTeam @{teamId=$id} $Selected}
            $identityUnknown=$duplicateName -or $duplicateId -or -not (Test-FDDLeagueIdentity $catalog[$index] $chosen)
            if ($identityUnknown) {
                $roster=New-FDDSection 'unavailable' $null 'LeagueTeamIdentityUnknown';$matchup=New-FDDSection 'unavailable' $null 'LeagueTeamIdentityUnknown';$budget=New-FDDSection 'unavailable' $null 'LeagueTeamIdentityUnknown'
            }
            else {
                if ($own) {
                    try {$roster=New-FDDReusedSection (ConvertFrom-FDDLeagueRoster $script:FDDLeagueOwnRoster $chosen) $Sections['Roster']['RetrievedAtUtc']}
                    catch {$roster=New-FDDSection 'error' $null 'IdentityMismatch'}
                }
                else {
                    $arguments=[ordered]@{};foreach ($key in $Base.Keys) {$arguments[$key]=$Base[$key]};$arguments['team_id']=$id
                    $roster=Read-FDDSection $Context $Tools 'get_roster' $arguments {param($d) ConvertFrom-FDDLeagueRoster $d $chosen}
                }
                $matchReadAt=$Sections['Matchup']['RetrievedAtUtc'];if ($null -eq $matchReadAt) {$matchReadAt=$script:FDDLeagueMatchupsReadAt}
                try {$matchup=New-FDDReusedSection (ConvertFrom-FDDLeagueMatchup $script:FDDLeagueMatchups $chosen $week) $matchReadAt}
                catch {$matchup=New-FDDSection 'error' $null 'LeagueMatchupUnavailable'}
                $budgetReadAt=$Sections['Budget']['RetrievedAtUtc'];if ($null -eq $budgetReadAt) {$budgetReadAt=$script:FDDLeagueStandingsReadAt}
                try {$budget=New-FDDReusedSection (ConvertFrom-FDDLeagueBudget $script:FDDLeagueStandings $chosen $maximumAdds) $budgetReadAt}
                catch {$budget=New-FDDSection 'error' $null 'LeagueBudgetUnavailable'}
            }
            $good=@($roster,$matchup,$budget | Where-Object {$_['Status'] -ceq 'ok'}).Count
            $status='error';if ($good -eq 3) {$status='ok'} elseif ($good -gt 0) {$status='partial'}
            if ($identityUnknown) {$status='unavailable'}
            $rows.Add([ordered]@{SelectionKey=$selectionKey;Team=$label;IsUserTeam=$own;Status=$status;Roster=$roster;Matchup=$matchup;Budget=$budget})
        }
    }
    $status='error';$errorType='LeagueTeamListUnavailable';$readAt=$null
    if ($rows.Count -gt 0) {
        $status='partial';$errorType='LeagueTeamsPartial';$readAt=[DateTimeOffset]::UtcNow.ToString('o')
        if ($null -ne $count -and $rows.Count -eq $count -and @($rows | Where-Object {$_['Status'] -cne 'ok'}).Count -eq 0 -and $Sections['Rules']['Status'] -ceq 'ok' -and $Sections['Market']['Status'] -ceq 'ok') {$status='ok';$errorType=$null}
    }
    $checked=[DateTimeOffset]::UtcNow.ToString('o')
    return [ordered]@{SchemaVersion=1;League=$LeagueName;Platform='yahoo';Season=$SeasonYear;CheckedAtUtc=$checked;RetrievedAtUtc=$readAt;SourceUpdatedAtUtc=$null;Status=$status;ErrorType=$errorType;TeamCount=$count;CurrentWeek=$week;Rules=$Sections['Rules'];Market=$Sections['Market'];Teams=$rows.ToArray()}
}

# Callback used by the imported, tested transport initializer.
function Read-FlaimTeamContext {
    param([object]$Context,[Collections.IDictionary]$Tools,[Collections.IDictionary]$Data,[string]$LeagueName,[string]$TeamName,[int]$SeasonYear)
    $allLeagues=Get-FDDArray (Get-FDDField $Data 'allLeagues') 1000
    $matches=@($allLeagues | Where-Object {
        (Get-FDDField $_ 'platform') -ceq 'yahoo' -and (Get-FDDField $_ 'sport') -ceq 'basketball' -and
        (Get-FDDField $_ 'leagueName') -ceq $LeagueName -and (Get-FDDField $_ 'teamName') -ceq $TeamName -and
        [string](Get-FDDField $_ 'seasonYear') -ceq [string]$SeasonYear
    })
    if ($matches.Count -ne 1) { Stop-FlaimDataFailure 'LeagueNotFound' }
    $selected=$matches[0]
    foreach ($name in @('leagueId','teamId')) {
        $value=Get-FDDField $selected $name
        if ($value -isnot [string] -or $value.Length -gt 512 -or $value -cnotmatch '^[\x21-\x7e]+$') { Stop-FlaimDataFailure 'MissingTeamIdentifiers' }
    }
    $base=[ordered]@{league_id=$selected['leagueId'];platform='yahoo';season_year=[int]$selected['seasonYear'];sport='basketball'}
    $teamArgs=[ordered]@{}; foreach ($key in $base.Keys) {$teamArgs[$key]=$base[$key]};$teamArgs['team_id']=$selected['teamId']
    $sections=[ordered]@{}
    # This must precede every league data tool, including when the settings are unavailable.
    $sections['Rules']=Read-FDDSection $Context $Tools 'get_league_info' $base {
        param($d)
        if ((Get-FDDField $d 'name') -cne $LeagueName) { Stop-FlaimDataFailure 'IdentityMismatch' }
        if ($script:FDDReadLeague) {$script:FDDLeagueCatalog=Get-FDDField $d 'teams'}
        if ($script:FDDReadHistory) {
            $script:FDDHistoryBounds=@{
                Start=(ConvertTo-FDDNumber (Get-FDDField $d 'startWeek') -Minimum 1 -Maximum 100 -Integer)
                End=(ConvertTo-FDDNumber (Get-FDDField $d 'endWeek') -Minimum 1 -Maximum 100 -Integer)
                Current=(ConvertTo-FDDNumber (Get-FDDField $d 'currentWeek') -Minimum 1 -Maximum 100 -Integer)
            }
        }
        $positions=[Collections.Generic.List[object]]::new()
        $rawPositions=Get-FDDField $d 'rosterPositions'
        if ($null -ne $rawPositions) { foreach ($p in (Get-FDDArray $rawPositions 50)) { $positions.Add([ordered]@{Position=(ConvertTo-FDDText (Get-FDDField $p 'position') 20);Count=(ConvertTo-FDDNumber (Get-FDDField $p 'count') -Maximum 100 -Integer)}) } }
        $format=Get-FDDField $d 'scoringFormat';if (@('points','categories','roto','unknown') -cnotcontains $format) {$format=$null}
        $usesFaab=Get-FDDField $d 'usesFaab';if ($usesFaab -isnot [bool]) {$usesFaab=$null}
        return [ordered]@{
            TeamCount=(ConvertTo-FDDNumber (Get-FDDField $d 'numTeams') -Maximum 1000 -Integer); ScoringFormat=$format; ScoringType=(ConvertTo-FDDText (Get-FDDField $d 'scoringType') 64)
            CurrentWeek=(ConvertTo-FDDNumber (Get-FDDField $d 'currentWeek') -Minimum 1 -Maximum 100 -Integer); MaxWeeklyAdds=(ConvertTo-FDDNumber (Get-FDDField $d 'maxWeeklyAdds') -Maximum 1000 -Integer)
            UsesFaab=$usesFaab; WaiverTimeDays=(ConvertTo-FDDNumber (Get-FDDField $d 'waiverTime') -Maximum 365 -Integer); RosterPositions=$positions.ToArray()
            ConfiguredScoringCategories=$null; StatModifiers=$null; Bonuses=$null
            ProviderRuleCodes=[ordered]@{WaiverType=(ConvertTo-FDDText (Get-FDDField $d 'waiverType') 40);WaiverRule=(ConvertTo-FDDText (Get-FDDField $d 'waiverRule') 40);WeeklyDeadline=(ConvertTo-FDDText (Get-FDDField $d 'weeklyDeadline') 40);PostDraftPlayers=(ConvertTo-FDDText (Get-FDDField $d 'postDraftPlayers') 40);CantCutList=(ConvertTo-FDDText (Get-FDDField $d 'cantCutList') 40)}
            TradeEndDate=(ConvertTo-FDDDate (Get-FDDField $d 'tradeEndDate'))
        }
    }
    $sections['Roster']=Read-FDDSection $Context $Tools 'get_roster' $teamArgs {
        param($d)
        if ($script:FDDReadLeague) {$script:FDDLeagueOwnRoster=$d}
        if ((Get-FDDField $d 'teamName') -cne $TeamName) { Stop-FlaimDataFailure 'IdentityMismatch' }
        $snapshot=Get-FDDField $d 'snapshot'
        if ($null -ne $snapshot -and (Get-FDDField $snapshot 'type') -cne 'current') { Stop-FlaimDataFailure 'InvalidDashboardData' }
        $players=[Collections.Generic.List[object]]::new()
        foreach ($p in (Get-FDDArray (Get-FDDField $d 'players'))) {
            $eligible=$null;$raw=Get-FDDField $p 'eligiblePositions'
            if ($raw -is [Array] -and $raw.Count -gt 0) { $list=[Collections.Generic.List[object]]::new();foreach ($pos in (Get-FDDArray $raw 32)) {$list.Add((ConvertTo-FDDText $pos 20))};$eligible=$list.ToArray() }
            $undroppable=Get-FDDField $p 'isUndroppable';if ($undroppable -isnot [bool]) {$undroppable=$null}
            $players.Add([ordered]@{Player=(ConvertTo-FDDText (Get-FDDField $p 'name'));Position=(ConvertTo-FDDText (Get-FDDField $p 'selectedPosition') 20);Status=(ConvertTo-FDDText (Get-FDDField $p 'status') 40);EligiblePositions=$eligible;TeamCode=(ConvertTo-FDDText (Get-FDDField $p 'team') 20);IsUndroppable=$undroppable})
        }
        return [ordered]@{PlayerCount=$players.Count;Players=$players.ToArray()}
    }
    $matchArgs=[ordered]@{};foreach ($key in $base.Keys) {$matchArgs[$key]=$base[$key]}
    $week=$null;if ($sections['Rules']['Status'] -eq 'ok') {$week=$sections['Rules']['Data']['CurrentWeek']};if ($null -ne $week) {$matchArgs['week']=[int]$week}
    $sections['Matchup']=Read-FDDSection $Context $Tools 'get_matchups' $matchArgs {
        param($d)
        if ($script:FDDReadLeague) {$script:FDDLeagueMatchups=$d;$script:FDDLeagueMatchupsReadAt=[DateTimeOffset]::UtcNow.ToString('o')}
        $allPairs=Get-FDDArray (Get-FDDField $d 'matchups')
        $pairs=@($allPairs | Where-Object {(Test-FDDTeam (Get-FDDField $_ 'home') $selected) -or (Test-FDDTeam (Get-FDDField $_ 'away') $selected)})
        if ($pairs.Count -ne 1) { Stop-FlaimDataFailure 'IdentityMismatch' }
        $pair=$pairs[0];$own=Get-FDDField $pair 'home';$opp=Get-FDDField $pair 'away'
        if (-not (Test-FDDTeam $own $selected)) {$swap=$own;$own=$opp;$opp=$swap}
        if ($opp -isnot [Collections.IDictionary]) { Stop-FlaimDataFailure 'InvalidDashboardData' }
        $rows=[Collections.Generic.List[object]]::new();$ownCategories=Get-FDDField $own 'categories';$oppCategories=Get-FDDField $opp 'categories'
        if ($ownCategories -is [Array]) {
            foreach ($c in (Get-FDDArray $ownCategories)) {
                $other=$null;foreach ($oc in @(Get-FDDArray $oppCategories)) {if ((Get-FDDField $oc 'statId') -ceq (Get-FDDField $c 'statId')) {$other=$oc;break}}
                $result=Get-FDDField $c 'result';if (@('win','loss','tie') -cnotcontains $result) {$result=$null}
                $display=Get-FDDField $c 'isDisplayOnly';if ($display -isnot [bool]) {$display=$null}
                $ownValue=ConvertTo-FDDStatValue (Get-FDDField $c 'value')
                $oppValue=ConvertTo-FDDStatValue (Get-FDDField $other 'value')
                $rows.Add([ordered]@{Name=(ConvertTo-FDDText (Get-FDDField $c 'name'));Label=(ConvertTo-FDDText (Get-FDDField $c 'displayName') 40);OwnValue=$ownValue;OpponentValue=$oppValue;Result=$result;DisplayOnly=$display})
            }
        }
        $status=Get-FDDField $pair 'status';if (@('upcoming','in_progress','final') -cnotcontains $status) {$status=$null}
        return [ordered]@{Week=(ConvertTo-FDDNumber (Get-FDDField $pair 'week') -Minimum 1 -Maximum 100 -Integer);WeekStartDate=$null;WeekEndDate=$null;Status=$status;Opponent=(ConvertTo-FDDText (Get-FDDField $opp 'teamName'));OwnScore=(ConvertTo-FDDScore (Get-FDDField $own 'categoryScore'));OpponentScore=(ConvertTo-FDDScore (Get-FDDField $opp 'categoryScore'));OwnGamesRemaining=(ConvertTo-FDDNumber (Get-FDDField $own 'gamesRemaining') -Maximum 1000 -Integer);OpponentGamesRemaining=(ConvertTo-FDDNumber (Get-FDDField $opp 'gamesRemaining') -Maximum 1000 -Integer);Categories=$rows.ToArray()}
    }
    $txArgs=[ordered]@{};foreach ($key in $teamArgs.Keys) {$txArgs[$key]=$teamArgs[$key]}
    $txArgs['start_date']=[DateTime]::UtcNow.Date.AddDays(-29).ToString('yyyy-MM-dd');$txArgs['end_date']=[DateTime]::UtcNow.ToString('yyyy-MM-dd');$txArgs['count']=100
    $sections['Transactions']=Read-FDDSection $Context $Tools 'get_transactions' $txArgs {
        param($d)
        $rows=[Collections.Generic.List[object]]::new()
        foreach ($t in (Get-FDDArray (Get-FDDField $d 'transactions'))) {
            $type=Get-FDDField $t 'type';if (@('add','drop','trade','waiver') -cnotcontains $type) {continue}
            $occurred=$null;$stamp=ConvertTo-FDDNumber (Get-FDDField $t 'timestamp') -Maximum 7258118400000
            if ($null -ne $stamp) {$occurred=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$stamp).ToUniversalTime().ToString('o')}
            $rows.Add([ordered]@{Type=$type;OccurredAtUtc=$occurred;Added=(Get-FDDNameList (Get-FDDField $t 'players_added'));Dropped=(Get-FDDNameList (Get-FDDField $t 'players_dropped'));FaabBid=(ConvertTo-FDDNumber (Get-FDDField $t 'faab_bid'))})
        }
        $limitations=Get-FDDField $d 'limitations'
        return [ordered]@{WindowStartUtcDate=$txArgs['start_date'];WindowEndUtcDate=$txArgs['end_date'];CompletenessVerified=$false;UnrecognizedRows=(ConvertTo-FDDNumber (Get-FDDField $limitations 'omitted_unrecognized_rows') -Maximum 100000 -Integer);Rows=$rows.ToArray();AddsUsedThisWeek=$null;AddsRemainingThisWeek=$null}
    }
    $sections['Budget']=Read-FDDSection $Context $Tools 'get_standings' $base {
        param($d)
        if ($script:FDDReadLeague) {$script:FDDLeagueStandings=$d;$script:FDDLeagueStandingsReadAt=[DateTimeOffset]::UtcNow.ToString('o')}
        $allTeams=Get-FDDArray (Get-FDDField $d 'standings') 1000
        $teams=@($allTeams | Where-Object {Test-FDDTeam $_ $selected})
        if ($teams.Count -ne 1) { Stop-FlaimDataFailure 'IdentityMismatch' }
        $max=$null;if ($sections['Rules']['Status'] -eq 'ok') {$max=$sections['Rules']['Data']['MaxWeeklyAdds']}
        return [ordered]@{FaabBalance=(ConvertTo-FDDNumber (Get-FDDField $teams[0] 'faabBalance'));WaiverPriority=(ConvertTo-FDDNumber (Get-FDDField $teams[0] 'waiverPriority') -Minimum 1 -Maximum 1000 -Integer);MaxWeeklyAdds=$max;AddsUsedThisWeek=$null;AddsRemainingThisWeek=$null}
    }
    $sections['Market']=Read-FDDSection $Context $Tools 'get_free_agents' $base {
        param($d)
        $players=[Collections.Generic.List[object]]::new();$caps=Get-FDDField $d 'capabilities'
        foreach ($p in (Get-FDDArray (Get-FDDField $d 'freeAgents'))) {
            $availability=Get-FDDField $p 'acquisitionState';if (@('free_agent','waivers') -cnotcontains $availability) {$availability=$null}
            $rate=$null;if ((Get-FDDField $caps 'rosteredRate') -eq $true) {$rate=ConvertTo-FDDNumber (Get-FDDField $p 'percentOwned') -Maximum 100}
            $waiverDate=$null;if ($availability -ceq 'waivers') {$waiverDate=ConvertTo-FDDDate (Get-FDDField $p 'waiverDate')}
            $players.Add([ordered]@{Player=(ConvertTo-FDDText (Get-FDDField $p 'name'));Position=(ConvertTo-FDDText (Get-FDDField $p 'position') 80);TeamCode=(ConvertTo-FDDText (Get-FDDField $p 'team') 20);Availability=$availability;PercentOwned=$rate;WaiverDate=$waiverDate})
        }
        return [ordered]@{Coverage='returned_list';RateScope='yahoo_platform_global';Players=$players.ToArray()}
    }
    $sections['Schedule']=New-FDDSection 'unavailable' $null 'ScheduleNotFetched' 'NBA official'
    if ($script:FDDReadHistory) {$script:FDDHistory=Read-FDDHistory $Context $Tools $base $selected $script:FDDHistoryBounds $LeagueName $TeamName $SeasonYear}
    if ($script:FDDReadLeague) {$script:FDDLeague=Read-FDDLeague $Context $Tools $base $selected $sections $LeagueName $SeasonYear}
    return [ordered]@{SchemaVersion=2;League=$LeagueName;Team=$TeamName;Platform='yahoo';Season=$SeasonYear;GeneratedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');Sections=$sections}
}

function Assert-FDDNoCredentials {
    param([object]$Session,[object]$Snapshot)
    # Also compare final string leaves, including generated dates and fixed labels.
    $stack=[Collections.Generic.Stack[object]]::new();$stack.Push($Snapshot)
    while ($stack.Count -gt 0) {
        $item=$stack.Pop()
        if ($item -is [string]) {$script:FDDLabels.Add($item)}
        elseif ($item -is [Collections.IDictionary]) {foreach ($value in $item.Values) {if ($null -ne $value) {$stack.Push($value)}}}
        elseif ($item -is [Array]) {foreach ($value in $item) {if ($null -ne $value) {$stack.Push($value)}}}
    }
    foreach ($name in @('AccessToken','RefreshToken')) {
        $property=$Session.PSObject.Properties[$name]
        if ($null -eq $property -or $null -eq $property.Value) {continue}
        if ($property.Value -isnot [Security.SecureString]) {Stop-FlaimDataFailure 'InvalidSession'}
        $pointer=[IntPtr]::Zero;$plain=$null
        try {
            $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($property.Value)
            $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ([string]::IsNullOrEmpty($plain)) {Stop-FlaimDataFailure 'InvalidSession'}
            foreach ($label in $script:FDDLabels) {if ($label.IndexOf($plain,[StringComparison]::Ordinal) -ge 0) {Stop-FlaimDataFailure 'CredentialDataDetected'}}
        }
        finally {if ($pointer -ne [IntPtr]::Zero) {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)};$plain=$null}
    }
}
function Invoke-FlaimDashboardExport {
    param([object]$Session,[string]$Destination,[int]$Seconds=30,[string]$HistoryDestination,[string]$LeagueDestination)
    $ErrorActionPreference='Stop';$VerbosePreference='SilentlyContinue';$DebugPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue'
    $script:FDDLabels=[Collections.Generic.List[string]]::new();$temporary=$null;$snapshot=$null;$json=$null;$historyTemporary=$null;$historyFull=$null;$historyJson=$null
    $script:FDDReadHistory=-not [string]::IsNullOrWhiteSpace($HistoryDestination);$script:FDDHistory=$null;$script:FDDHistoryBounds=$null
    $script:FDDReadLeague=-not [string]::IsNullOrWhiteSpace($LeagueDestination);$script:FDDLeague=$null;$leagueTemporary=$null;$leagueFull=$null;$leagueJson=$null
    $script:FDDLeagueCatalog=$null;$script:FDDLeagueOwnRoster=$null;$script:FDDLeagueMatchups=$null;$script:FDDLeagueStandings=$null;$script:FDDLeagueMatchupsReadAt=$null;$script:FDDLeagueStandingsReadAt=$null
    try {
        if ($PSVersionTable.PSEdition -cne 'Desktop') {Stop-FlaimDataFailure 'UnsupportedRuntime'}
        $full=[IO.Path]::GetFullPath($Destination);$folder=[IO.Path]::GetDirectoryName($full)
        if ([IO.Path]::GetExtension($full) -ine '.json' -or -not [IO.Directory]::Exists($folder)) {Stop-FlaimDataFailure 'InvalidOutputPath'}
        if ($script:FDDReadHistory) {
            $historyFull=[IO.Path]::GetFullPath($HistoryDestination);$historyFolder=[IO.Path]::GetDirectoryName($historyFull)
            if ([IO.Path]::GetExtension($historyFull) -ine '.json' -or -not [IO.Directory]::Exists($historyFolder) -or $historyFull -ieq $full) {Stop-FlaimDataFailure 'InvalidOutputPath'}
        }
        if ($script:FDDReadLeague) {
            $leagueFull=[IO.Path]::GetFullPath($LeagueDestination);$leagueFolder=[IO.Path]::GetDirectoryName($leagueFull)
            if ([IO.Path]::GetExtension($leagueFull) -ine '.json' -or -not [IO.Directory]::Exists($leagueFolder) -or $leagueFull -ieq $full -or ($script:FDDReadHistory -and $leagueFull -ieq $historyFull)) {Stop-FlaimDataFailure 'InvalidOutputPath'}
        }
        $snapshot=Invoke-FlaimDataTest -Session $Session -Seconds $Seconds -ReadTeam -LeagueName 'Funny League 2026-27' -TeamName 'RayBookDown' -SeasonYear 2026
        if ($snapshot -isnot [Collections.IDictionary] -or (Get-FDDField $snapshot 'SchemaVersion') -ne 2) {Stop-FlaimDataFailure 'DashboardReadFailed'}
        Assert-FDDNoCredentials $Session $snapshot
        if ($script:FDDReadHistory) {
            if ($script:FDDHistory -isnot [Collections.IDictionary]) {Stop-FlaimDataFailure 'DashboardReadFailed'}
            Assert-FDDNoCredentials $Session $script:FDDHistory
            $historyJson=ConvertTo-Json -InputObject $script:FDDHistory -Depth 16
            if ([Text.Encoding]::UTF8.GetByteCount($historyJson) -gt 1048576) {Stop-FlaimDataFailure 'ResponseTooLarge'}
        }
        if ($script:FDDReadLeague) {
            if ($script:FDDLeague -isnot [Collections.IDictionary]) {Stop-FlaimDataFailure 'DashboardReadFailed'}
            Assert-FDDNoCredentials $Session $script:FDDLeague
            $leagueJson=ConvertTo-Json -InputObject $script:FDDLeague -Depth 20
            if ([Text.Encoding]::UTF8.GetByteCount($leagueJson) -gt 1048576) {Stop-FlaimDataFailure 'ResponseTooLarge'}
        }
        $json=ConvertTo-Json -InputObject $snapshot -Depth 16
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 1048576) {Stop-FlaimDataFailure 'ResponseTooLarge'}
        $temporary=Join-Path $folder ('.dashboard-'+[Guid]::NewGuid().ToString('N')+'.tmp')
        [IO.File]::WriteAllText($temporary,$json,[Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($full)) {[IO.File]::Replace($temporary,$full,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($temporary,$full)}
        $temporary=$null;$errors=0;foreach ($section in $snapshot['Sections'].Values) {if ($section['Status'] -eq 'error') {$errors++}}
        if ($script:FDDReadHistory) {
            $historyTemporary=Join-Path $historyFolder ('.history-'+[Guid]::NewGuid().ToString('N')+'.tmp')
            [IO.File]::WriteAllText($historyTemporary,$historyJson,[Text.UTF8Encoding]::new($false))
            if ([IO.File]::Exists($historyFull)) {[IO.File]::Replace($historyTemporary,$historyFull,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($historyTemporary,$historyFull)}
            $historyTemporary=$null
        }
        if ($script:FDDReadLeague) {
            $leagueTemporary=Join-Path $leagueFolder ('.league-'+[Guid]::NewGuid().ToString('N')+'.tmp')
            [IO.File]::WriteAllText($leagueTemporary,$leagueJson,[Text.UTF8Encoding]::new($false))
            if ([IO.File]::Exists($leagueFull)) {[IO.File]::Replace($leagueTemporary,$leagueFull,[Management.Automation.Language.NullString]::Value)} else {[IO.File]::Move($leagueTemporary,$leagueFull)}
            $leagueTemporary=$null
        }
        $count=$null;if ($snapshot['Sections']['Roster']['Status'] -eq 'ok') {$count=$snapshot['Sections']['Roster']['Data']['PlayerCount']}
        return [pscustomobject]@{Exported=$true;PlayerCount=$count;SectionErrors=$errors;HistoryExported=$script:FDDReadHistory;LeagueExported=$script:FDDReadLeague;ErrorType=$null}
    }
    catch {
        $kind='DashboardExportFailed';$allowed=@('UnsupportedRuntime','InvalidSession','InvalidOutputPath','CredentialDataDetected','ResponseTooLarge','DashboardReadFailed')
        if ($allowed -ccontains $_.Exception.Data['FlaimKind']) {$kind=[string]$_.Exception.Data['FlaimKind']}
        return [pscustomobject]@{Exported=$false;PlayerCount=$null;SectionErrors=$null;HistoryExported=$false;LeagueExported=$false;ErrorType=$kind}
    }
    finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) {[IO.File]::Delete($temporary)}
        if ($null -ne $historyTemporary -and [IO.File]::Exists($historyTemporary)) {[IO.File]::Delete($historyTemporary)}
        if ($null -ne $leagueTemporary -and [IO.File]::Exists($leagueTemporary)) {[IO.File]::Delete($leagueTemporary)}
        $script:FDDLabels=$null;$snapshot=$null;$json=$null;$historyJson=$null;$script:FDDReadHistory=$false;$script:FDDHistory=$null;$script:FDDHistoryBounds=$null
        $leagueJson=$null;$script:FDDReadLeague=$false;$script:FDDLeague=$null;$script:FDDLeagueCatalog=$null;$script:FDDLeagueOwnRoster=$null;$script:FDDLeagueMatchups=$null;$script:FDDLeagueStandings=$null;$script:FDDLeagueMatchupsReadAt=$null;$script:FDDLeagueStandingsReadAt=$null
    }
}

if (-not $FunctionsOnly) {Invoke-FlaimDashboardExport -Session $Session -Destination $OutputPath -Seconds $RequestTimeoutSeconds -HistoryDestination $HistoryOutputPath -LeagueDestination $LeagueOutputPath}
