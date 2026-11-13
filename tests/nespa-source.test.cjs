const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const assignmentHtml = fixture('nespa-assignments.html');
const completeHtml = fixture('nespa-submission-complete.html');
const emptyHtml = fixture('nespa-submission-empty.html');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const state = { settings: { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 },
    stored: {}, requests: [], settingsListeners: new Set(), storageListeners: new Set(), active: 0, maximum: 0 };
  state.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : request.problemId === '001' ? completeHtml : emptyHtml });
  dom.window.chrome = {
    runtime: { lastError: undefined, sendMessage(request, callback) {
      state.requests.push(request);
      if (request.resource === 'detail') { state.active += 1; state.maximum = Math.max(state.maximum, state.active); }
      Promise.resolve().then(() => state.handler(request)).then(result => {
        if (request.resource === 'detail') state.active -= 1;
        callback(result);
      });
    } },
    storage: {
      local: { get(keys, callback) { queueMicrotask(() => callback(Object.fromEntries(keys.map(key => [key, state.stored[key]])))); },
        set(values, callback) { Object.assign(state.stored, JSON.parse(JSON.stringify(values))); queueMicrotask(callback); } },
      onChanged: { addListener(listener) { state.storageListeners.add(listener); }, removeListener(listener) { state.storageListeners.delete(listener); } }
    }
  };
  dom.window.PlatoCalendarExt = { nespaSettings: {
    get: async () => ({ ...state.settings }),
    subscribe(listener) { state.settingsListeners.add(listener); return () => state.settingsListeners.delete(listener); }
  } };
  for (const name of ['nespa-parser.js', 'nespa-data-source.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'));
  state.create = () => new dom.window.PlatoCalendarExt.NespaDataSource();
  state.setClock = now => { dom.window.Date.now = () => now; };
  state.settingsChanged = () => state.settingsListeners.forEach(listener => listener());
  state.close = () => dom.window.close();
  return state;
}

test('source merges live own statuses, keeps detail concurrency at three, and caches in memory', async () => {
  const h = harness(); const source = h.create();
  try {
    const result = await source.getActivities();
    assert.equal(result.state, 'ok');
    assert.equal(result.activities[0].submissionStatus, '제출됨');
    assert.equal(result.activities[0].score, 100);
    assert.equal(result.activities[1].submissionStatus, '미제출');
    assert.equal(result.activities[1].submissionCheck, 'verified');
    assert.equal(h.maximum, 3);
    const requests = h.requests.length;
    result.activities[0].score = 999;
    assert.equal((await source.getActivities()).activities[0].score, 100);
    assert.equal(h.requests.length, requests);
    await source.getActivities({ forceRefresh: true });
    assert.equal(h.requests.length, requests * 2);
  } finally { source.destroy(); h.close(); }
});

for (const kind of ['month', 'detail']) {
  test(`NESPA ${kind} reads cannot reuse private status from before a clock rollback`, async () => {
    const h = harness(), source = h.create();
    try {
      h.setClock(1800000000000);
      const initial = await source.getActivities(); const before = h.requests.length;
      h.setClock(1800000000000 - 3600000);
      h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : emptyHtml });
      if (kind === 'month') {
        const result = await source.getActivities();
        assert.ok(result.activities.every(item => item.submissionStatus === '미제출' && item.score === null));
        assert.equal(h.requests.length, before + 4);
      } else {
        const result = await source.getDetail(initial.activities[0], false);
        assert.equal(result.submissionStatus, '미제출'); assert.equal(result.score, null);
        assert.equal(h.requests.length, before + 1);
      }
    } finally { source.destroy(); h.close(); }
  });
}

test('persistent catalog contains only a fixed common metadata whitelist', async () => {
  const h = harness(); const source = h.create();
  try {
    await source.getActivities();
    const entries = Object.values(h.stored);
    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0].assignments[0]).sort(), ['assignmentInfo', 'deadline', 'problemId', 'problemUrl', 'sampleUrl', 'startTime', 'title']);
    assert.deepEqual(entries[0].assignments[0].assignmentInfo, { maxSize: '10 KB', tokenSize: '1000', timeout: '1', maxTry: '10', evaluation: 'Automatic' });
    assert.equal(JSON.stringify(entries).includes('submissionStatus'), false);
    assert.equal(JSON.stringify(entries).includes('score'), false);
    assert.equal(JSON.stringify(entries).includes('Example Student'), false);
  } finally { source.destroy(); h.close(); }
});

