const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function environment() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only' });
  for (const file of ['config.js', 'plato-parser.js', 'submission-parser.js', 'calendar-model.js', 'data-source.js']) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  }
  return dom;
}

test('batched status updates refresh every cached month without changing freshness or sharing caller objects', () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const first = { id: 'calendar:1', title: 'First', submissionStatus: null };
  const second = { id: 'calendar:2', title: 'Second', submissionStatus: null };
  const untouched = { id: 'calendar:3', title: 'Untouched' };
  source.monthCache.set('2026-10', { fetchedAt: 100, activities: [first, second, untouched] });
  source.monthCache.set('2026-11', { fetchedAt: 200, activities: [first, second] });
  const updates = [{ ...first, submissionStatus: '미제출' }, { ...second, submissionStatus: '제출 완료' }];
  try {
    source.updateActivities(updates);
    for (const month of source.monthCache.values()) {
      assert.equal(month.activities[0].submissionStatus, '미제출');
      assert.equal(month.activities[1].submissionStatus, '제출 완료');
    }
    assert.equal(source.monthCache.get('2026-10').activities[2], untouched);
    assert.equal(source.monthCache.get('2026-10').fetchedAt, 100);
    assert.equal(source.monthCache.get('2026-11').fetchedAt, 200);
    updates[0].title = 'Changed caller object';
    assert.equal(source.monthCache.get('2026-10').activities[0].title, 'First');
    source.updateActivities([{ ...second, submissionStatus: '초안 저장' }]);
    assert.equal(source.monthCache.get('2026-11').activities[1].submissionStatus, '초안 저장');
  } finally { source.destroy(); dom.window.close(); }
});

test('verified PLATO non-submission remains known before and after its deadline', () => {
  const dom = environment(), ns = dom.window.PlatoCalendarExt;
  try {
    const status = ns.submissionParser.parseDetails('<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>미제출</td></tr></table></div>');
    const activity = { typeCode: 'assign', deadline: 1800000000, sourceStatus: { code: 'unknown' }, ...status };
    assert.equal(status.submissionCheck, 'verified');
    const upcoming = ns.calendarModel.classifyActivity(activity, false, activity.deadline - 72 * 3600, 48);
    assert.equal(upcoming.code, 'incomplete');
    assert.equal(upcoming.label, '미제출');
    const overdue = ns.calendarModel.classifyActivity(activity, false, activity.deadline + 1, 48);
    assert.equal(overdue.code, 'overdue');
    assert.match(overdue.label, /미제출/);
    assert.equal(ns.calendarModel.classifyActivity(activity, true, activity.deadline + 1, 48).code, 'manual');
    const unavailable = { ...activity, submissionStatus: null, submissionCheck: 'failed' };
    assert.equal(ns.calendarModel.classifyActivity(unavailable, false, activity.deadline + 1, 48).code, 'unknown');
  } finally { dom.window.close(); }
});

