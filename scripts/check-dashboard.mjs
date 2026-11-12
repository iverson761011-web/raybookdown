import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeDashboard } from '../dashboard-model.mjs';

export function validateDashboard(raw) {
  return normalizeDashboard(raw);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const bytes = await readFile(process.argv[2] || 'data/dashboard.json');
    if (bytes.length > 1048576) throw new Error('InvalidDashboard');
    const data = validateDashboard(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const sections = Object.values(data.Sections);
    console.log(`Dashboard validated; Sections=${sections.length}; Available=${sections.filter(s => s.Status === 'ok').length}; Other=${sections.filter(s => s.Status !== 'ok').length}`);
  } catch {
    console.error('Dashboard validation failed. No source data was printed.');
    process.exitCode = 1;
  }
}
