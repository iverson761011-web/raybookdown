// Synthetic public-shape data for identity and rendering tests; never published as a live snapshot.
export const leagueTime='2026-11-13T00:00:00Z';
export const leagueKey=letter=>'team-'+letter.repeat(64);
const section=data=>({Status:'ok',Source:'Flaim Fantasy / Yahoo',CheckedAtUtc:leagueTime,RetrievedAtUtc:leagueTime,SourceUpdatedAtUtc:null,ErrorType:null,Data:data});
export function leagueFixture(){
 const make=(letter,Team,Player,amount,IsUserTeam=false)=>({
  SelectionKey:leagueKey(letter),Team,IsUserTeam,Status:'ok',
  Roster:section({PlayerCount:1,Players:[{Player,Position:'PG',Status:null,TeamCode:'CLE',EligiblePositions:['PG','Util'],IsUndroppable:IsUserTeam}]}),
  Matchup:section({Week:4,Status:'in_progress',Opponent:Team+' opponent',OwnScore:{Wins:IsUserTeam?7:4,Losses:IsUserTeam?6:9,Ties:0},OpponentScore:{Wins:IsUserTeam?6:9,Losses:IsUserTeam?7:4,Ties:0},WeekStartDate:null,WeekEndDate:null,OwnGamesRemaining:null,OpponentGamesRemaining:null,Categories:[]}),
  Budget:section({FaabBalance:amount,WaiverPriority:IsUserTeam?1:3,MaxWeeklyAdds:6,AddsUsedThisWeek:null,AddsRemainingThisWeek:null}),
  Sources:[{Name:Team+' roster',RetrievedAtUtc:leagueTime,SourceUpdatedAtUtc:null,Url:null}],
  Strengths:[Team+' 的 PTS 是目前強項'],Weaknesses:[Team+' 的 TO 需要補強'],
  Categories:[{Label:'PTS',OwnValue:IsUserTeam?100:75,Rank:IsUserTeam?1:4,ComparedTeamCount:4,Assessment:IsUserTeam?'strength':'weakness',Direction:'higher',CompleteLeagueCoverage:true},{Label:'TO',OwnValue:IsUserTeam?8:0,Rank:IsUserTeam?4:1,ComparedTeamCount:4,Assessment:IsUserTeam?'weakness':'strength',Direction:'lower',CompleteLeagueCoverage:true}],
  Recommendations:{SchemaVersion:1,Status:'insufficient_data',GeneratedAtUtc:leagueTime,ReportDateET:'2026-11-11',Strategy:'aggressive_week',Reasons:['合成測試資料，近期樣本不足'],Candidates:[{Player:Team+' pickup',TeamCode:'CLE',Availability:'free_agent',RemainingGames:2,SampleGames7:3,SampleGames14:6,InjuryStatus:null,Recommendation:Team+' 的觀察候選',Reasons:['補強 '+Team+' 的比項'],Tradeoffs:['仍須確認出賽'],DropOptions:[]}],DropReviews:[{Player,TeamCode:'CLE',Review:Team+' 的保留觀察',Reasons:['此筆只屬於 '+Team],Tradeoffs:[],SampleGames7:3,SampleGames14:6,RemainingGames:2,Protected:IsUserTeam}],Sources:[{Name:Team+' NBA statistics',RetrievedAtUtc:leagueTime,SourceUpdatedAtUtc:null,Url:'https://www.nba.com/schedule'}],Week:{Basis:'taipei_calendar',StartDateTaipei:'2026-11-09',EndDateTaipei:'2026-11-15',VerifiedYahooWeek:false},Notes:['合成測試資料，不保證出賽']},
  Notes:[]
 });
 return{SchemaVersion:1,League:'Funny League 2026-27',Platform:'yahoo',Season:2026,Status:'ok',GeneratedAtUtc:leagueTime,RetrievedAtUtc:leagueTime,SourceUpdatedAtUtc:null,CurrentWeek:4,TeamCount:4,ComparedTeamCount:4,Teams:[make('a','RayBookDown','Ray-only player',80,true),make('b','Other Team','Other-only player',0),make('c','Third Team','Third-only player',30),make('d','Fourth Team','Fourth-only player',40)],Notes:['本週累計比較，不代表長期實力']};
}
