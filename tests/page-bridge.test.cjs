const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const events = (start, count) => Array.from({ length: count }, (_, index) => ({ id: start + index, submitted: true }));

function harness() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only' });
  const w = dom.window, state = { timers: new Map(), calls: [], nextTimer: 0 };
  state.window = w;
  w.M = { cfg: { userId: '42', usertimezone: 'Asia/Seoul' } };
  w.setTimeout = (callback, delay) => { const id = ++state.nextTimer; state.timers.set(id, { callback, delay }); return id; };
  w.clearTimeout = id => state.timers.delete(id);
  state.month = async () => ({ events: [] });
  state.actions = async () => ({ events: [] });
  w.require = (names, resolve) => resolve(names[0] === 'core_calendar/repository'
    ? { getCalendarMonthData: (...args) => state.month(...args) }
    : { queryByTime: args => { state.calls.push(args); return state.actions(args); } });
  w.eval(fs.readFileSync(path.join(__dirname, '../src/page-bridge.js'), 'utf8'));
  state.send = () => new Promise(resolve => {
    w.document.addEventListener('plato-calendar-ext:response:v1', event => resolve(JSON.parse(event.detail)), { once: true });
    w.document.dispatchEvent(new w.CustomEvent('plato-calendar-ext:request:v1', { detail: JSON.stringify({ requestId: 'month-test', operation: 'month', year: 2026, month: 11 }) }));
  });
  state.expire = () => {
    const timer = [...state.timers.values()].find(task => task.delay === 4000);
    assert.ok(timer, 'action deadline must exist'); timer.callback();
  };
  state.close = () => w.close();
  return state;
}

test('the PLATO bridge collects every successful action page and clears its deadline', async () => {
  const h = harness();
  h.actions = async args => ({ events: args.aftereventid ? events(51, 1) : events(1, 50) });
  try {
    const result = await h.send();
    assert.equal(result.ok, true);
    assert.equal(result.payload.action.complete, true);
    assert.equal(result.payload.action.events.length, 51);
    assert.equal(h.calls[1].aftereventid, 50);
    assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});

test('a malformed action response is partial instead of a verified empty list', async () => {
  for (const response of [null, {}, { events: null }, { events: [null] }]) {
    const h = harness(); h.actions = async () => response;
    try {
      const result = await h.send();
      assert.equal(result.ok, true);
      assert.equal(result.payload.action.complete, false);
      assert.deepEqual(result.payload.action.events, []);
    } finally { h.close(); }
  }
});

test('a later action-page failure preserves earlier received data as partial', async () => {
  const h = harness();
  h.actions = async args => { if (args.aftereventid) throw new Error('page failed'); return { events: events(1, 50) }; };
  try {
    const result = await h.send();
    assert.equal(result.payload.action.complete, false);
    assert.equal(result.payload.action.events.length, 50);
    assert.equal(result.payload.action.events[0].submitted, true);
    assert.equal(h.calls.length, 2);
  } finally { h.close(); }
});

test('an action deadline retains received pages and ignores late data without requesting another page', async () => {
  const h = harness(), late = deferred();
  h.actions = async args => args.aftereventid ? late.promise : { events: events(1, 50) };
  try {
    const pending = h.send(); await tick();
    h.expire();
    const result = await pending;
    assert.equal(result.payload.action.complete, false);
    assert.equal(result.payload.action.events.length, 50);
    late.resolve({ events: events(51, 50) }); await tick();
    assert.equal(h.calls.length, 2);
    assert.equal(result.payload.action.events.length, 50);
    assert.equal(h.timers.size, 0);
  } finally { late.resolve({ events: [] }); h.close(); }
});

test('a failed month stops further action pagination and releases the action deadline', async () => {
  const h = harness(), month = deferred(), action = deferred();
  h.month = () => month.promise;
  h.actions = async args => args.aftereventid ? action.promise : { events: events(1, 50) };
  try {
    const pending = h.send(); await tick();
    month.reject(new Error('month failed'));
    assert.equal((await pending).ok, false);
    action.resolve({ events: events(51, 50) }); await tick();
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 0);
  } finally { month.resolve({}); action.resolve({ events: [] }); h.close(); }
});

test('a missing month payload cannot become a successful empty calendar', async () => {
  const h = harness(); h.month = async () => null;
  try { assert.equal((await h.send()).ok, false); }
  finally { h.close(); }
});

test('a malformed later page retains earlier verified actions and stays partial', async () => {
  const h = harness();
  h.actions = async args => args.aftereventid ? { events: [null] } : { events: events(1, 50) };
  try {
    const result = await h.send();
    assert.equal(result.payload.action.complete, false);
    assert.equal(result.payload.action.events.length, 50);
    assert.equal(h.calls.length, 2);
  } finally { h.close(); }
});

test('month failure also cancels the pending AMD retry and its deadline', async () => {
  const h = harness(), month = deferred();
  h.month = () => { h.window.require = undefined; return month.promise; };
  try {
    const pending = h.send(); await tick();
    assert.ok([...h.timers.values()].some(timer => timer.delay === 100));
    month.reject(new Error('month failed'));
    assert.equal((await pending).ok, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls.length, 0);
  } finally { month.resolve({}); h.close(); }
});
