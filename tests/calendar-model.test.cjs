const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function environment() {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); let constructions = 0, failures = 0;
  dom.window.Intl.DateTimeFormat = new Proxy(dom.window.Intl.DateTimeFormat, {
    construct(target, args) { constructions++; try { return Reflect.construct(target, args); } catch (error) { failures++; throw error; } }
  });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../src/calendar-model.js'), 'utf8'));
  return { w: dom.window, model: dom.window.PlatoCalendarExt.calendarModel, count: () => constructions, failures: () => failures, close: () => dom.window.close() };
}
const timestamp = Date.parse('2026-11-13T01:00:00+09:00') / 1000;
const deadlineOptions = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' };

test('large calendar formatting reuses three formatters and follows timezone changes', () => {
  const h = environment(); h.w.Date.now = () => timestamp * 1000;
  try {
    for (const [index, timezone] of ['Asia/Seoul', 'UTC', 'America/New_York'].entries()) {
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000));
      const time = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000));
      const deadline = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, ...deadlineOptions }).format(new Date(timestamp * 1000));
      const grid = h.model.getMonthGrid(2026, 11, timezone);
      assert.equal(grid.length, 42); assert.equal(grid.filter(item => item.isToday)[0].key, day);
      assert.equal(h.model.groupActivitiesByDay(Array.from({ length: 200 }, () => ({ deadline: timestamp })), timezone).get(day).length, 200);
      for (let i = 0; i < 200; i++) {
        assert.equal(h.model.formatTime(timestamp, timezone), time);
        assert.equal(h.model.formatDeadline(timestamp, timezone), deadline);
      }
      assert.equal(h.count(), (index + 1) * 3);
    }
  } finally { h.close(); }
});

test('invalid timezones retain local formatting without repeated constructor failures', () => {
  const h = environment(), date = new Date(timestamp * 1000);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date);
  const deadline = new Intl.DateTimeFormat('ko-KR', deadlineOptions).format(date);
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal(h.model.dayKeyFromTimestamp(timestamp, 'Invalid/Timezone'), day);
      assert.equal(h.model.formatTime(timestamp, 'Invalid/Timezone'), time);
      assert.equal(h.model.formatDeadline(timestamp, 'Invalid/Timezone'), deadline);
    }
    assert.equal(h.failures(), 3);
  } finally { h.close(); }
});

test('browser-timezone fallback stays live when the host timezone changes without reloading', () => {
  const h = environment(), native = h.w.Intl.DateTimeFormat; let hostZone = 'UTC';
  h.w.Intl.DateTimeFormat = new Proxy(native, { construct(target, [locale, options]) {
    return Reflect.construct(target, [locale, options?.timeZone ? options : { ...options, timeZone: hostZone }]);
  } });
  try {
    for (const timezone of [undefined, 'Invalid/Timezone']) {
      hostZone = 'UTC'; const first = h.model.formatTime(timestamp, timezone);
      hostZone = 'Asia/Seoul'; const second = h.model.formatTime(timestamp, timezone);
      assert.notEqual(first, second);
      assert.equal(second, new Intl.DateTimeFormat('ko-KR', { timeZone: hostZone, hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000)));
    }
  } finally { h.close(); }
});

test('a calendar grid uses one today snapshot even when the clock crosses midnight during rendering', () => {
  const h = environment(); let reads = 0;
  h.w.Date.now = () => Date.parse(++reads === 1 ? '2026-11-12T23:59:59+09:00' : '2026-11-13T00:00:00+09:00');
  try {
    const today = h.model.getMonthGrid(2026, 11, 'Asia/Seoul').filter(item => item.isToday);
    assert.deepEqual(Array.from(today, item => item.key), ['2026-11-12']);
    assert.equal(reads, 1);
  } finally { h.close(); }
});