const partialHistory = completeHtml.replace('</tbody>', '<tr><td colspan="9">일부 제출 내역을 불러올 수 없습니다.</td></tr></tbody>');
test('a partial own history preserves submitted status, warns and retries only incomplete private detail', async () => {
  const h = harness(), source = h.create();
  h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : request.problemId === '001' ? partialHistory : emptyHtml });
  try {
    const result = await source.getActivities(), first = result.activities[0];
    assert.equal(result.state, 'partial'); assert.equal(first.submissionStatus, '제출됨');
    assert.equal(first.submissionCheck, 'verified'); assert.equal(first.detailPartial, true);
    assert.equal(first.attempts, null); assert.equal(first.score, null);
    assert.equal(source.cache, null); assert.equal(source.details.has('ds2026:001'), false);
    const before = h.requests.length;
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : completeHtml });
    const recovered = await source.getActivities();
    assert.equal(recovered.state, 'ok'); assert.equal(recovered.activities[0].attempts, 1);
    assert.equal(recovered.activities[0].score, 100); assert.equal(recovered.activities[0].detailPartial, false);
    assert.equal(h.requests.length, before + 2);
  } finally { source.destroy(); h.close(); }
});

test('a partial modal recheck evicts old aggregate/private caches and a normal retry clears its warning', async () => {
  const h = harness(), source = h.create();
  try {
    const initial = await source.getActivities(), before = h.requests.length;
    h.handler = async () => ({ ok: true, html: partialHistory });
    const partial = await source.getDetail(initial.activities[0]);
    assert.equal(partial.detailPartial, true); assert.equal(source.cache, null);
    assert.equal(source.details.has('ds2026:001'), false);
    h.handler = async () => ({ ok: true, html: completeHtml });
    const recovered = await source.getDetail(partial, false);
    assert.equal(recovered.detailPartial, false); assert.equal(recovered.score, 100); assert.equal(recovered.attempts, 1);
    assert.equal(h.requests.length, before + 2);
  } finally { source.destroy(); h.close(); }
});

test('a modal status refresh updates the cached calendar item', async () => {
  const h = harness(); const source = h.create();
  try {
    const initial = await source.getActivities();
    const item = initial.activities[1];
    assert.equal(item.submissionStatus, '미제출');
    h.handler = async () => ({ ok: true, html: completeHtml });
    const detail = await source.getDetail(item);
    assert.equal(detail.submissionStatus, '제출됨');
    const current = await source.getActivities();
    assert.equal(current.activities.find(entry => entry.id === item.id).submissionStatus, '제출됨');
  } finally { source.destroy(); h.close(); }
});

test('auth-required fallback restores common dates but never previous private status', async () => {
  const h = harness(); const first = h.create();
  await first.getActivities(); first.destroy();
  h.handler = async () => ({ ok: false, error: 'auth-required' });
  const second = h.create();
  try {
    const result = await second.getActivities();
    assert.equal(result.state, 'auth-required');
    assert.equal(result.activities.length, 3);
    assert.equal(result.activities[0].submissionStatus, '확인 필요');
    assert.equal(result.activities[0].score, null);
    assert.equal(result.activities[0].catalogCached, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.activities[0].assignmentInfo)), { maxSize: '10 KB', tokenSize: '1000', timeout: '1', maxTry: '10', evaluation: 'Automatic' });
    assert.match(result.message, /저장된 과제 일정/);
  } finally { second.destroy(); h.close(); }
});

test('an assignment error placeholder restores saved dates without declaring non-submission or overwriting the catalog', async () => {
  const h = harness(); const source = h.create();
  try {
    const initial = await source.getActivities();
    const catalog = JSON.stringify(h.stored);
    const errorHtml = assignmentHtml.replace(/<tbody>[\s\S]*?<\/tbody>/,
      '<tbody><tr><td colspan="10">접근 권한이 없습니다.</td></tr></tbody>');
    h.requests.length = 0;
    h.handler = async () => ({ ok: true, html: errorHtml });
    const result = await source.getActivities({ forceRefresh: true });
    assert.notEqual(result.state, 'ok');
    assert.equal(result.activities.length, initial.activities.length);
    assert.ok(result.activities.every(item => item.catalogCached && item.submissionStatus === '확인 필요' && item.score === null && item.attempts === null));
    assert.match(result.message, /저장된 과제 일정/);
    assert.equal(h.requests.length, 1);
    assert.equal(JSON.stringify(h.stored), catalog);
    assert.equal(source.details.size, 0);
  } finally { source.destroy(); h.close(); }
});

