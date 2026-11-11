import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { validateSnapshot } from './check-snapshot.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('../data/team.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(fixture);

test('verified roster is accepted with unknown read time', () => {
  const data = clone(); data.RetrievedAtUtc = null;
  assert.deepEqual(validateSnapshot(data), {playerCount:data.Players.length, hasReadTime:false});
});
test('UTC exporter dates preserve optional seven fractional digits', () => {
  const data = clone();
  data.RetrievedAtUtc = '2026-11-12T01:03:41.1234567+00:00';
  assert.equal(validateSnapshot(data).hasReadTime, true);
});
test('credentials are rejected even when nested', () => {
  const data = clone();
  data.Players[0].RefreshToken = 'synthetic-do-not-echo';
  assert.throws(() => validateSnapshot(data), /CredentialFieldRejected/);
});
test('unrecognized metadata is rejected', () => {
  const data = clone(); data.RawResponse = {};
  assert.throws(() => validateSnapshot(data), /InvalidSnapshot/);
});
test('other teams and inconsistent counts are rejected', () => {
  const team = clone(); team.Team = 'other';
  assert.throws(() => validateSnapshot(team), /InvalidSnapshot/);
  const count = clone(); count.PlayerCount++;
  assert.throws(() => validateSnapshot(count), /InvalidSnapshot/);
});
test('control sequences and untyped flags are rejected', () => {
  const name = clone(); name.Players[0].Player = '\u001b[31mname';
  assert.throws(() => validateSnapshot(name), /InvalidSnapshot/);
  const flag = clone(); flag.DataRead = 'true';
  assert.throws(() => validateSnapshot(flag), /InvalidSnapshot/);
});
test('top-level arrays and malformed missing player fields are rejected', () => {
  assert.throws(() => validateSnapshot([clone()]), /InvalidSnapshot/);
  const data = clone(); delete data.Players[0].Status;
  assert.throws(() => validateSnapshot(data), /InvalidSnapshot/);
});
