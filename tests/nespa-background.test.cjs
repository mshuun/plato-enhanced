const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = 'https://emerald.pusan.ac.kr/ds2026/';
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(initial = {}) {
  const local = { ...initial };
  const listeners = [];
  const requests = [];
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, url: 'https://plato.pusan.ac.kr/' };
  const chrome = {
    runtime: { id: 'extension', onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: { local: {
      async get(key) { return { [key]: local[key] }; },
      async set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) { changes[key] = { oldValue: local[key], newValue: value }; local[key] = value; }
        for (const fn of changed) fn(changes, 'local');
      }
    }, onChanged: { addListener(fn) { changed.push(fn); } } }
  };
  const changed = [];
  let handler = async url => ({ ok: true, status: 200, url, text: async () => '<a id="sidebar_logout"></a><table>Problem End Date</table>' });
  const context = vm.createContext({ chrome, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => { requests.push({ url, init }); return handler(url, init); } });
  for (const file of ['nespa-settings.js', 'nespa-background.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  const send = (message, from = sender) => new Promise((resolve, reject) => {
    try { for (const fn of listeners) if (fn(message, from, resolve)) return; resolve(undefined); } catch (error) { reject(error); }
  });
  return { api: context.PlatoCalendarExt.nespaSettings, local, requests, sender, send,
    setHandler(fn) { handler = fn; } };
}

test('calendar collection performs fixed read-only GETs with the existing session', async () => {
  const h = harness({ 'platoEnhanced.nespa.authState': { paused: true, blocked: true } });
  assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' })).ok, true);
  assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001', url: 'https://other.example/', method: 'POST' })).ok, true);
  assert.deepEqual(h.requests.map(item => item.url), [base + 'assignment_list/', base + 'submission_detail/?prob_id=001']);
  for (const { init } of h.requests) {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'include');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
  }
});

test('detail reads preserve every digit of problem IDs accepted by the assignment parser', async () => {
  const h = harness();
  for (const problemId of ['00000000001', '0012345678901234567890123456789012345678'.padEnd(40, '0')]) {
    const result = await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId });
    assert.equal(result.ok, true, problemId);
    assert.equal(h.requests.at(-1).url, base + 'submission_detail/?prob_id=' + problemId);
  }
  const requests = h.requests.length;
  for (const problemId of ['1'.repeat(41), '', '-1', '1e10', '1&other=2']) {
    assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId })).ok, false);
  }
  assert.equal(h.requests.length, requests);
});

test('calendar settings accept only a NESPA course URL and discard retired login options', async () => {
  const h = harness();
  for (const courseUrl of ['https://other.example/ds2026/', 'https://user:pass@emerald.pusan.ac.kr/ds2026/', base + 'login/', base + '?next=other']) {
    await assert.rejects(h.api.save({ courseUrl }));
  }
  const saved = await h.api.save({ courseUrl: 'https://emerald.pusan.ac.kr/ds2027', courseYear: 2027, autoLogin: true });
  assert.equal(saved.courseUrl, 'https://emerald.pusan.ac.kr/ds2027/');
  assert.equal(Object.hasOwn(saved, 'autoLogin'), false);
});

test('invalid calendar settings cannot silently replace saved values with defaults', async () => {
  const h = harness();
  await h.api.save({ courseUrl: 'https://emerald.pusan.ac.kr/ds2027/', courseName: '새 강좌', courseYear: 2027 });
  const saved = JSON.stringify(h.local);
  for (const patch of [{ courseName: '   ' }, { courseName: 'x'.repeat(61) }, { courseYear: 1999 }, { courseYear: 2101 },
    { courseYear: '' }, { courseYear: 2027.5 }, { courseYear: null }, { enabled: 'false' }, { enabled: 0 }]) {
    await assert.rejects(h.api.save(patch));
    assert.equal(JSON.stringify(h.local), saved);
  }
  assert.equal((await h.api.get()).courseName, '새 강좌');
  assert.equal((await h.api.get()).courseYear, 2027);
});

test('login, credential and removed board commands have no handler', async () => {
  const h = harness();
  for (const type of ['PE_NESPA_LOGIN_READY', 'PE_NESPA_LOGIN_COMMIT', 'PE_NESPA_AUTH_SAVE', 'PE_NESPA_AUTH_RETRY', 'PE_NESPA_AUTH_STATUS', 'PE_NESPA_LOGOUT', 'PE_OPEN_OPTIONS']) {
    assert.equal(await h.send({ type }), undefined);
  }
  for (const resource of ['board-list', 'board-detail', 'submissions']) assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource })).ok, false);
  assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '13&other=1' })).ok, false);
  assert.equal(h.requests.length, 0);
});

