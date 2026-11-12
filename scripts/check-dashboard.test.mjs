import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeDashboard, normalizeFeedUrl, sectionData } from '../dashboard-model.mjs';
import { invalidDashboardSections } from './check-dashboard.mjs';

const base = JSON.parse(await readFile(new URL('../tests/fixtures/dashboard.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(base);
test('validation diagnostics expose only fixed section names, never source values', () => {
  const raw = fixture();
  assert.deepEqual(invalidDashboardSections(raw), []);
  raw.Sections.Market.Data.Players[0].PercentOwned = 101;
  assert.deepEqual(invalidDashboardSections(raw), ['Market']);
  raw.Season = 2025;
  assert.deepEqual(invalidDashboardSections(raw), ['Root']);
});

test('verified public dashboard has independent source times', () => {
  const data = normalizeDashboard(fixture());
  assert.equal(data.SchemaVersion, 2);
  assert.equal(Object.keys(data.Sections).length, 7);
  for (const section of Object.values(data.Sections)) assert.equal(section.SourceUpdatedAtUtc, null);
});
test('wrong league or season is rejected before display', () => {
  const raw = fixture(); raw.Season = 2025;
  assert.throws(() => normalizeDashboard(raw));
});
test('credential keys and provider identifiers are rejected anywhere', () => {
  for (const key of ['access_token', 'RefreshToken', 'playerId', '__proto__']) {
    const raw = fixture();
    Object.defineProperty(raw.Sections.Roster.Data.Players[0], key, { value: 'synthetic-only', enumerable: true });
    assert.throws(() => normalizeDashboard(raw));
  }
});
test('roster count must match actual rows', () => {
  const raw = fixture(); raw.Sections.Roster.Data.PlayerCount += 1;
  assert.throws(() => normalizeDashboard(raw));
});
test('zero budget and unknown budget remain different', () => {
  const raw = fixture(); raw.Sections.Budget.Data.FaabBalance = 0;
  assert.equal(normalizeDashboard(raw).Sections.Budget.Data.FaabBalance, 0);
  raw.Sections.Budget.Data.FaabBalance = null;
  assert.equal(normalizeDashboard(raw).Sections.Budget.Data.FaabBalance, null);
});
test('missing transaction player names remain unknown without rejecting other data', () => {
  const raw = fixture(); raw.Sections.Transactions.Data.Rows[0].Dropped = [null];
  assert.deepEqual(normalizeDashboard(raw).Sections.Transactions.Data.Rows[0].Dropped, [null]);
  raw.Sections.Schedule.Data.Games[0].Teams[0] = null;
  assert.throws(() => normalizeDashboard(raw));
});
test('failed section has unknown data and no false successful read time', () => {
  const raw = fixture();
  raw.Sections.Market.Status = 'error'; raw.Sections.Market.Data = null;
  raw.Sections.Market.RetrievedAtUtc = null; raw.Sections.Market.ErrorType = 'MarketUnavailable';
  const data = normalizeDashboard(raw);
  assert.equal(sectionData(data, 'Market'), null);
  raw.Sections.Market.Data = { Players: [] };
  assert.throws(() => normalizeDashboard(raw));
});
test('Yahoo original timestamp precision is supported', () => {
  const raw = fixture(); raw.Sections.Roster.RetrievedAtUtc = '2026-11-12T14:34:03.8041388+00:00';
  assert.ok(normalizeDashboard(raw).Sections.Roster.RetrievedAtUtc);
});
test('display-only category without a result is not made into a loss', () => {
  const raw = fixture();
  const display = raw.Sections.Matchup.Data.Categories.find(c => c.DisplayOnly === true);
  assert.ok(display); assert.equal(display.Result, null);
  const out = normalizeDashboard(raw).Sections.Matchup.Data.Categories.find(c => c.DisplayOnly === true);
  assert.equal(out.Result, null);
});
test('NBA links cannot point to an unrelated host', () => {
  const raw = fixture(); raw.Sections.Schedule.Data.Games[0].SourceUrl = 'https://example.com/game';
  assert.throws(() => normalizeDashboard(raw));
});
test('public source URLs reject embedded credentials and query strings', () => {
  const page = 'https://iverson761011-web.github.io/raybookdown/';
  const defaultFeed = 'https://raw.githubusercontent.com/iverson761011-web/raybookdown/main/data/dashboard.json';
  for (const url of ['https://user:pass@example.com/data.json', 'https://example.com/data.json?signature=synthetic', 'https://example.com/data.json#secret']) {
    assert.throws(() => normalizeFeedUrl(url, page, defaultFeed));
  }
});
