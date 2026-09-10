import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const interval = 600000;
const start = Date.parse('2026-09-10T09:00:00+09:00');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function calendar() {
  const dom = new JSDOM('<body><div id="anchor"></div></body>', {
    url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  for (const name of ['config', 'plato-parser', 'submission-parser', 'calendar-model', 'activity-modal', 'calendar-view']) {
    w.eval(await readFile(new URL(`src/${name}.js`, root), 'utf8'));
  }
  let now = start, nextTimer = 0, calls = 0, fail = false, delay = 0, manual = {};
  const timers = new Map(), intervals = new Map();
  w.Date.now = () => now;
  w.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.setInterval = (fn, ms) => { intervals.set(ms, fn); return ms; };
  w.clearInterval = id => intervals.delete(id);
  const ns = w.PlatoCalendarExt;
  ns.storage = {
    getCollapsed: async () => false, setCollapsed: async () => {}, subscribe: () => () => {},
    getManualCompletions: async () => ({ ...manual }),
    setManualCompletion: async (_scope, id, completed) => { manual[id] = completed; }
  };
  ns.PlatoDataSource = class {
    async getContext() { return { timezone: 'Asia/Seoul' }; }
    async getMonth() {
      calls++;
      now += delay;
      if (fail) throw new Error('offline');
      return { activities: [], timezone: 'Asia/Seoul', userScope: '7', fetchedAt: now };
    }
    updateActivity() {}
    destroy() {}
  };
  const view = new ns.CalendarView();
  await view.mount(w.document.getElementById('anchor'));
  await settle();
  return {
    w, view, timers, intervals,
    get now() { return now; }, set now(value) { now = value; },
    get calls() { return calls; }, set fail(value) { fail = value; }, set delay(value) { delay = value; },
    async runDue() {
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        await timer.fn();
      }
      await settle();
    },
    close() { view.destroy(); w.close(); }
  };
}

test('calendar waits ten minutes on timer, tab return and expansion; manual refresh resets the deadline', async () => {
  const c = await calendar();
  try {
    assert.equal(c.calls, 1);
    c.now = start + interval - 1;
    c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));
    c.intervals.get(60000)();
    await c.view.toggleCollapsed();
    await c.view.toggleCollapsed();
    await c.runDue();
    assert.equal(c.calls, 1);
    c.now++;
    await c.runDue();
    assert.equal(c.calls, 2);

    c.now += 120000;
    c.view.refreshButton.click();
    await settle();
    assert.equal(c.calls, 3);
    const manualUpdatedAt = c.now;
    c.now = start + interval * 2;
    c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));
    await c.runDue();
    assert.equal(c.calls, 3);
    c.now = manualUpdatedAt + interval;
    await c.runDue();
    assert.equal(c.calls, 4);
  } finally { c.close(); }
});

test('local completion changes postpone auto refresh, but cached activity reads do not', async () => {
  const c = await calendar();
  try {
    c.now += 300000;
    await c.view.toggleManual({ id: 'activity-1' }, true);
    const changedAt = c.now;
    c.now = start + interval;
    await c.view.autoRefresh();
    assert.equal(c.calls, 1);
    c.now = changedAt + interval - 1;
    c.view.updateActivity({ id: 'activity-1' }, start);
    await c.runDue();
    assert.equal(c.calls, 1);
    c.now++;
    await c.runDue();
    assert.equal(c.calls, 2);
  } finally { c.close(); }
});

test('automatic refresh waits for visibility, dialogs and in-flight status checks', async () => {
  const c = await calendar();
  try {
    c.now += interval;
    Object.defineProperty(c.w.document, 'hidden', { configurable: true, value: true });
    await c.runDue();
    assert.equal(c.calls, 1);
    Object.defineProperty(c.w.document, 'hidden', { configurable: true, value: false });
    c.view.modal.overlay.hidden = false;
    await c.view.autoRefresh();
    assert.equal(c.calls, 1);
    c.view.modal.overlay.hidden = true;
    c.view.checkingSubmissions = true;
    await c.view.autoRefresh();
    assert.equal(c.calls, 1);
    c.view.checkingSubmissions = false;
    c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));
    c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));
    await settle();
    assert.equal(c.calls, 2);
  } finally { c.close(); }
});

test('refresh timing starts when a slow update finishes and failed requests wait ten minutes before retry', async () => {
  const c = await calendar();
  try {
    c.delay = 12000;
    c.now += interval;
    await c.runDue();
    assert.equal(c.calls, 2);
    c.now = start + interval * 2;
    await c.view.autoRefresh();
    assert.equal(c.calls, 2);
    c.now += 12000;
    c.delay = 0;
    c.fail = true;
    await c.runDue();
    assert.equal(c.calls, 3);
    c.now += interval - 1;
    await c.view.autoRefresh();
    assert.equal(c.calls, 3);
    c.now++;
    await c.runDue();
    assert.equal(c.calls, 4);
    c.close();
    assert.equal(c.timers.size, 0);
  } finally { c.close(); }
});