test('explicit incomplete submission states override completion without losing the deadline warning', () => {
  const dom = environment(), ns = dom.window.PlatoCalendarExt;
  const deadline = 1800000000;
  try {
    for (const submissionStatus of ['미제출', '초안 저장', '재제출 필요']) {
      const activity = { typeCode: 'assign', deadline, submissionStatus, submissionCheck: 'verified',
        sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' } };
      const upcoming = ns.calendarModel.classifyActivity(activity, false, deadline - 72 * 3600, 48);
      assert.equal(upcoming.code, 'incomplete', submissionStatus);
      assert.match(upcoming.label, new RegExp(submissionStatus));
      const soon = ns.calendarModel.classifyActivity(activity, false, deadline - 3600, 48);
      assert.equal(soon.code, 'due-soon', submissionStatus);
      assert.match(soon.label, new RegExp(submissionStatus));
      const past = ns.calendarModel.classifyActivity(activity, false, deadline + 1, 48);
      assert.equal(past.code, 'overdue', submissionStatus);
      assert.match(past.label, new RegExp(submissionStatus));
      assert.equal(ns.calendarModel.classifyActivity(activity, true, deadline + 1, 48).code, 'manual');
    }
    assert.equal(ns.calendarModel.classifyActivity({ deadline, sourceStatus: { code: 'completed' } }, false, deadline + 1, 48).code, 'completed');
    assert.equal(ns.calendarModel.classifyActivity({ deadline, submissionStatus: '제출 완료', sourceStatus: { code: 'incomplete' } }, false, deadline + 1, 48).code, 'submitted');
  } finally { dom.window.close(); }
});

test('a detected PLATO account change invalidates every cached month', async () => {
  const dom = environment(), ns = dom.window.PlatoCalendarExt;
  const source = new ns.PlatoDataSource();
  let userId = '101', requests = 0;
  source.request = async (operation, { year, month }) => {
    if (operation === 'context') return { userId, timezone: 'Asia/Seoul' };
    requests++;
    return { context: { userId, timezone: 'Asia/Seoul' }, action: { events: [], complete: true },
      month: { events: [{ id: Number(userId), name: `Account ${userId}`, modulename: 'assign',
        timestart: Date.UTC(year, month - 1, 15) / 1000, url: `https://plato.pusan.ac.kr/mod/assign/view.php?id=${userId}` }] } };
  };
  try {
    await source.getMonth(2026, 9, false);
    await source.getMonth(2026, 10, false);
    assert.equal((await source.getMonth(2026, 9, false)).userScope, '101');
    assert.equal(requests, 2);
    userId = '202';
    await source.getMonth(2026, 10, true);
    const restoredMonth = await source.getMonth(2026, 9, false);
    assert.equal(restoredMonth.userScope, '202');
    assert.equal(restoredMonth.activities[0].title, 'Account 202');
    assert.equal(requests, 4);
  } finally { source.destroy(); dom.window.close(); }
});

function monthPayload(userId, month = 10) {
  return { context: { userId, timezone: 'Asia/Seoul' }, action: { events: [], complete: true },
    month: { events: [{ id: Number(userId), name: `Account ${userId}`, modulename: 'assign',
      timestart: Date.UTC(2026, month - 1, 15) / 1000, url: `https://plato.pusan.ac.kr/mod/assign/view.php?id=${userId}` }] } };
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const kind of ['month', 'submission', 'course']) {
  test(`PLATO ${kind} cache expires on clock rollback and respects the ten-minute boundary`, async () => {
    const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
    const initialNow = 1800000000000; let now = initialNow, reads = 0;
    dom.window.Date.now = () => now;
    source.request = async operation => operation === 'context' ? { userId: '101' } : (reads++, monthPayload('101'));
    source.fetchStatusPage = async () => { reads++; return kind === 'course' ? reportHtml('미완료') : submissionHtml('미제출'); };
    const read = () => kind === 'month' ? source.getMonth(2026, 10, false) : kind === 'course' ? source.getCourseCompletions('9') :
      source.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' });
    try {
      await source.getContext(); await read();
      now = initialNow + 600000 - 1; await read(); assert.equal(reads, 1);
      now = initialNow - 3600000; await read(); assert.equal(reads, 2, 'a future-dated cache must be read again');
      now += 600000; await read(); assert.equal(reads, 3, 'the cache expires exactly at ten minutes');
    } finally { source.destroy(); dom.window.close(); }
  });
}

test('a superseded month response cannot overwrite a newer refresh for the same account', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const old = deferred(), fresh = deferred(); let requests = 0;
  source.request = async operation => operation === 'context' ? { userId: '101' } : (++requests === 1 ? old.promise : fresh.promise);
  try {
    const first = source.getMonth(2026, 10, true);
    const obsolete = assert.rejects(first, /MONTH_OBSOLETE/);
    await new Promise(resolve => setImmediate(resolve));
    const second = source.getMonth(2026, 10, true);
    await new Promise(resolve => setImmediate(resolve));
    const newer = monthPayload('101'); newer.month.events[0].name = 'New deadline and title';
    fresh.resolve(newer);
    assert.equal((await second).activities[0].title, 'New deadline and title');
    old.resolve(monthPayload('101'));
    await obsolete;
    assert.equal((await source.getMonth(2026, 10, false)).activities[0].title, 'New deadline and title');
    assert.equal(requests, 2);
  } finally { old.resolve(monthPayload('101')); fresh.resolve(monthPayload('101')); source.destroy(); dom.window.close(); }
});