test('a verified empty assignment list clears the catalog instead of reviving old tasks', async () => {
  const h = harness(); const source = h.create();
  try {
    await source.getActivities();
    const empty = assignmentHtml.replace(/<tbody>[\s\S]*?<\/tbody>/,
      '<tbody><tr><td colspan="10">등록된 과제가 없습니다.</td></tr></tbody>');
    h.requests.length = 0;
    h.handler = async () => ({ ok: true, html: empty });
    const result = await source.getActivities({ forceRefresh: true });
    assert.equal(result.state, 'ok');
    assert.equal(result.activities.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(Object.values(h.stored)[0].assignments.length, 0);
  } finally { source.destroy(); h.close(); }
});

test('legacy persisted catalog restores dates with unknown assignment constraints', async () => {
  const h = harness(); const first = h.create();
  await first.getActivities(); first.destroy();
  for (const catalog of Object.values(h.stored)) for (const item of catalog.assignments) delete item.assignmentInfo;
  h.handler = async () => ({ ok: false, error: 'auth-required' });
  const second = h.create();
  try {
    const result = await second.getActivities();
    assert.equal(result.state, 'auth-required');
    assert.equal(result.activities.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(result.activities[0].assignmentInfo)), { maxSize: null, tokenSize: null, timeout: null, maxTry: null, evaluation: null });
    assert.equal(result.activities[0].score, null);
    assert.equal(result.activities[0].attempts, null);
  } finally { second.destroy(); h.close(); }
});

test('a failed forced refresh cannot revive an earlier successful private cache', async () => {
  const h = harness(); const source = h.create();
  try {
    await source.getActivities();
    h.handler = async () => ({ ok: false, error: 'auth-required' });
    const failed = await source.getActivities({ forceRefresh: true });
    assert.equal(failed.state, 'auth-required');
    const subsequent = await source.getActivities();
    assert.equal(subsequent.state, 'auth-required');
    assert.ok(subsequent.activities.every(item => item.submissionStatus === '확인 필요' && item.score === null));
    assert.equal(source.details.size, 0);
  } finally { source.destroy(); h.close(); }
});

test('a failed modal recheck cannot revive its earlier verified detail', async () => {
  const h = harness(); const source = h.create();
  try {
    const initial = await source.getActivities();
    h.handler = async request => request.resource === 'assignments' ? { ok: true, html: assignmentHtml } : { ok: false, error: 'error' };
    await source.getDetail(initial.activities[0]);
    const subsequent = await source.getActivities();
    assert.equal(subsequent.activities[0].submissionStatus, '확인 필요');
    assert.equal(subsequent.activities[0].score, null);
  } finally { source.destroy(); h.close(); }
});

test('failed detail is unknown and does not make assignment fetch fail', async () => {
  const h = harness(); const source = h.create();
  h.handler = async request => request.resource === 'assignments' ? { ok: true, html: assignmentHtml } : { ok: false, error: 'error' };
  try {
    const result = await source.getActivities();
    assert.equal(result.state, 'partial');
    assert.equal(result.activities.length, 3);
    assert.ok(result.activities.every(item => item.submissionStatus === '확인 필요' && item.submissionCheck === 'failed'));
  } finally { source.destroy(); h.close(); }
});

test('auth expiry midway clears all private results from the same refresh', async () => {
  const h = harness(); const source = h.create();
  h.handler = async request => request.resource === 'assignments' ? { ok: true, html: assignmentHtml } :
    request.problemId === '13' ? { ok: false, error: 'auth-required' } : { ok: true, html: completeHtml };
  try {
    const result = await source.getActivities();
    assert.equal(result.state, 'auth-required');
    assert.ok(result.activities.every(item => item.submissionStatus === '확인 필요' && item.score === null));
    assert.equal(source.details.size, 0);
  } finally { source.destroy(); h.close(); }
});

test('a late detail cannot restore private status after an expired assignment-list session', async () => {
  const h = harness(), source = h.create();
  let finish;
  try {
    const initial = await source.getActivities();
    h.handler = () => new Promise(resolve => { finish = resolve; });
    const old = source.getDetail(initial.activities[0]);
    await tick();
    h.handler = async () => ({ ok: false, error: 'auth-required' });
    assert.equal((await source.getActivities({ forceRefresh: true })).state, 'auth-required');
    finish({ ok: true, html: completeHtml });
    const discarded = await old;
    assert.equal(discarded.submissionStatus, '확인 필요');
    assert.equal(discarded.score, null);
    assert.equal(source.details.size, 0);
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : emptyHtml });
    const fresh = await source.getActivities();
    assert.equal(fresh.state, 'ok');
    assert.ok(fresh.activities.every(item => item.submissionStatus === '미제출' && item.score === null));
  } finally { finish?.({ ok: false }); source.destroy(); h.close(); }
});

