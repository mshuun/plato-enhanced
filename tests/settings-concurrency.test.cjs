const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const key = 'platoEnhanced.nespa.settings';

function harness() {
  const local = {}, locks = new Map();
  const chrome = { storage: { local: {
    async get(name) { return { [name]: structuredClone(local[name]) }; },
    async set(values) { Object.assign(local, structuredClone(values)); }
  }, onChanged: { addListener() {}, removeListener() {} } } };
  const navigator = { locks: { request(name, task) {
    const pending = (locks.get(name) || Promise.resolve()).then(task);
    locks.set(name, pending.catch(() => {}));
    return pending;
  } } };
  function create() {
    const context = vm.createContext({ chrome, navigator, URL });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/nespa-settings.js'), 'utf8'), context);
    return context.PlatoCalendarExt.nespaSettings;
  }
  return { local, create };
}

test('independent settings contexts serialize concurrent patches without losing another field', async () => {
  const h = harness(), first = h.create(), second = h.create();
  await Promise.all([first.save({ courseName: '다른 창의 새 강좌명' }), second.save({ enabled: false })]);
  assert.equal(h.local[key].courseName, '다른 창의 새 강좌명');
  assert.equal(h.local[key].enabled, false);
});

test('a stale edit to the same setting is rejected with current values and no write', async () => {
  const h = harness(), first = h.create(), second = h.create();
  const baseline = await second.get();
  await first.save({ courseName: '먼저 저장한 강좌명' });
  await assert.rejects(second.save({ courseName: '오래된 창의 강좌명' }, baseline), error =>
    error.code === 'NESPA_SETTINGS_CONFLICT' && error.settings.courseName === '먼저 저장한 강좌명');
  assert.equal(h.local[key].courseName, '먼저 저장한 강좌명');
});

test('nonconflicting stale patches merge but conflicts do not poison the next save', async () => {
  const h = harness(), first = h.create(), second = h.create();
  const baseline = await second.get();
  await first.save({ courseName: '새 강좌명' });
  await second.save({ enabled: false }, baseline);
  assert.equal(h.local[key].courseName, '새 강좌명');
  assert.equal(h.local[key].enabled, false);
  await assert.rejects(second.save({ courseName: '입력 중인 강좌명' }, baseline));
  const latest = await second.get();
  await second.save({ courseName: '확인 후 저장한 강좌명' }, latest);
  assert.equal(h.local[key].courseName, '확인 후 저장한 강좌명');
  assert.equal(h.local[key].enabled, false);
});
