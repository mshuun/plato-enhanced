const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ hidden = false, deferredContext = false } = {}) {
  const dom = new JSDOM('<!doctype html><body id="page-site-index"><div id="native"><div class="dashboard-container"><p class="dashboard-prompt">Native prompt</p><section class="ongoing-courses"><a class="course-card" href="/course/view.php?id=42"><h5>자료구조 (001)</h5></a></section></div></div></body>', {
    url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, state = { hidden, contextCalls: 0, requests: 0, writes: [], now: Date.parse('2026-11-13T10:00:00+09:00') };
  w.Date.now = () => state.now;
  Object.defineProperty(w.document, 'hidden', { get: () => state.hidden });
  const pending = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
  w.PlatoCalendarExt = { config: { cacheTtlMs: 600000 }, PlatoDataSource: class {
    getContext() { state.contextCalls++; return deferredContext && state.contextCalls === 1 ? pending : Promise.resolve({ userId: '42' }); }
  } };
  state.handler = async () => ({ ok: false });
  w.chrome = { runtime: { sendMessage(_message, callback) { state.requests++; Promise.resolve().then(() => state.handler()).then(callback); } },
    storage: { local: { get(_keys, callback) { callback({}); }, set(value, callback) { state.writes.push(JSON.parse(JSON.stringify(value))); callback(); } } } };
  for (const file of ['class-schedule-model.js', 'class-schedule.js']) w.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  return { ...state, w, state, close: () => w.close(), settled: async () => {
    for (let count = 0; count < 30; count++) { await tick(); if (!w.document.querySelector('.pe-classroom-refresh')?.disabled) return; }
    throw new Error('Timetable did not settle');
  } };
}

test('timetable initialization in a background tab waits for visibility', async () => {
  const h = harness({ hidden: true });
  try {
    await tick();
    assert.equal(h.state.requests, 0);
    assert.equal(h.state.contextCalls, 0);
    h.state.hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
    assert.equal(h.state.requests, 1);
  } finally { h.close(); }
});

test('timetable does not begin its network read after its PLATO pane becomes hidden', async () => {
  const h = harness({ deferredContext: true });
  try {
    assert.equal(h.state.contextCalls, 1);
    h.w.document.getElementById('native').hidden = true;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    h.state.resolve({ userId: '42' }); await tick();
    assert.equal(h.state.requests, 0);
    h.w.document.getElementById('native').hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
    assert.equal(h.state.requests, 1);
  } finally { h.close(); }
});

const timetable = '<div id="ptTable"></div><div class="schedule-info"><h5 class="modal-title">자료구조[001]</h5><dl><dt>강의일자</dt><dd>2026-01-01 ~ 2026-12-31</dd><dt>강의시간</dt><dd>금요일 09:00 ~ 11:00</dd><dt>강의실</dt><dd>Example room</dd></dl></div>';

for (const fail of [false, true]) {
  test(`timetable ${fail ? 'failed' : 'successful'} refresh recovers after a clock rollback`, async () => {
    const h = harness({ hidden: true });
    try {
      h.state.handler = async () => fail ? { ok: false } : { ok: true, html: timetable };
      h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
      h.state.now -= 3600000;
      h.state.handler = async () => ({ ok: true, html: timetable.replace('Example room', 'Fresh room') });
      h.w.dispatchEvent(new h.w.Event('pageshow')); await h.settled();
      assert.equal(h.state.requests, 2);
      assert.match(h.w.document.querySelector('.pe-classroom-body').textContent, /Fresh room/);
      h.w.dispatchEvent(new h.w.Event('pageshow')); await h.settled();
      assert.equal(h.state.requests, 2, 'the refreshed attempt time must stop an immediate retry loop');
    } finally { await tick(); h.close(); }
  });
}

test('a failed old course context cannot delay refreshing a newly mounted course list', async () => {
  const h = harness({ deferredContext: true });
  try {
    const course = h.w.document.querySelector('a.course-card');
    course.href = '/course/view.php?id=43';
    course.querySelector('h5').textContent = '다른 강좌 (002)';
    h.w.dispatchEvent(new h.w.Event('pageshow'));
    h.state.reject(new Error('old context timeout'));
    await h.settled();
    assert.equal(h.state.contextCalls, 2);
    assert.equal(h.state.requests, 1);
  } finally { h.close(); }
});

for (const hide of ['hidden pane', 'hidden tab', 'detached dashboard']) {
  test(`a timetable response for a ${hide} is discarded and refreshes on return`, async () => {
    const h = harness({ hidden: true });
    let finish;
    h.state.handler = () => new Promise(resolve => { finish = resolve; });
    const native = h.w.document.getElementById('native');
    try {
      h.state.hidden = false;
      h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
      await tick();
      assert.equal(h.state.requests, 1);
      if (hide === 'hidden pane') native.hidden = true;
      if (hide === 'hidden tab') h.state.hidden = true;
      if (hide === 'detached dashboard') native.remove();
      finish({ ok: true, html: timetable });
      await tick();
      assert.equal(h.state.writes.length, 0);
      assert.doesNotMatch(native.textContent, /Example room/);
      if (hide === 'detached dashboard') {
        h.state.now += 600000;
        h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
        await tick();
        assert.equal(h.state.requests, 1);
      }
      h.state.handler = async () => ({ ok: true, html: timetable });
      if (hide === 'hidden pane') native.hidden = false;
      if (hide === 'hidden tab') h.state.hidden = false;
      if (hide === 'detached dashboard') h.w.document.body.append(native);
      h.w.dispatchEvent(new h.w.Event('pageshow'));
      h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
      await h.settled();
      assert.equal(h.state.requests, 2);
      assert.equal(h.state.writes.length, 1);
      assert.match(h.w.document.querySelector('.pe-classroom-body').textContent, /Example room/);
      assert.equal(h.w.document.querySelector('.pe-classroom-enter').href, 'https://plato.pusan.ac.kr/course/view.php?id=42');
    } finally { if (finish) finish({ ok: false }); h.close(); }
  });
}

test('timetable remount events respect the retry interval while manual refresh bypasses it', async () => {
  const h = harness();
  try {
    await h.settled();
    assert.equal(h.state.requests, 1);
    for (let index = 0; index < 5; index++) h.w.dispatchEvent(new h.w.Event('pageshow'));
    await h.settled();
    assert.equal(h.state.requests, 1);
    h.state.now += 600000;
    h.w.dispatchEvent(new h.w.Event('pageshow'));
    await h.settled();
    assert.equal(h.state.requests, 2);
    h.w.document.querySelector('.pe-classroom-refresh').click();
    await h.settled();
    assert.equal(h.state.requests, 3);
  } finally { h.close(); }
});

for (const outcome of ['success', 'error', 'outside focus']) {
  test(`timetable refresh preserves the keyboard target with ${outcome}`, async () => {
    const h = harness({ hidden: true }); let finish;
    try {
      h.state.handler = async () => ({ ok: true, html: timetable });
      h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
      const link = h.w.document.querySelector('.pe-classroom-enter'); link.focus();
      h.state.handler = () => new Promise(resolve => { finish = resolve; });
      h.state.now += 600000; h.w.dispatchEvent(new h.w.Event('pageshow')); await tick();
      assert.equal(h.w.document.activeElement?.href, link.href, 'starting a refresh must retain course-link focus');
      const input = h.w.document.createElement('input'); h.w.document.body.append(input);
      if (outcome === 'outside focus') input.focus();
      finish(outcome === 'error' ? { ok: false } : { ok: true, html: timetable }); await h.settled();
      if (outcome === 'outside focus') assert.equal(h.w.document.activeElement, input);
      else assert.equal(h.w.document.activeElement?.href, link.href);
    } finally { finish?.({ ok: false }); await tick(); h.close(); }
  });
}

test('a timetable meeting disappearing at a time boundary returns focus to its section heading', async () => {
  const h = harness({ hidden: true });
  try {
    h.state.handler = async () => ({ ok: true, html: timetable });
    h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
    h.w.document.querySelector('.pe-classroom-enter').focus();
    h.state.now = Date.parse('2027-01-01T10:00:00+09:00');
    h.state.hidden = true;
    // A visible clock update can remove the expired meeting before any fetch.
    h.w.dispatchEvent(new h.w.Event('pageshow'));
    assert.equal(h.w.document.activeElement.tagName, 'BODY', 'a hidden timetable must not take focus');
    h.state.now = Date.parse('2026-11-13T10:00:00+09:00');
    h.state.hidden = false; h.w.dispatchEvent(new h.w.Event('pageshow')); await h.settled();
    h.w.document.querySelector('.pe-classroom-enter').focus();
    h.state.now = Date.parse('2027-01-01T10:00:00+09:00');
    h.w.dispatchEvent(new h.w.Event('pageshow'));
    assert.equal(h.w.document.activeElement.id, 'pe-classroom-title');
    await h.settled();
  } finally { await tick(); h.close(); }
});

test('timetable focus follows the same meeting when several meetings share a course URL', async () => {
  const h = harness({ hidden: true });
  const second = timetable.replace('09:00 ~ 11:00', '09:30 ~ 10:30').replace('Example room', 'Second room');
  const added = timetable.replace('09:00 ~ 11:00', '08:00 ~ 10:45').replace('Example room', 'New first room');
  try {
    h.state.handler = async () => ({ ok: true, html: timetable + second });
    h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
    h.w.document.querySelectorAll('.pe-classroom-enter')[1].focus();
    h.state.handler = async () => ({ ok: true, html: added + timetable + second });
    h.state.now += 600000; h.w.dispatchEvent(new h.w.Event('pageshow')); await h.settled();
    assert.equal(h.w.document.querySelectorAll('.pe-classroom-enter').length, 3);
    assert.match(h.w.document.activeElement.closest('article').textContent, /09:30–10:30 · Second room/);
  } finally { await tick(); h.close(); }
});

test('a removed selected meeting does not move focus into another meeting of the same course', async () => {
  const h = harness({ hidden: true });
  const second = timetable.replace('09:00 ~ 11:00', '09:30 ~ 10:30').replace('Example room', 'Second room');
  try {
    h.state.handler = async () => ({ ok: true, html: timetable + second });
    h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
    h.w.document.querySelectorAll('.pe-classroom-enter')[1].focus();
    h.state.handler = async () => ({ ok: true, html: timetable });
    h.state.now += 600000; h.w.dispatchEvent(new h.w.Event('pageshow')); await h.settled();
    assert.equal(h.w.document.querySelectorAll('.pe-classroom-enter').length, 1);
    assert.equal(h.w.document.activeElement.id, 'pe-classroom-title');
  } finally { await tick(); h.close(); }
});

for (const outcome of ['success', 'error', 'outside focus']) {
  test(`keyboard timetable refresh restores its button after ${outcome}`, async () => {
    const h = harness({ hidden: true }); let finish;
    try {
      h.state.handler = async () => ({ ok: true, html: timetable });
      h.state.hidden = false; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await h.settled();
      const button = h.w.document.querySelector('.pe-classroom-refresh'); button.focus();
      h.state.handler = () => new Promise(resolve => { finish = resolve; });
      button.click(); await tick();
      assert.equal(h.w.document.activeElement, h.w.document.querySelector('.pe-classroom-note'));
      const input = h.w.document.createElement('input'); h.w.document.body.append(input);
      if (outcome === 'outside focus') input.focus();
      finish(outcome === 'error' ? { ok: false } : { ok: true, html: timetable }); await h.settled();
      assert.equal(h.w.document.activeElement, outcome === 'outside focus' ? input : button);
    } finally { finish?.({ ok: false }); await tick(); h.close(); }
  });
}
