import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeDashboard } from '../dashboard-model.mjs';

export function validateDashboard(raw) {
  return normalizeDashboard(raw);
}

export function invalidDashboardSections(raw) {
  try { normalizeDashboard(raw); return []; } catch { }
  const names = ['Rules','Roster','Matchup','Transactions','Budget','Market','Schedule'];
  const timestamp = '2026-01-01T00:00:00.000Z';
  const empty = Object.fromEntries(names.map(name => [name, { Status:'unavailable', Source:'Validation', CheckedAtUtc:timestamp, RetrievedAtUtc:null, SourceUpdatedAtUtc:null, ErrorType:'Unknown', Data:null }]));
  const base = { SchemaVersion:raw?.SchemaVersion, League:raw?.League, Team:raw?.Team, Platform:raw?.Platform, Season:raw?.Season, GeneratedAtUtc:raw?.GeneratedAtUtc, Sections:empty };
  try { normalizeDashboard(base); } catch { return ['Root']; }
  const invalid = names.filter(name => {
    try { normalizeDashboard({ ...base, Sections:{ ...empty, [name]:raw?.Sections?.[name] } }); return false; }
    catch { return true; }
  });
  return invalid.length ? invalid : ['Root'];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw;
  try {
    const bytes = await readFile(process.argv[2] || 'data/dashboard.json');
    if (bytes.length > 1048576) throw new Error('InvalidDashboard');
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const data = validateDashboard(raw);
    const sections = Object.values(data.Sections);
    console.log(`Dashboard validated; Sections=${sections.length}; Available=${sections.filter(s => s.Status === 'ok').length}; Other=${sections.filter(s => s.Status !== 'ok').length}`);
  } catch {
    console.error(JSON.stringify({ ErrorType:'DashboardValidationFailed', InvalidSections:raw ? invalidDashboardSections(raw) : ['Root'] }));
    process.exitCode = 1;
  }
}