test('ordinary month reads join a running refresh instead of returning old cache or requesting again', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const fresh = deferred(); let requests = 0;
  source.request = async operation => operation === 'context' ? { userId: '101' } : (++requests === 1 ? monthPayload('101') : fresh.promise);
  try {
    await source.getMonth(2026, 10, false);
    const force = source.getMonth(2026, 10, true);
    await new Promise(resolve => setImmediate(resolve));
    let completed = false;
    const reader = source.getMonth(2026, 10, false).then(value => { completed = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'a cached old month must not bypass the refresh');
    assert.equal(requests, 2);
    const newer = monthPayload('101'); newer.month.events[0].name = 'Fresh month'; fresh.resolve(newer);
    const results = await Promise.all([force, reader]);
    assert.ok(results.every(result => result.activities[0].title === 'Fresh month'));
  } finally { fresh.resolve(monthPayload('101')); source.destroy(); dom.window.close(); }
});

test('a superseded month finishing early cannot remove the replacement pending read', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const old = deferred(), fresh = deferred(); let requests = 0;
  source.request = async operation => operation === 'context' ? { userId: '101' } : (++requests === 1 ? old.promise : fresh.promise);
  try {
    const first = source.getMonth(2026, 10, true), obsolete = assert.rejects(first, /MONTH_OBSOLETE/);
    await new Promise(resolve => setImmediate(resolve));
    const second = source.getMonth(2026, 10, true);
    await new Promise(resolve => setImmediate(resolve));
    old.resolve(monthPayload('101')); await obsolete;
    const reader = source.getMonth(2026, 10, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 2);
    const newer = monthPayload('101'); newer.month.events[0].name = 'Replacement'; fresh.resolve(newer);
    assert.ok((await Promise.all([second, reader])).every(result => result.activities[0].title === 'Replacement'));
  } finally { old.resolve(monthPayload('101')); fresh.resolve(monthPayload('101')); source.destroy(); dom.window.close(); }
});

test('month refresh ordering is independent for different months', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const october = deferred(), november = deferred();
  source.request = async (operation, args) => operation === 'context' ? { userId: '101' } : args.month === 10 ? october.promise : november.promise;
  try {
    const first = source.getMonth(2026, 10, true);
    await new Promise(resolve => setImmediate(resolve));
    const second = source.getMonth(2026, 11, true);
    await new Promise(resolve => setImmediate(resolve));
    november.resolve(monthPayload('101', 11)); await second;
    october.resolve(monthPayload('101', 10)); await first;
    assert.equal(source.monthCache.size, 2);
  } finally { october.resolve(monthPayload('101', 10)); november.resolve(monthPayload('101', 11)); source.destroy(); dom.window.close(); }
});

test('a failed forced month refresh does not revive the previous cache and permits retry', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource(); let requests = 0;
  source.request = async operation => {
    if (operation === 'context') return { userId: '101' };
    if (++requests === 2) throw new Error('MONTH_OFFLINE');
    const payload = monthPayload('101'); payload.month.events[0].name = `Request ${requests}`; return payload;
  };
  try {
    await source.getMonth(2026, 10, false);
    await assert.rejects(source.getMonth(2026, 10, true), /MONTH_OFFLINE/);
    assert.equal((await source.getMonth(2026, 10, false)).activities[0].title, 'Request 3');
    assert.equal(requests, 3);
  } finally { source.destroy(); dom.window.close(); }
});