test('a stale authentication failure cannot erase a recovered session or block its new checks', async () => {
  const h = harness(), source = h.create();
  const invalidations = [];
  source.subscribePrivateInvalidation(reason => invalidations.push(reason));
  let finish, refresh;
  try {
    const initial = await source.getActivities();
    h.handler = () => new Promise(resolve => { finish = resolve; });
    const old = source.getDetail(initial.activities[0]);
    await tick();
    h.handler = async () => ({ ok: false, error: 'auth-required' });
    await source.getDetail(initial.activities[1]);
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : emptyHtml });
    let completed = false;
    refresh = source.getActivities();
    refresh.then(() => { completed = true; });
    for (let round = 0; round < 10 && !completed; round++) await tick();
    assert.equal(completed, true, 'new checks must not join the old session detail promise');
    const fresh = await refresh;
    assert.equal(fresh.state, 'ok');
    const cache = JSON.stringify(source.cache);
    finish({ ok: false, error: 'auth-required' });
    await old;
    assert.equal(JSON.stringify(source.cache), cache);
    assert.equal(source.details.size, initial.activities.length);
    assert.deepEqual(invalidations, ['auth-required']);
    assert.ok(h.maximum <= 3);
  } finally { finish?.({ ok: false }); if (refresh) await refresh; source.destroy(); h.close(); }
});

test('cached common schedules with mismatched course identity are not restored under the selected course', async () => {
  const h = harness(), source = h.create();
  try {
    await source.getActivities();
    const catalog = Object.values(h.stored)[0];
    h.handler = async () => ({ ok: false, error: 'auth-required' });
    for (const patch of [{ courseUrl: 'https://emerald.pusan.ac.kr/other2026/', courseYear: 2026 },
      { courseUrl: h.settings.courseUrl, courseYear: 2025 }]) {
      Object.assign(catalog, patch);
      const result = await source.getActivities({ forceRefresh: true });
      assert.equal(result.state, 'auth-required');
      assert.equal(result.activities.length, 0);
    }
  } finally { source.destroy(); h.close(); }
});

for (const expiry of ['transport', 'login page']) {
test(`session expiry from ${expiry} cancels queued old checks without spending another request slot`, async () => {
  const h = harness(), source = h.create(), releases = [];
  try {
    const initial = await source.getActivities();
    h.requests.length = 0;
    h.handler = request => new Promise(resolve => releases.push({ id: request.problemId, resolve }));
    const work = [...initial.activities, { ...initial.activities[0], problemId: '99', id: 'activity:nespa:ds2026:99' }]
      .map(item => source.getDetail(item));
    await tick();
    assert.equal(releases.length, 3);
    releases[0].resolve(expiry === 'transport' ? { ok: false, error: 'auth-required' } : { ok: true, html: fixture('nespa-login.html') });
    await tick();
    assert.equal(h.requests.some(request => request.problemId === '99'), false);
    releases.slice(1).forEach(item => item.resolve({ ok: true, html: completeHtml }));
    const result = await Promise.all(work);
    assert.ok(result.every(item => item.submissionStatus === '확인 필요' && item.score === null));
    assert.equal(source.detailActive, 0);
    assert.equal(source.detailWaiters.length, 0);
    assert.equal(source.details.size, 0);
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : emptyHtml });
    assert.equal((await source.getActivities()).state, 'ok');
  } finally { releases.forEach(item => item.resolve({ ok: false })); source.destroy(); h.close(); }
});
}

test('detail request semaphore includes a concurrent modal request', async () => {
  const h = harness(); const source = h.create();
  const releases = [];
  h.handler = async request => request.resource === 'assignments' ? { ok: true, html: assignmentHtml } :
    new Promise(resolve => releases.push(() => resolve({ ok: true, html: emptyHtml })));
  try {
    const list = source.getActivities();
    await tick();
    assert.equal(releases.length, 3);
    const modal = source.getDetail({ provider: 'nespa', courseId: 'ds2026', problemId: '99' });
    await tick();
    assert.equal(releases.length, 3);
    releases.shift()();
    await tick();
    assert.equal(releases.length, 3);
    releases.splice(0).forEach(release => release());
    await Promise.all([list, modal]);
    assert.equal(h.maximum, 3);
  } finally { source.destroy(); h.close(); }
});

