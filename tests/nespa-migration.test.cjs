const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('upgrades remove only retired NESPA credentials and retain calendar settings and data', async () => {
  const key = 'platoEnhanced.nespa.settings';
  const local = { [key]: { enabled: false, courseUrl: 'https://emerald.pusan.ac.kr/ds2027/', courseName: '새 강좌', courseYear: 2027, autoLogin: true },
    'platoEnhanced.nespa.authState': { paused: true }, 'platoEnhanced.nespa.epoch': { reason: 'logout' },
    'platoCalendarExt.manualCompletions': { me: { 'calendar:1': true } }, 'platoEnhanced.nespa.catalog.v1.ds2027.2027': { assignments: [] } };
  const session = { 'platoEnhanced.nespa.authJob': {}, 'platoEnhanced.nespa.authAttempts': {}, 'platoEnhanced.nespa.loginVisits': {}, unrelated: true };
  const deleted = [];
  const area = data => ({ async get(key) { return { [key]: data[key] }; }, async set(patch) { Object.assign(data, patch); }, async remove(keys) { keys.forEach(key => delete data[key]); } });
  const context = vm.createContext({ URL, chrome: { storage: { local: area(local), session: area(session) } }, indexedDB: {
    deleteDatabase(name) { deleted.push(name); const request = {}; queueMicrotask(() => request.onsuccess()); return request; }
  } });
  for (const file of ['nespa-settings.js', 'nespa-migration.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  await context.PlatoCalendarExt.cleanupLegacyNespa();
  assert.deepEqual(JSON.parse(JSON.stringify(local[key])), { enabled: false, courseUrl: 'https://emerald.pusan.ac.kr/ds2027/', courseName: '새 강좌', courseYear: 2027 });
  assert.ok(local['platoCalendarExt.manualCompletions']);
  assert.ok(local['platoEnhanced.nespa.catalog.v1.ds2027.2027']);
  assert.equal(local['platoEnhanced.nespa.authState'], undefined);
  assert.equal(local['platoEnhanced.nespa.epoch'], undefined);
  assert.deepEqual(session, { unrelated: true });
  assert.deepEqual(deleted, ['platoEnhancedNespaSecrets']);
  await context.PlatoCalendarExt.cleanupLegacyNespa();
  assert.deepEqual(session, { unrelated: true });
});