for (const previousPending of [false, true]) {
  test(`a failed context check invalidates a forced month's ${previousPending ? 'previous pending response' : 'previous cache'}`, async () => {
    const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
    const late = deferred(); let failContext = false, holdMonth = false, requests = 0;
    source.request = async operation => {
      if (operation === 'context') {
        if (failContext) throw new Error('CONTEXT_UNAVAILABLE');
        return { userId: '101' };
      }
      requests++;
      const payload = monthPayload('101'); payload.month.events[0].name = `Request ${requests}`;
      return holdMonth ? late.promise : payload;
    };
    let rejected;
    try {
      await source.getMonth(2026, 10, false);
      if (previousPending) {
        holdMonth = true;
        rejected = assert.rejects(source.getMonth(2026, 10, true), /MONTH_OBSOLETE/);
        await new Promise(resolve => setImmediate(resolve));
      }
      failContext = true;
      await assert.rejects(source.getMonth(2026, 10, true), /CONTEXT_UNAVAILABLE/);
      late.resolve(monthPayload('101'));
      if (rejected) await rejected;
      assert.equal(source.monthCache.size, 0);
      failContext = false; holdMonth = false;
      assert.equal((await source.getMonth(2026, 10, false)).activities[0].title, `Request ${previousPending ? 3 : 2}`);
    } finally { late.resolve(monthPayload('101')); source.destroy(); dom.window.close(); }
  });
}

const submissionHtml = status => `<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>${status}</td></tr></table></div>`;
const reportHtml = status => `<body id="page-report-ublogs-student-activity"><main id="region-main"><table class="table-learning-student-activity"><tbody><tr><td class="td-activity"><a href="/mod/assign/view.php?id=7">과제</a></td><td class="td-status"><span class="csms-chips-status">${status}</span></td></tr></tbody></table></main></body>`;
for (const kind of ['submission', 'course']) {
  const read = (source, force) => kind === 'submission'
    ? source.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' }, force)
    : source.getCourseCompletions('9', force);
  const html = completed => kind === 'submission' ? submissionHtml(completed ? '제출 완료' : '미제출') : reportHtml(completed ? '완료' : '미완료');
  const state = result => kind === 'submission' ? result.submissionStatus : result.entries['https://plato.pusan.ac.kr/mod/assign/view.php?id=7'].code;
  const incomplete = kind === 'submission' ? '미제출' : 'incomplete';

  test(`a forced ${kind} check supersedes an older in-flight result and preserves the fresh cache`, async () => {
    const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
    const old = deferred(), fresh = deferred(); let fetches = 0;
    source.request = async () => ({ userId: '101' });
    source.fetchStatusPage = () => ++fetches === 1 ? old.promise : fresh.promise;
    try {
      await source.getContext();
      const first = read(source, false), second = read(source, true);
      assert.equal(fetches, 2, 'explicit refresh must make a new status request');
      fresh.resolve(html(false));
      assert.equal(state(await second), incomplete);
      old.resolve(html(true));
      assert.equal(state(await first), incomplete);
      assert.equal(state(await read(source, false)), incomplete);
      assert.equal(fetches, 2);
    } finally { old.resolve(html(true)); fresh.resolve(html(false)); source.destroy(); dom.window.close(); }
  });

  test(`ordinary ${kind} reads join the replacement check when an obsolete check finishes first`, async () => {
    const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
    const old = deferred(), fresh = deferred(); let fetches = 0;
    source.request = async () => ({ userId: '101' });
    source.fetchStatusPage = () => ++fetches === 1 ? old.promise : fresh.promise;
    try {
      await source.getContext();
      let firstCompleted = false;
      const first = read(source, false).then(result => { firstCompleted = true; return result; });
      const second = read(source, true);
      old.resolve(html(true));
      let completed = false;
      const reader = read(source, false).then(result => { completed = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(firstCompleted, false, 'the older reader must wait for the replacement result');
      assert.equal(completed, false);
      assert.equal(fetches, 2);
      fresh.resolve(html(false));
      assert.ok((await Promise.all([first, second, reader])).every(result => state(result) === incomplete));
    } finally { old.resolve(html(true)); fresh.resolve(html(false)); source.destroy(); dom.window.close(); }
  });

  test(`a failed replacement ${kind} check cannot be replaced by an old successful response`, async () => {
    const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
    const old = deferred(); let fetches = 0;
    source.request = async () => ({ userId: '101' });
    source.fetchStatusPage = () => ++fetches === 1 ? old.promise : Promise.reject(new Error('OFFLINE'));
    const check = result => kind === 'submission' ? result.submissionCheck : result.check;
    try {
      await source.getContext();
      const first = read(source, false);
      assert.equal(check(await read(source, true)), 'failed');
      old.resolve(html(true));
      assert.equal(check(await first), 'failed');
      assert.equal(check(await read(source, false)), 'failed');
      assert.equal(fetches, 2);
    } finally { old.resolve(html(true)); source.destroy(); dom.window.close(); }
  });
}

test('a cached PLATO month checks the current account before returning private data', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  let userId = '101', monthRequests = 0;
  source.request = async operation => operation === 'context' ? { userId } : (monthRequests++, monthPayload(userId));
  try {
    await source.getMonth(2026, 10, false);
    userId = '202';
    const result = await source.getMonth(2026, 10, false);
    assert.equal(result.userScope, '202');
    assert.equal(result.activities[0].title, 'Account 202');
    assert.equal(monthRequests, 2);
  } finally { source.destroy(); dom.window.close(); }
});

test('late month responses cannot roll back a newly observed PLATO account', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const late = deferred();
  let userId = '101', deferMonth = false;
  source.request = async operation => operation === 'context' ? { userId } : deferMonth ? late.promise : monthPayload(userId);
  try {
    await source.getMonth(2026, 10, false);
    deferMonth = true;
    const old = source.getMonth(2026, 9, true);
    const rejected = assert.rejects(old, /ACCOUNT_CHANGED/);
    await new Promise(resolve => setImmediate(resolve));
    userId = '202'; deferMonth = false;
    await source.getMonth(2026, 10, true);
    late.resolve(monthPayload('101', 9));
    await rejected;
    assert.equal(source.userScope, '202');
    assert.equal((await source.getMonth(2026, 10, false)).activities[0].title, 'Account 202');
    assert.equal(source.monthCache.has('2026-09'), false);
  } finally { late.resolve(monthPayload('101', 9)); source.destroy(); dom.window.close(); }
});

