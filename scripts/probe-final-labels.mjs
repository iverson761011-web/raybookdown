import {fetchOfficialEvidence,nextData,normalizeFinalStatus} from './collect-recommendation-evidence.mjs';
try {
 const date='2026-11-12'; const raw=await fetchOfficialEvidence('https://www.nba.com/games?date='+date);
 const root=nextData(new TextDecoder().decode(raw));
 const games=root.props.pageProps.gameCardFeed.modules.flatMap(m=>m.cards??[]).map(c=>c.cardData?.game??c.cardData).filter(g=>g?.gameId);
 console.log(JSON.stringify({DateET:date,QueryMatches:root.query.date===date,Games:games.map(g=>({GameId:g.gameId,RawStatus:g.gameStatus,RawLabel:g.gameStatusText,Parsed:normalizeFinalStatus(g)}))}));
} catch {console.error('OfficialStatusProbeFailed');process.exitCode=1;}