test('NESPA pages, subframes and unrelated origins cannot initiate collection', async () => {
  const h = harness();
  for (const patch of [{ url: base + 'assignment_list/' }, { url: 'https://other.example/' }, { frameId: 1 }, { id: 'other' }, { url: 'https://plato.pusan.ac.kr/course/view.php?id=1' }]) {
    assert.equal(await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' }, { ...h.sender, ...patch }), undefined);
  }
  assert.equal(h.requests.length, 0);
});

test('expired sessions return a manual-login message without opening tabs or submitting forms', async () => {
  const h = harness();
  for (const result of [
    { ok: false, status: 401, url: base + 'assignment_list/' },
    { ok: true, status: 200, url: base + 'login/', text: async () => '<input type="password" id="sidebar_login">' }
  ]) {
    h.setHandler(async () => result);
    const response = await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' });
    assert.equal(response.error, 'auth-required');
    assert.match(response.message, /직접 로그인/);
    assert.equal(response.html, undefined);
  }
  assert.equal(h.requests.length, 2);
});

test('concurrent reads share a request, but OFF then ON discards the previous result', async () => {
  const h = harness();
  let finish;
  h.setHandler(url => new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, url, text: async () => 'old' }); }));
  const first = h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' });
  const same = h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' });
  await tick();
  assert.equal(h.requests.length, 1);
  await h.api.save({ enabled: false });
  await h.api.save({ enabled: true });
  h.setHandler(async url => ({ ok: true, status: 200, url, text: async () => 'fresh' }));
  const fresh = await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' });
  finish();
  assert.equal(fresh.html, 'fresh');
  assert.equal((await first).ok, false);
  assert.equal((await same).ok, false);
  assert.equal(h.requests.length, 2);
});

for (const oldResult of ['success', 'authentication failure']) {
  test(`observed expiry detaches a pending read before retry, and its late ${oldResult} cannot replace recovery`, async () => {
    const h = harness(); let finish;
    h.setHandler(url => new Promise(resolve => { finish = () => resolve({ ok: oldResult === 'success', status: oldResult === 'success' ? 200 : 401,
      url, text: async () => 'old private state' }); }));
    const old = h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' });
    await tick();
    try {
      h.setHandler(async url => ({ ok: false, status: 401, url }));
      assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '13' })).error, 'auth-required');
      h.setHandler(async url => ({ ok: true, status: 200, url, text: async () => 'fresh private state' }));
      let completed = false;
      const retry = h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' }).then(result => { completed = true; return result; });
      await tick();
      assert.equal(completed, true, 'retry must not join the request started before observed expiry');
      assert.equal(h.requests[0].init.signal.aborted, true);
      assert.equal((await retry).html, 'fresh private state');
      finish();
      assert.equal((await old).error, 'auth-required');
      assert.equal((await old).html, undefined);
      assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' })).html, 'fresh private state');
    } finally { finish?.(); await old; }
  });
}

for (const lateResult of ['success', 'authentication failure']) {
  test(`a late pre-expiry ${lateResult} cannot abort a still-running recovered request`, async () => {
    const h = harness(); let finishOld, finishFresh;
    h.setHandler(url => new Promise(resolve => { finishOld = () => resolve({ ok: lateResult === 'success', status: lateResult === 'success' ? 200 : 401,
      url, text: async () => 'old' }); }));
    const old = h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' });
    await tick();
    try {
      h.setHandler(async url => ({ ok: false, status: 401, url }));
      assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '13' })).error, 'auth-required');
      h.setHandler(url => new Promise(resolve => { finishFresh = () => resolve({ ok: true, status: 200, url, text: async () => 'fresh' }); }));
      const fresh = h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' });
      await tick();
      finishOld(); assert.equal((await old).html, undefined);
      assert.equal(h.requests.at(-1).init.signal.aborted, false);
      finishFresh(); assert.equal((await fresh).html, 'fresh');
    } finally { finishOld?.(); finishFresh?.(); await old; }
  });
}

test('disabling integration aborts active reads and later reads use a new request', async () => {
  const h = harness();
  h.setHandler((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' });
  const detail = h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '001' });
  await tick();
  try {
    await h.api.save({ enabled: false });
    assert.ok(h.requests.every(request => request.init.signal.aborted));
    assert.equal((await pending).error, 'disabled');
    assert.equal((await detail).error, 'disabled');
    await h.api.save({ enabled: true });
    h.setHandler(async url => ({ ok: true, status: 200, url, text: async () => 'fresh' }));
    assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' })).html, 'fresh');
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests.at(-1).init.signal.aborted, false);
  } finally {
    // Release the mock fetch even when the regression assertion fails.
    for (const request of h.requests) request.init.signal.dispatchEvent(new Event('abort'));
    await Promise.all([pending, detail]);
  }
});

test('disabled integration and unexpected response routes never return assignment data', async () => {
  const h = harness();
  await h.api.save({ enabled: false });
  assert.equal((await h.send({ type: 'PE_NESPA_FETCH', resource: 'assignments' })).error, 'disabled');
  assert.equal(h.requests.length, 0);
  await h.api.save({ enabled: true });
  for (const url of ['https://other.example/', base + 'submission_detail/?prob_id=14']) {
    h.setHandler(async () => ({ ok: true, status: 200, url, text: async () => 'wrong assignment' }));
    const result = await h.send({ type: 'PE_NESPA_FETCH', resource: 'detail', problemId: '13' });
    assert.equal(result.ok, false);
    assert.equal(result.html, undefined);
  }
});