test('account changes discard pending assignment and course status even after returning to the same account', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  let userId = '101';
  const lateSubmission = deferred(), lateReport = deferred();
  source.request = async operation => operation === 'context' ? { userId } : monthPayload(userId);
  source.fetchStatusPage = url => url.includes('/mod/assign/') ? lateSubmission.promise : lateReport.promise;
  try {
    await source.getMonth(2026, 10, false);
    const submission = source.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' });
    const report = source.getCourseCompletions('9');
    userId = '202'; await source.getMonth(2026, 10, true);
    userId = '101'; await source.getMonth(2026, 10, true);
    lateSubmission.resolve('<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>제출 완료</td></tr></table></div>');
    lateReport.resolve('<body id="page-report-ublogs-student-activity"><div id="region-main"><table class="table-learning-student-activity"><tbody></tbody></table></div></body>');
    assert.equal(await submission, null);
    assert.equal(await report, null);
    assert.equal(source.submissionCache.size, 0);
    assert.equal(source.completionCache.size, 0);
    assert.equal(source.submissionPending.size, 0);
    assert.equal(source.completionPending.size, 0);
  } finally { lateSubmission.resolve(''); lateReport.resolve(''); source.destroy(); dom.window.close(); }
});

test('destroyed PLATO sources discard pending month responses and clear private caches', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const late = deferred();
  let deferMonth = false;
  source.request = async operation => operation === 'context' ? { userId: '101' } : deferMonth ? late.promise : monthPayload('101');
  try {
    await source.getMonth(2026, 10, false);
    deferMonth = true;
    const loading = source.getMonth(2026, 9, true);
    const rejected = assert.rejects(loading, /DESTROYED/);
    await new Promise(resolve => setImmediate(resolve));
    source.destroy();
    late.resolve(monthPayload('101', 9));
    await rejected;
    assert.equal(source.monthCache.size, 0);
  } finally { late.resolve(monthPayload('101', 9)); source.destroy(); dom.window.close(); }
});