test('changed calendar settings invalidate and retry the active fetch once', async () => {
  const h = harness(); const source = h.create();
  let assignmentCalls = 0;
  h.handler = async request => {
    if (request.resource !== 'assignments') return { ok: true, html: emptyHtml };
    assignmentCalls += 1;
    if (assignmentCalls === 1) h.settingsChanged();
    return { ok: true, html: assignmentHtml };
  };
  try {
    const result = await source.getActivities();
    assert.equal(result.state, 'ok');
    assert.equal(assignmentCalls, 2);
  } finally { source.destroy(); h.close(); }
});

test('OFF cancels in-flight data and late callbacks cannot repopulate the calendar', async () => {
  const h = harness(); const source = h.create();
  let deliver;
  h.handler = () => new Promise(resolve => { deliver = resolve; });
  try {
    const pending = source.getActivities();
    await tick();
    h.settings.enabled = false;
    h.settingsChanged();
    const result = await pending;
    assert.equal(result.state, 'disabled');
    assert.equal(result.activities.length, 0);
    deliver({ ok: true, html: assignmentHtml });
    await tick();
    assert.equal(source.cache, null);
    assert.equal(Object.keys(h.stored).length, 0);
  } finally { source.destroy(); h.close(); }
});

test('manual refresh detects an expired session and clears cached personal status', async () => {
  const h = harness(); const source = h.create();
  try {
    await source.getActivities();
    h.handler = async () => ({ ok: false, error: 'auth-required' });
    const result = await source.getActivities({ forceRefresh: true });
    assert.equal(result.state, 'auth-required');
    assert.ok(result.activities.every(item => item.score === null && item.submissionCheck !== 'verified'));
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml : completeHtml });
    const restored = await source.getActivities({ forceRefresh: true });
    assert.equal(restored.state, 'ok');
    assert.ok(restored.activities.every(item => item.submissionStatus === '제출됨'));
  } finally { source.destroy(); h.close(); }
});

test('a course change discards pending responses from the previous course', async () => {
  const h = harness(); const source = h.create();
  let deliver;
  h.handler = () => new Promise(resolve => { deliver = resolve; });
  try {
    const pending = source.getActivities();
    await tick();
    h.settings.courseUrl = 'https://emerald.pusan.ac.kr/ds2027/';
    h.settings.courseYear = 2027;
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml.replaceAll('ds2026', 'ds2027') : emptyHtml });
    h.settingsChanged();
    const result = await pending;
    assert.equal(result.state, 'ok');
    assert.ok(result.activities.every(item => item.courseId === 'ds2027'));
    deliver({ ok: true, html: assignmentHtml });
    await tick();
    assert.ok(source.cache.activities.every(item => item.courseId === 'ds2027'));
  } finally { source.destroy(); h.close(); }
});

test('retired automatic-login pause flags do not block the existing NESPA session', async () => {
  const h = harness();
  h.stored['platoEnhanced.nespa.authState'] = { paused: true, blocked: true };
  const source = h.create();
  try {
    const result = await source.getActivities();
    assert.equal(result.state, 'ok');
    const detail = await source.getDetail(result.activities[0]);
    assert.equal(detail.submissionStatus, '제출됨');
    assert.equal(detail.score, 100);
    assert.ok(h.requests.every(request => request.type === 'PE_NESPA_FETCH'));
    assert.equal(h.storageListeners.size, 0);
  } finally { source.destroy(); h.close(); }
});

test('a partial assignment parse does not replace the last complete common catalog', async () => {
  const h = harness(); const source = h.create();
  try {
    await source.getActivities();
    h.handler = async request => ({ ok: true, html: request.resource === 'assignments' ? assignmentHtml.replace('11/1 22:00', 'invalid') : emptyHtml });
    const result = await source.getActivities({ forceRefresh: true });
    assert.equal(result.state, 'partial');
    assert.equal(result.activities.length, 2);
    assert.equal(Object.values(h.stored)[0].assignments.length, 3);
    assert.equal(source.cache, null);
  } finally { source.destroy(); h.close(); }
});

test('destroy removes subscriptions and prevents subsequent requests', async () => {
  const h = harness(); const source = h.create();
  source.destroy();
  try {
    assert.equal(h.settingsListeners.size, 0);
    assert.equal(h.storageListeners.size, 0);
    assert.equal((await source.getActivities()).state, 'disabled');
    assert.equal(h.requests.length, 0);
  } finally { h.close(); }
});
