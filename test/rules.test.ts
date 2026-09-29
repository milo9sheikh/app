import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMac, isLocallyAdministeredMac } from '../src/shared/mac.ts';
import { localDate, zonedToUtc } from '../src/shared/time.ts';
import { calculateAttendance, earliest } from '../src/shared/attendance-rules.ts';
import { backoffSeconds } from '../src/services/sync.ts';

const cutoff = zonedToUtc('2026-09-29', '09:15', 'Asia/Dhaka');
const start = zonedToUtc('2026-09-29', '09:00', 'Asia/Dhaka');
const strict = { mode: 'STRICT' as const, startAt: start, cutoffAt: cutoff, graceMinutes: 0 };
const at = (t: string) => zonedToUtc('2026-09-29', t, 'Asia/Dhaka');

test('STRICT: before, exactly at, after cutoff and never seen', () => {
  assert.equal(calculateAttendance(at('08:57'), strict), 'PRESENT');
  assert.equal(calculateAttendance(at('09:15:00'), strict), 'PRESENT');
  assert.equal(calculateAttendance(at('09:15:01'), strict), 'ABSENT');
  assert.equal(calculateAttendance(null, strict), 'ABSENT');
});
test('LATE and GRACE modes', () => {
  const late = { ...strict, mode: 'LATE' as const };
  assert.equal(calculateAttendance(at('09:00'), late), 'PRESENT');
  assert.equal(calculateAttendance(at('09:10'), late), 'LATE');
  assert.equal(calculateAttendance(at('09:20'), late), 'ABSENT');
  const grace = { ...strict, mode: 'GRACE' as const, graceMinutes: 5 };
  assert.equal(calculateAttendance(at('09:05'), grace), 'PRESENT');
  assert.equal(calculateAttendance(at('09:06'), grace), 'ABSENT');
});
test('earliest sighting wins', () => {
  assert.equal(earliest(at('09:14'), at('09:01'))!.getTime(), at('09:01').getTime());
  assert.equal(earliest(null, at('09:01'))!.getTime(), at('09:01').getTime());
});
test('MAC normalization gives one canonical form', () => {
  for (const m of ['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff', 'AABBCCDDEEFF', 'aabb.ccdd.eeff']) assert.equal(normalizeMac(m), 'AA:BB:CC:DD:EE:FF');
  for (const bad of ['', 'AA:BB', 'ZZ:BB:CC:DD:EE:FF', null, 42]) assert.equal(normalizeMac(bad), null);
  assert.equal(isLocallyAdministeredMac('02:00:00:00:00:00'), true);
  assert.equal(isLocallyAdministeredMac('AC:00:00:00:00:00'), false);
});
test('Asia/Dhaka cutoff is 03:15Z regardless of server timezone', () => {
  assert.equal(cutoff.toISOString(), '2026-09-29T03:15:00.000Z');
  assert.equal(localDate(new Date('2026-09-28T19:00:00Z'), 'Asia/Dhaka'), '2026-09-29'); // 01:00 next day in Dhaka
  assert.equal(localDate(new Date('2026-09-29T17:59:00Z'), 'Asia/Dhaka'), '2026-09-29');
});
test('DST zones convert correctly', () => {
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-01-01', '09:00', 'America/New_York').toISOString(), '2026-01-01T14:00:00.000Z');
});
test('backoff: retry at interval twice, then exponential up to the maximum', () => {
  const seq = [1, 2, 3, 4, 5, 6, 7].map((f) => backoffSeconds(15, f, 120));
  assert.deepEqual(seq, [15, 15, 30, 60, 120, 120, 120]);
});