test('late account context and mixed-account month responses are rejected', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const late = deferred();
  let contextCalls = 0;
  source.request = async operation => operation === 'context' ? (++contextCalls === 1 ? late.promise : { userId: '202' }) : monthPayload('101');
  try {
    const old = source.getContext();
    const rejected = assert.rejects(old, /ACCOUNT_CHANGED/);
    await source.getContext();
    late.resolve({ userId: '101' });
    await rejected;
    assert.equal(source.userScope, '202');
    await assert.rejects(source.getMonth(2026, 10, true), /ACCOUNT_CHANGED/);
    assert.equal(source.userScope, '202');
    assert.equal(source.monthCache.size, 0);
  } finally { late.resolve({ userId: '101' }); source.destroy(); dom.window.close(); }
});

test('an old request cannot delete a replacement pending status for the same account', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  const oldSubmission = deferred(), newSubmission = deferred();
  let userId = '101', fetches = 0;
  source.request = async () => ({ userId });
  source.fetchStatusPage = () => ++fetches === 1 ? oldSubmission.promise : newSubmission.promise;
  const item = { activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  try {
    await source.getContext();
    const old = source.getSubmission(item);
    userId = '202'; await source.getContext();
    userId = '101'; await source.getContext();
    const current = source.getSubmission(item);
    oldSubmission.resolve('');
    assert.equal(await old, null);
    assert.equal(source.submissionPending.size, 1);
    const same = source.getSubmission(item);
    assert.equal(fetches, 2);
    newSubmission.resolve('<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>未確認</td></tr></table></div>');
    assert.equal((await current).submissionCheck, 'unavailable');
    assert.equal((await same).submissionCheck, 'unavailable');
    assert.equal(source.submissionPending.size, 0);
  } finally { oldSubmission.resolve(''); newSubmission.resolve(''); source.destroy(); dom.window.close(); }
});

test('observing another PLATO account aborts pending HTTP status reads', async () => {
  const dom = environment(), source = new dom.window.PlatoCalendarExt.PlatoDataSource();
  let userId = '101';
  const signals = [];
  source.request = async () => ({ userId });
  dom.window.fetch = (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    await source.getContext();
    const submission = source.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' });
    const report = source.getCourseCompletions('9');
    assert.equal(signals.length, 2);
    userId = '202'; await source.getContext();
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(await submission, null);
    assert.equal(await report, null);
    assert.equal(source.controllers.size, 0);
  } finally { source.destroy(); dom.window.close(); }
});

test('the real page bridge rejects a month collected across two account contexts', async () => {
  const dom = environment(), w = dom.window, source = new w.PlatoCalendarExt.PlatoDataSource();
  const late = deferred();
  let deferMonth = true;
  w.M = { cfg: { userId: '101', usertimezone: 'Asia/Seoul' } };
  w.require = (names, success) => {
    if (names[0] === 'core_calendar/repository') success({
      getCalendarMonthData: () => deferMonth ? late.promise : monthPayload(w.M.cfg.userId).month
    });
    else success({ queryByTime: () => ({ events: [] }) });
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../src/page-bridge.js'), 'utf8'));
  try {
    const loading = source.getMonth(2026, 10, true);
    const rejected = assert.rejects(loading, /ACCOUNT_CHANGED/);
    await new Promise(resolve => setImmediate(resolve));
    w.M.cfg.userId = '202';
    late.resolve(monthPayload('101').month);
    await rejected;
    assert.equal(source.monthCache.size, 0);
    deferMonth = false;
    const fresh = await source.getMonth(2026, 10, false);
    assert.equal(fresh.userScope, '202');
    assert.equal(fresh.activities[0].title, 'Account 202');
  } finally { late.resolve({}); source.destroy(); w.close(); }
});
