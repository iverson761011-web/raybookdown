import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const credentialKey = /token|secret|password|authorization|cookie|credential|code_verifier/i;
const allowed = new Set(['SchemaVersion','Connected','DataRead','League','Team','Platform','Season','ScoringFormat','ScoringType','TeamCount','PlayerCount','NamedPlayerCount','Players','RetrievedAtUtc']);
function requireCondition(condition) { if (!condition) throw new Error('InvalidSnapshot'); }
function rejectCredentials(value, depth = 0) {
  requireCondition(depth <= 8);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (credentialKey.test(key)) throw new Error('CredentialFieldRejected');
    rejectCredentials(child, depth + 1);
  }
}
export function validateSnapshot(data) {
  requireCondition(data && typeof data === 'object' && !Array.isArray(data));
  rejectCredentials(data);
  requireCondition(Object.keys(data).every(key => allowed.has(key)));
  requireCondition(data.SchemaVersion === 1 && data.Connected === true && data.DataRead === true);
  requireCondition(data.League === 'Funny League 2026-27' && data.Team === 'RayBookDown' && data.Platform === 'yahoo' && data.Season === 2026);
  requireCondition(data.ScoringFormat === null || ['points','categories','roto','unknown'].includes(data.ScoringFormat));
  requireCondition(data.ScoringType === null || (typeof data.ScoringType === 'string' && data.ScoringType.length <= 200));
  requireCondition(data.TeamCount === null || (Number.isInteger(data.TeamCount) && data.TeamCount > 0 && data.TeamCount <= 1000));
  requireCondition(Array.isArray(data.Players) && data.Players.length <= 100);
  requireCondition(data.PlayerCount === data.Players.length && Number.isInteger(data.NamedPlayerCount));
  let named = 0;
  for (const player of data.Players) {
    requireCondition(player && typeof player === 'object' && !Array.isArray(player));
    requireCondition(Object.keys(player).every(key => ['Player','Position','Status','EligiblePositions'].includes(key)));
    for (const key of ['Player','Position','Status','EligiblePositions']) {
      const value = player[key];
      requireCondition(value === null || (typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)));
    }
    if (typeof player.Player === 'string' && player.Player.trim()) named++;
  }
  requireCondition(data.NamedPlayerCount === named);
  requireCondition(data.RetrievedAtUtc === null || (typeof data.RetrievedAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(data.RetrievedAtUtc) && Number.isFinite(Date.parse(data.RetrievedAtUtc))));
  return { playerCount: data.PlayerCount, hasReadTime: data.RetrievedAtUtc !== null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bytes = await fs.readFile(process.argv[2] || 'data/team.json');
    requireCondition(bytes.length <= 1048576);
    const result = validateSnapshot(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
    console.log(`SnapshotValid=true; PlayerCount=${result.playerCount}; ReadTimeProvided=${result.hasReadTime}`);
    console.log('This check does not fetch Flaim data or refresh credentials.');
  } catch {
    console.error('SnapshotValid=false; ErrorType=InvalidOrUnsafeSnapshot');
    process.exitCode = 1;
  }
}
