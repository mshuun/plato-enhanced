"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const deadline = Date.parse("2026-10-31T22:00:00+09:00") / 1000;
const nespaItem = {
  id: "activity:nespa:ds2026:13", provider: "nespa", problemId: "13", courseId: "ds2026", courseName: "자료구조",
  title: "Example NESPA task", deadline, typeCode: "assign", typeLabel: "NESPA 과제",
  activityUrl: "https://emerald.pusan.ac.kr/ds2026/submission_detail/?prob_id=13",
  submissionStatus: "확인 필요", submissionCheck: "unavailable", score: null
};
const platoItem = { id: "calendar:1", provider: "plato", title: "PLATO task", courseName: "Course", deadline };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  const dom = new JSDOM("<!doctype html><body><div class='dashboard'><section id='courses'></section></div></body>", {
    url: "https://plato.pusan.ac.kr/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const w = dom.window;
  const state = { w, monthCalls: 0, monthForces: [], invalidations: 0, settingsListeners: new Set(), storageListeners: new Set(), privateListeners: new Set(),
    monthHandler: async () => ({ activities: [], userScope: "42", timezone: "Asia/Seoul", fetchedAt: Date.now(), partial: false }),
    detailHandler: async activity => activity };
  w.chrome = { storage: { onChanged: {
    addListener(listener) { state.storageListeners.add(listener); },
    removeListener(listener) { state.storageListeners.delete(listener); }
  } } };
  const load = name => w.eval(fs.readFileSync(path.join(__dirname, "../src", name), "utf8"));
  for (const file of ["config.js", "plato-parser.js", "submission-parser.js", "nespa-parser.js", "calendar-model.js", "activity-modal.js"]) load(file);
  const ns = w.PlatoCalendarExt;
  ns.storage = { getCollapsed: async () => true, getManualCompletions: async () => ({}), subscribe: () => () => {} };
  ns.nespaSettings = {
    subscribe(listener) { state.settingsListeners.add(listener); return () => state.settingsListeners.delete(listener); }
  };
  ns.CombinedDataSource = class {
    async getContext() { return { timezone: "Asia/Seoul" }; }
    getMonth(year, month, force) { state.monthCalls += 1; state.monthForces.push(force); return state.monthHandler(); }
    getNespaDetail(activity) { return state.detailHandler(activity); }
    invalidateNespa() { state.invalidations += 1; }
    subscribeNespaInvalidation(listener) { state.privateListeners.add(listener); return () => state.privateListeners.delete(listener); }
    async getCourseCompletions() { return null; }
    async getSubmission() { return null; }
    updateActivity() {}
    updateActivities(activities) { activities.forEach(activity => this.updateActivity(activity)); }
    destroy() {}
  };
  load("calendar-view.js");
  const view = new ns.CalendarView();
  await view.mount(w.document.getElementById("courses"));
  view.year = 2026;
  view.month = 10;
  state.view = view;
  state.off = () => state.settingsListeners.forEach(listener => listener({ enabled: false }));
  state.changeSettings = () => state.settingsListeners.forEach(listener => listener({ courseUrl: "https://emerald.pusan.ac.kr/ds2027/" }));
  state.close = () => { view.destroy(); w.close(); };
  return state;
}

for (const completed of [true, false]) {
  test(`acknowledged manual ${completed ? 'completion' : 'cancellation'} remains visible when the following read fails`, async () => {
    const h = await harness(), saved = [];
    const storage = h.w.PlatoCalendarExt.storage;
    storage.setManualCompletion = async (...args) => { saved.push(args); };
    storage.getManualCompletions = async () => { throw new Error('READ_FAILED'); };
    try {
      h.view.collapsed = false; h.view.userScope = '42'; h.view.activities = [platoItem];
      h.view.manualCompletions = { 'calendar:2': true, ...(completed ? {} : { [platoItem.id]: true }) };
      h.view.render();
      await h.view.modal.open(platoItem, !completed);
      h.view.modal.manualButton.click();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(saved, [['42', platoItem.id, completed]]);
      assert.equal(h.view.manualCompletions[platoItem.id] === true, completed);
      assert.equal(h.view.manualCompletions['calendar:2'], true);
      assert.equal(h.view.root.querySelector('[data-activity-id="calendar:1"]').classList.contains('plato-calendar-ext-status-manual'), completed);
      assert.equal(h.view.modal.manualCompleted, completed);
      assert.equal(h.view.modal.feedback.textContent, '');
      assert.equal(h.view.modal.manualButton.disabled, false);
    } finally { h.close(); }
  });
}

test('an older storage read cannot undo an acknowledged manual save when reconciliation fails', async () => {
  const h = await harness(), oldRead = deferred(); let reads = 0;
  const storage = h.w.PlatoCalendarExt.storage;
  storage.getManualCompletions = () => ++reads === 1 ? oldRead.promise : Promise.reject(new Error('READ_FAILED'));
  storage.setManualCompletion = async () => {};
  try {
    h.view.userScope = '42';
    const old = h.view.reloadManual();
    await h.view.toggleManual(platoItem, true);
    oldRead.resolve({}); await old;
    assert.equal(h.view.manualCompletions[platoItem.id], true);
  } finally { oldRead.resolve({}); h.close(); }
});

test('a newer stored manual state is reflected consistently in the calendar and dialog', async () => {
  const h = await harness(), storage = h.w.PlatoCalendarExt.storage;
  storage.setManualCompletion = async () => {};
  // Another tab cancelled the same completion before the follow-up read.
  storage.getManualCompletions = async () => ({});
  try {
    h.view.userScope = '42'; h.view.collapsed = false; h.view.activities = [platoItem]; h.view.render();
    await h.view.modal.open(platoItem, false);
    h.view.modal.manualButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.view.modal.manualCompleted, false);
    assert.equal(h.view.root.querySelector('[data-activity-id="calendar:1"]').classList.contains('plato-calendar-ext-status-manual'), false);
    assert.equal(h.view.modal.manualButton.textContent, '수동 완료');
  } finally { h.close(); }
});

test('a failed manual write preserves the prior state and offers a retry', async () => {
  const h = await harness();
  h.w.PlatoCalendarExt.storage.setManualCompletion = async () => { throw new Error('WRITE_FAILED'); };
  try {
    h.view.userScope = '42'; h.view.activities = [platoItem];
    await h.view.modal.open(platoItem, false);
    h.view.modal.manualButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.view.manualCompletions[platoItem.id], undefined);
    assert.equal(h.view.modal.manualCompleted, false);
    assert.match(h.view.modal.feedback.textContent, /저장하지 못했습니다/);
    assert.equal(h.view.modal.manualButton.disabled, false);
  } finally { h.close(); }
});

test('a manual save does not apply to another account while its write is pending', async () => {
  const h = await harness(), write = deferred();
  h.w.PlatoCalendarExt.storage.setManualCompletion = () => write.promise;
  try {
    h.view.userScope = '42';
    const save = h.view.toggleManual(platoItem, true);
    h.view.userScope = '43'; h.view.manualCompletions = {};
    write.resolve(); await save;
    assert.equal(h.view.manualCompletions[platoItem.id], undefined);
  } finally { write.resolve(); h.close(); }
});

test('a quiz without a calendar event number refreshes its course completion from the open dialog', async () => {
  const h = await harness(); let reports = 0, completed = false;
  const key = 'https://plato.pusan.ac.kr/mod/quiz/view.php?id=7';
  const quiz = { ...platoItem, id: 'activity:9:quiz:7', eventId: null, courseId: '9', typeCode: 'quiz', typeLabel: '시험', activityUrl: key };
  h.view.dataSource.getDetail = async eventId => { assert.equal(eventId, null); return null; };
  h.view.dataSource.getCourseCompletions = async (courseId, force) => {
    reports++; assert.equal(courseId, '9'); assert.equal(force, true);
    return { entries: { [key]: { code: completed ? 'completed' : 'incomplete', label: completed ? 'PLATO에서 완료 확인' : '미완료', source: 'PLATO 활동 현황' } },
      check: 'verified', checkedAt: Date.now() };
  };
  try {
    h.view.userScope = '42'; h.view.activities = [quiz];
    await h.view.modal.open(quiz, false);
    assert.equal(reports, 1);
    assert.equal(h.view.modal.refreshButton.hidden, false);
    assert.equal(h.view.modal.activity.sourceStatus.code, 'incomplete');
    completed = true; h.view.modal.refreshButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports, 2);
    assert.equal(h.view.activities[0].sourceStatus.code, 'completed');
    assert.equal(h.view.modal.activity.sourceStatus.code, 'completed');
    assert.equal(h.view.modal.feedback.textContent, '');
    assert.equal(h.view.modal.refreshButton.disabled, false);
  } finally { h.close(); }
});

test('a malformed detail deadline preserves the selected deadline and keeps the dialog usable', async () => {
  const h = await harness();
  const selected = { ...platoItem, eventId: 1, courseId: 9, typeCode: 'assign', activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  h.view.activities = [selected];
  h.view.dataSource.getDetail = async () => ({ event: { id: 1, name: 'Updated title', timesort: 1e100 } });
  try {
    await h.view.modal.open(selected, false);
    assert.equal(h.view.activities[0].deadline, selected.deadline);
    assert.equal(h.view.modal.activity.deadline, selected.deadline);
    assert.equal(h.view.modal.activity.title, 'Updated title');
    assert.match(h.view.modal.body.textContent, /마감/);
    assert.equal(h.view.modal.feedback.textContent, '');
    assert.equal(h.view.modal.refreshButton.disabled, false);
  } finally { h.close(); }
});

test('a late PLATO detail cannot undo the newer calendar status after another settings tab refreshes it', async () => {
  const h = await harness(), detail = deferred();
  const selected = { ...platoItem, eventId: 1, courseId: '9', typeCode: 'assign',
    activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7', submissionStatus: '제출 완료' };
  const fresh = { ...selected, title: 'Current calendar title', submissionStatus: '미제출' };
  h.view.dataSource.getDetail = () => detail.promise;
  h.view.dataSource.getSubmission = async () => ({ submissionStatus: '미제출', submissionCheck: 'verified' });
  h.monthHandler = async () => ({ activities: [fresh], userScope: '42', timezone: 'Asia/Seoul', fetchedAt: Date.now(), partial: false });
  try {
    h.view.collapsed = false; h.view.userScope = '42'; h.view.activities = [selected]; h.view.render();
    const opening = h.view.modal.open(selected, false);
    h.changeSettings();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.view.activities[0].title, fresh.title);
    assert.equal(h.view.modal.activity.submissionStatus, '미제출');
    detail.resolve({ event: { id: 1, name: 'Obsolete detail title', submitted: true } }); await opening;
    assert.equal(h.view.activities[0].title, fresh.title);
    assert.equal(h.view.modal.activity.title, fresh.title);
    assert.equal(h.view.modal.activity.submissionStatus, '미제출');
    assert.equal(h.view.modal.feedback.textContent, '');
    assert.equal(h.view.modal.detailLoading, false);
    assert.equal(h.view.modal.refreshButton.disabled, false);
  } finally { detail.resolve(null); h.close(); }
});

test('an obsolete detail result is not returned to a caller after its calendar view is destroyed', async () => {
  const h = await harness(), detail = deferred();
  h.detailHandler = () => detail.promise;
  try {
    const pending = h.view.loadActivityDetail(nespaItem);
    h.view.destroy();
    detail.resolve({ ...nespaItem, title: 'Obsolete private result', score: 100 });
    assert.equal(await pending, null);
  } finally { detail.resolve(null); h.close(); }
});

test('a mismatched event detail cannot redirect the selected activity status reads', async () => {
  const h = await harness();
  const selected = { ...platoItem, eventId: 1, courseId: 9, typeCode: 'assign', activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  const calls = [];
  h.view.activities = [selected];
  h.view.dataSource.getDetail = async () => ({ event: { id: 2, name: 'Another assignment', modulename: 'assign',
    url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=99', course: { id: 99, fullname: 'Another course' } } });
  h.view.dataSource.getSubmission = async activity => { calls.push(activity.activityUrl); return { submissionStatus: '미제출', submissionCheck: 'verified' }; };
  h.view.dataSource.getCourseCompletions = async course => { calls.push(course); return null; };
  try {
    const result = await h.view.loadActivityDetail(selected);
    assert.equal(result.detailFailed, true);
    assert.equal(result.title, selected.title);
    assert.equal(result.activityUrl, selected.activityUrl);
    assert.equal(result.submissionStatus, '미제출');
    assert.deepEqual(calls, [selected.activityUrl, 9]);
  } finally { h.close(); }
});

test('calendar automatic refresh recovers when its previous attempt is in the future', async () => {
  const h = await harness();
  h.w.Date.now = () => 1800000000000;
  h.view.collapsed = false; h.view.applyCollapsedState();
  h.view.lastRefreshAttemptAt = 1800000000000 + 3600000;
  try {
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 1);
    assert.equal(h.view.lastRefreshAttemptAt, 1800000000000);
  } finally { h.close(); }
});

test('a detail read superseded by a new status batch cannot roll the calendar back when it finishes', async () => {
  const h = await harness(), ns = h.w.PlatoCalendarExt;
  h.w.eval(fs.readFileSync(path.join(__dirname, '../src/data-source.js'), 'utf8'));
  const plato = new ns.PlatoDataSource(); plato.userScope = '42';
  const selected = { ...platoItem, eventId: 1, courseId: 9, typeCode: 'assign', activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  const oldSubmission = deferred(), oldReport = deferred();
  const reads = { submission: 0, course: 0 };
  const submission = status => `<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>${status}</td></tr></table></div>`;
  const report = status => `<body id="page-report-ublogs-student-activity"><main id="region-main"><table class="table-learning-student-activity"><tbody><tr><td class="td-activity"><a href="/mod/assign/view.php?id=7">과제</a></td><td class="td-status"><span class="csms-chips-status">${status}</span></td></tr></tbody></table></main></body>`;
  plato.request = async () => ({ event: { id: 1, name: selected.title, modulename: 'assign', url: selected.activityUrl } });
  plato.fetchStatusPage = async url => url.includes('/mod/assign/')
    ? ++reads.submission === 1 ? oldSubmission.promise : submission('미제출')
    : ++reads.course === 1 ? oldReport.promise : report('미완료');
  for (const name of ['getSubmission', 'getCourseCompletions', 'getDetail', 'updateActivities']) h.view.dataSource[name] = plato[name].bind(plato);
  h.view.activities = [selected];
  try {
    const detail = h.view.loadActivityDetail(selected);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, { submission: 1, course: 1 });
    await h.view.refreshSubmissions(h.view.loadSequence, true);
    assert.equal(h.view.activities[0].submissionStatus, '미제출');
    assert.equal(h.view.activities[0].sourceStatus.code, 'incomplete');
    oldSubmission.resolve(submission('제출 완료')); oldReport.resolve(report('완료'));
    const result = await detail;
    assert.equal(result.submissionStatus, '미제출');
    assert.equal(result.sourceStatus.code, 'incomplete');
    assert.equal(h.view.activities[0].submissionStatus, '미제출');
    assert.equal(h.view.activities[0].sourceStatus.code, 'incomplete');
    assert.deepEqual(reads, { submission: 2, course: 2 });
  } finally { oldSubmission.resolve(submission('제출 완료')); oldReport.resolve(report('완료')); plato.destroy(); h.close(); }
});

test('one course report updates all relevant activities and an open detail with one calendar render', async () => {
  const h = await harness();
  const activities = Array.from({ length: 100 }, (_, index) => ({ ...platoItem, id: `calendar:${index + 1}`, courseId: 9,
    activityUrl: `https://plato.pusan.ac.kr/mod/assign/view.php?id=${index + 1}` }));
  const foreign = { ...platoItem, id: 'calendar:200', courseId: 10 };
  const nespa = { ...nespaItem, courseId: 9 };
  const report = { check: 'verified', checkedAt: Date.now(), entries: Object.fromEntries(activities.map(item => [item.activityUrl,
    { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' }])) };
  let renders = 0, detailRenders = 0;
  const cached = [];
  h.view.activities = [...activities, foreign, nespa];
  h.view.render = () => { renders++; };
  h.view.modal.overlay.hidden = false;
  h.view.modal.activity = activities[0];
  h.view.modal.render = () => { detailRenders++; };
  h.view.dataSource.updateActivity = activity => cached.push(activity);
  try {
    h.view.applyCourseResult(9, report);
    assert.equal(renders, 1);
    assert.equal(detailRenders, 1);
    assert.equal(cached.length, 100);
    assert.equal(h.view.activities.filter(item => item.sourceStatus?.code === 'completed').length, 100);
    assert.equal(h.view.activities.find(item => item.id === foreign.id), foreign);
    assert.equal(h.view.activities.find(item => item.id === nespa.id), nespa);
    assert.equal(h.view.modal.activity.sourceStatus.code, 'completed');
  } finally { h.close(); }
});

async function refreshFocusHarness() {
  const h = await harness();
  h.view.collapsed = false; h.view.applyCollapsedState();
  h.items = Array.from({ length: 8 }, (_, index) => ({ ...nespaItem, id: `activity:nespa:ds2026:${index + 1}`, problemId: String(index + 1), title: `Before refresh ${index + 1}` }));
  h.view.activities = h.items;
  h.view.render();
  h.focusLast = () => {
    h.view.root.querySelector('.plato-calendar-ext-more-button').click();
    h.view.dayPopover.node.querySelectorAll('[data-activity-id]')[7].focus();
  };
  h.month = activities => ({ activities, userScope: '42', timezone: 'Asia/Seoul', fetchedAt: Date.now(), partial: false });
  return h;
}

test('full month refresh retains an overflow activity and scroll after clearing the loading view', async () => {
  const h = await refreshFocusHarness(), pending = deferred();
  try {
    h.focusLast(); h.view.dayPopover.node.scrollTop = 42;
    h.monthHandler = () => pending.promise;
    const loading = h.view.loadMonth(true);
    assert.equal(h.view.root.querySelectorAll('[data-activity-id]').length, 0, 'previous private states stay hidden while loading');
    assert.equal(h.w.document.activeElement, h.view.status);
    pending.resolve(h.month(h.items.map(item => ({ ...item, title: 'Fresh ' + item.problemId }))));
    await loading;
    assert.equal(h.w.document.activeElement.dataset.activityId, h.items[7].id);
    assert.match(h.w.document.activeElement.textContent, /Fresh 8/);
    assert.equal(h.view.dayPopover.node.scrollTop, 42);
  } finally { pending.resolve(h.month([])); h.close(); }
});

test('a full refresh does not reclaim focus after the user moves to another control', async () => {
  const h = await refreshFocusHarness(), pending = deferred();
  try {
    h.focusLast(); h.monthHandler = () => pending.promise;
    const loading = h.view.loadMonth(true);
    h.view.collapseButton.focus();
    pending.resolve(h.month(h.items)); await loading;
    assert.equal(h.w.document.activeElement, h.view.collapseButton);
    assert.equal(h.view.dayPopover, null);
  } finally { pending.resolve(h.month([])); h.close(); }
});

test('full refresh restores a toolbar control after it becomes available again', async () => {
  const h = await refreshFocusHarness(), pending = deferred();
  try {
    h.view.refreshButton.focus(); h.monthHandler = () => pending.promise;
    const loading = h.view.loadMonth(true);
    assert.equal(h.w.document.activeElement, h.view.status);
    pending.resolve(h.month(h.items)); await loading;
    assert.equal(h.w.document.activeElement, h.view.refreshButton);
    assert.equal(h.view.refreshButton.disabled, false);
  } finally { pending.resolve(h.month([])); h.close(); }
});

test('a failed full refresh keeps focus on its error message and retry action', async () => {
  const h = await refreshFocusHarness();
  try {
    h.focusLast(); h.monthHandler = async () => { throw new Error('month unavailable'); };
    await h.view.loadMonth(true);
    assert.equal(h.w.document.activeElement, h.view.status);
    assert.match(h.view.status.textContent, /불러오지 못했습니다/);
    assert.ok(h.view.status.querySelector('button'));
  } finally { h.close(); }
});

test('a removed overflow activity returns to a surviving activity in its day after a full refresh', async () => {
  const h = await refreshFocusHarness(), pending = deferred();
  try {
    h.focusLast(); h.monthHandler = () => pending.promise;
    const loading = h.view.loadMonth(true);
    pending.resolve(h.month(h.items.slice(0, 3))); await loading;
    assert.equal(h.w.document.activeElement.dataset.activityId, h.items[0].id);
    assert.equal(h.view.dayPopover, null);
  } finally { pending.resolve(h.month([])); h.close(); }
});

for (const overflow of [false, true]) {
  test(`a rescheduled activity is focused on its new day after full refresh (${overflow ? 'overflow' : 'visible'})`, async () => {
    const h = await refreshFocusHarness(), pending = deferred();
    const movedDeadline = Date.parse('2026-10-30T22:00:00+09:00') / 1000;
    try {
      h.focusLast(); h.monthHandler = () => pending.promise;
      const loading = h.view.loadMonth(true);
      const destination = overflow ? Array.from({ length: 5 }, (_, index) => ({ ...nespaItem, id: `activity:nespa:ds2026:${index + 20}`, deadline: movedDeadline })) : [];
      pending.resolve(h.month([...destination, ...h.items.map((item, index) => index === 7 ? { ...item, deadline: movedDeadline } : item)]));
      await loading;
      assert.equal(h.w.document.activeElement.dataset.activityId, h.items[7].id);
      assert.equal(h.w.document.activeElement.closest('[data-day-key]').dataset.dayKey, '2026-10-30');
      assert.equal(Boolean(h.view.dayPopover), overflow);
    } finally { pending.resolve(h.month([])); h.close(); }
  });
}

test("collapsing an in-flight calendar discards late results and pauses submission requests", async () => {
  const h = await harness();
  const pending = deferred();
  let statusCalls = 0;
  h.monthHandler = () => pending.promise;
  h.view.dataSource.getCourseCompletions = async () => { statusCalls++; return null; };
  h.view.dataSource.getSubmission = async () => { statusCalls++; return null; };
  h.view.collapsed = false;
  try {
    const load = h.view.loadMonth(true);
    await h.view.toggleCollapsed();
    assert.equal(h.view.loading, false);
    pending.resolve({ activities: [{ ...platoItem, courseId: 13, activityUrl: "https://plato.pusan.ac.kr/mod/assign/view.php?id=1" }],
      userScope: "42", timezone: "Asia/Seoul", fetchedAt: Date.now() });
    await load;
    assert.equal(statusCalls, 0);
    assert.equal(h.view.activities.length, 0);
    h.monthHandler = async () => ({ activities: [nespaItem], userScope: "42", timezone: "Asia/Seoul", fetchedAt: Date.now() });
    await h.view.toggleCollapsed();
    assert.equal(h.monthCalls, 2);
    assert.equal(h.view.activities[0].id, nespaItem.id);
  } finally { pending.resolve({ activities: [] }); h.close(); }
});

for (const event of ["OFF", "course change"]) {
  test(`collapsed in-flight month results are discarded after ${event}`, async () => {
    const h = await harness();
    const pending = deferred();
    h.monthHandler = () => pending.promise;
    try {
      const load = h.view.loadMonth(false);
      const oldSequence = h.view.loadSequence;
      if (event === "OFF") h.off(); else h.changeSettings();
      assert.ok(h.view.loadSequence > oldSequence);
      assert.equal(h.view.loading, false);
      assert.equal(h.view.checkingSubmissions, false);
      assert.equal(h.view.fetchedAt, 0);
      pending.resolve({ activities: [{ ...nespaItem, score: 100, submissionStatus: "제출됨", submissionCheck: "verified" }],
        userScope: "42", timezone: "Asia/Seoul", fetchedAt: Date.now(), partial: false });
      await load;
      assert.equal(h.view.activities.length, 0);
      assert.equal(h.monthCalls, 1);
      assert.equal(h.view.fetchedAt, 0);
    } finally { h.close(); }
  });
}

test("changing the selected course clears old NESPA data while retaining PLATO activities", async () => {
  const h = await harness();
  try {
    h.view.activities = [platoItem, nespaItem];
    h.changeSettings();
    await Promise.resolve();
    assert.equal(h.monthCalls, 0);
    assert.equal(h.view.activities.length, 1);
    assert.equal(h.view.activities[0].provider, "plato");
  } finally { h.close(); }
});

test("disabling calendar integration closes its detail and discards late private fields", async () => {
  const h = await harness();
  const pending = deferred();
  h.detailHandler = () => pending.promise;
  try {
    h.view.activities = [nespaItem];
    const opening = h.view.modal.open(nespaItem, false);
    assert.equal(h.view.modal.overlay.hidden, false);
    h.off();
    assert.equal(h.view.modal.overlay.hidden, true);
    pending.resolve({ ...nespaItem, submissionStatus: "제출됨", submissionCheck: "verified", score: 100 });
    await opening;
    assert.equal(h.view.modal.overlay.hidden, true);
    assert.equal(h.view.activities.length, 0);
    assert.equal(h.view.modal.activity.score, null);
    assert.doesNotMatch(h.view.modal.body.textContent, /채점점수|제출됨/);
  } finally { h.close(); }
});

test("destroy removes calendar invalidation listeners and discards pending results", async () => {
  const h = await harness();
  const pending = deferred();
  h.monthHandler = () => pending.promise;
  const load = h.view.loadMonth(false);
  h.view.destroy();
  pending.resolve({ activities: [nespaItem], userScope: "42", timezone: "Asia/Seoul", fetchedAt: Date.now(), partial: false });
  await load;
  assert.equal(h.settingsListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(h.view.activities.length, 0);
  h.close();
});

test("calendar local updates never postpone the ten-minute forced provider refresh", async () => {
  const h = await harness();
  let now = Date.now(), hidden = false;
  h.w.Date.now = () => now;
  Object.defineProperty(h.w.document, "hidden", { get: () => hidden, configurable: true });
  h.view.collapsed = false;
  try {
    await h.view.loadMonth(true);
    await Promise.resolve();
    const initialAttempt = h.view.lastRefreshAttemptAt;
    now += 9 * 60000;
    h.view.updateActivity({ ...platoItem, title: 'Local update' });
    assert.equal(h.view.lastRefreshAttemptAt, initialAttempt);
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 1);
    now += 60000;
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 2);
    assert.deepEqual(h.monthForces, [true, true]);
    hidden = true;
    now += 10 * 60000;
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 2);
    hidden = false;
    await h.view.autoRefresh();
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 3);
  } finally { h.close(); }
});

test("failed calendar refresh waits one full interval unless manually requested", async () => {
  const h = await harness();
  let now = Date.now();
  h.w.Date.now = () => now;
  Object.defineProperty(h.w.document, "hidden", { value: false, configurable: true });
  h.view.collapsed = false;
  h.monthHandler = async () => { throw new Error("offline"); };
  try {
    await h.view.loadMonth(true);
    now += 60000;
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 1);
    await h.view.loadMonth(true); // The refresh button bypasses the interval.
    assert.equal(h.monthCalls, 2);
    now += 10 * 60000;
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 3);
  } finally { h.close(); }
});

test("calendar pauses while its host pane is hidden and refreshes changed settings when restored", async () => {
  const h = await harness();
  let now = Date.now();
  h.w.Date.now = () => now;
  Object.defineProperty(h.w.document, "hidden", { value: false, configurable: true });
  h.view.collapsed = false;
  const host = h.view.root.parentElement;
  try {
    await h.view.loadMonth(true);
    host.hidden = true;
    now += 60000;
    await h.view.loadMonth(true);
    await h.view.autoRefresh();
    assert.equal(h.monthCalls, 1);
    h.changeSettings();
    await Promise.resolve();
    assert.equal(h.monthCalls, 1);
    host.hidden = false;
    h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    await Promise.resolve();
    assert.equal(h.monthCalls, 2);
  } finally { h.close(); }
});

test("hiding PLATO during a month request stops follow-up status work and refreshes on return", async () => {
  const h = await harness();
  Object.defineProperty(h.w.document, "hidden", { value: false, configurable: true });
  h.view.collapsed = false;
  const pending = deferred();
  const item = { ...platoItem, courseId: '9', activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  let details = 0;
  h.view.dataSource.getCourseCompletions = h.view.dataSource.getSubmission = async () => { details++; return null; };
  h.monthHandler = () => pending.promise;
  const host = h.view.root.parentElement;
  try {
    const loading = h.view.loadMonth(true);
    host.hidden = true;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    pending.resolve({ activities: [item], userScope: '42', timezone: 'Asia/Seoul', fetchedAt: Date.now(), partial: false });
    await loading;
    assert.equal(details, 0);
    assert.equal(h.view.loading, false);
    assert.equal(h.view.checkingSubmissions, false);
    host.hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.monthCalls, 2);
    assert.equal(details, 2);
  } finally { h.close(); }
});

test("hiding the calendar closes its detail dialog and releases the focus lock", async () => {
  const h = await harness();
  const d = h.w.document;
  try {
    h.view.collapseButton.focus();
    await h.view.modal.open(platoItem, false);
    assert.equal(h.view.modal.overlay.hidden, false);
    const host = h.view.root.parentElement;
    host.hidden = true;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    assert.equal(h.view.modal.overlay.hidden, true);
    assert.equal(d.body.classList.contains('plato-calendar-ext-modal-open'), false);
    assert.equal(Boolean(host.inert), false);
    assert.ok(!h.view.modal.overlay.contains(d.activeElement));
  } finally { h.close(); }
});

for (const outcome of ['failed', 'unavailable', 'missing entry']) {
  test(`a PLATO detail recheck clears old report completion after ${outcome}`, async () => {
    const h = await harness();
    const item = { ...platoItem, eventId: 1, courseId: '9', typeCode: 'quiz', typeLabel: '시험',
      activityUrl: 'https://plato.pusan.ac.kr/mod/quiz/view.php?id=7', completionCheck: 'verified',
      sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' } };
    h.view.dataSource.getDetail = async () => { throw new Error('offline'); };
    h.view.dataSource.getCourseCompletions = async () => ({ entries: {}, check: outcome === 'missing entry' ? 'verified' : outcome, checkedAt: 1234 });
    try {
      h.view.activities = [item];
      await h.view.modal.open(item, true);
      assert.equal(h.view.activities[0].sourceStatus.code, 'unknown');
      assert.equal(h.view.activities[0].completionCheck, outcome === 'failed' ? 'failed' : 'unavailable');
      assert.equal(h.view.modal.activity.completionCheck, h.view.activities[0].completionCheck);
      assert.doesNotMatch(h.view.modal.body.textContent, /PLATO에서 완료 확인/);
      assert.equal(h.view.modal.manualCompleted, true);
      assert.equal(h.w.PlatoCalendarExt.calendarModel.classifyActivity(h.view.activities[0], false, deadline + 1, 48).code, 'unknown');
    } finally { h.close(); }
  });
}

test('a failed assignment recheck clears old completion from its own activity page', async () => {
  const h = await harness();
  const item = { ...platoItem, eventId: 1, courseId: '9', typeCode: 'assign',
    activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7', completionCheck: 'verified', submissionStatus: '제출 완료',
    sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 상태' } };
  h.view.dataSource.getDetail = async () => null;
  h.view.dataSource.getSubmission = async () => ({ submissionStatus: null, submissionCheck: 'failed', submissionCheckedAt: 1234 });
  h.view.dataSource.getCourseCompletions = async () => ({ entries: {}, check: 'failed', checkedAt: 1234 });
  try {
    h.view.activities = [item];
    const result = await h.view.loadActivityDetail(item);
    assert.equal(result.sourceStatus.code, 'unknown');
    assert.equal(result.completionCheck, 'failed');
    assert.equal(result.submissionStatus, null);
    assert.equal(h.w.PlatoCalendarExt.calendarModel.classifyActivity(result, false, deadline + 1, 48).code, 'unknown');
  } finally { h.close(); }
});

test('a new verified activity completion survives an unavailable course report in either response order', async () => {
  for (const reportFirst of [true, false]) {
    const h = await harness();
    const item = { ...platoItem, courseId: '9', typeCode: 'assign',
      activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7', completionCheck: 'verified',
      sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' } };
    const report = deferred(), submission = deferred();
    h.view.dataSource.getCourseCompletions = () => report.promise;
    h.view.dataSource.getSubmission = () => submission.promise;
    try {
      h.view.activities = [item];
      const refresh = h.view.refreshSubmissions(h.view.loadSequence, true);
      const finishReport = () => report.resolve({ entries: {}, check: 'failed', checkedAt: 1234 });
      const finishSubmission = () => submission.resolve({ submissionStatus: null, submissionCheck: 'unavailable', completionCheck: 'verified',
        sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 상태' } });
      if (reportFirst) { finishReport(); await new Promise(resolve => setImmediate(resolve)); finishSubmission(); }
      else { finishSubmission(); await new Promise(resolve => setImmediate(resolve)); finishReport(); }
      await refresh;
      assert.equal(h.view.activities[0].sourceStatus.source, 'PLATO 활동 상태');
      assert.equal(h.view.activities[0].completionCheck, 'verified');
    } finally { report.resolve(null); submission.resolve(null); h.close(); }
  }
});

test('refreshing a cached PLATO month cannot retain old report completion after a failed report', async () => {
  const h = await harness();
  const item = { ...platoItem, courseId: '9', typeCode: 'quiz', completionCheck: 'verified',
    activityUrl: 'https://plato.pusan.ac.kr/mod/quiz/view.php?id=7',
    sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' } };
  h.view.dataSource.getCourseCompletions = async () => ({ entries: {}, check: 'failed', checkedAt: 1234 });
  try {
    h.view.activities = [item];
    await h.view.refreshSubmissions(h.view.loadSequence, true);
    assert.equal(h.view.activities[0].sourceStatus.code, 'unknown');
    assert.equal(h.view.activities[0].completionCheck, 'failed');
  } finally { h.close(); }
});

test('a PLATO account change closes old detail and ignores its late completion response', async () => {
  const h = await harness();
  const pending = deferred();
  const item = { ...platoItem, courseId: '9', eventId: 1, activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
  h.view.dataSource.getDetail = () => pending.promise;
  h.monthHandler = async () => ({ activities: [{ ...platoItem, title: 'New account task' }], userScope: '202',
    timezone: 'Asia/Seoul', fetchedAt: Date.now(), partial: false });
  try {
    h.view.userScope = '101';
    h.view.manualCompletions = { [item.id]: true };
    h.view.activities = [item];
    const opening = h.view.modal.open(item, true);
    await h.view.loadMonth(true);
    assert.equal(h.view.modal.overlay.hidden, true);
    assert.equal(h.view.userScope, '202');
    assert.equal(Object.keys(h.view.manualCompletions).length, 0);
    pending.resolve({ name: 'Old account detail', completed: true });
    await opening;
    assert.equal(h.view.modal.overlay.hidden, true);
    assert.equal(h.view.activities[0].title, 'New account task');
    assert.equal(h.view.activities[0].sourceStatus?.code, undefined);
  } finally { pending.resolve(null); h.close(); }
});

function crowdedDay(h) {
  h.view.collapsed = false;
  h.view.applyCollapsedState();
  h.view.activities = Array.from({ length: 5 }, (_, index) => ({ ...nespaItem, problemId: String(index + 1),
    id: `activity:nespa:ds2026:${index + 1}`, title: `Task ${index + 1}` }));
  h.view.render();
  const more = h.view.root.querySelector('.plato-calendar-ext-more-button');
  more.focus(); more.click();
  return more;
}

test('an open day list preserves its activity focus, scroll and fresh data during calendar updates', async () => {
  const h = await harness();
  try {
    crowdedDay(h);
    const item = h.view.activities[4];
    const button = [...h.view.dayPopover.node.querySelectorAll('[data-activity-id]')].find(node => node.dataset.activityId === item.id);
    button.focus(); h.view.dayPopover.node.scrollTop = 80;
    h.view.updateActivity({ ...item, title: 'Updated fifth task' });
    assert.ok(h.view.dayPopover);
    assert.equal(h.w.document.activeElement.dataset.activityId, item.id);
    assert.match(h.w.document.activeElement.textContent, /Updated fifth task/);
    assert.equal(h.view.dayPopover.node.scrollTop, 80);
    assert.equal(h.view.dayPopover.trigger.getAttribute('aria-controls'), h.view.dayPopover.node.id);
  } finally { h.close(); }
});

test('calendar repaint keeps the day-list close control usable by keyboard', async () => {
  const h = await harness();
  try {
    crowdedDay(h);
    h.view.render();
    assert.ok(h.view.dayPopover);
    assert.equal(h.w.document.activeElement.getAttribute('aria-label'), '날짜별 활동 목록 닫기');
    await new Promise(resolve => h.w.setTimeout(resolve, 0));
    h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(h.view.dayPopover, null);
    assert.equal(h.w.document.activeElement.classList.contains('plato-calendar-ext-more-button'), true);
    assert.equal(h.w.document.activeElement.getAttribute('aria-expanded'), 'false');
  } finally { h.close(); }
});

test('keeping a day list open does not steal focus from the toolbar or its own trigger', async () => {
  const h = await harness();
  try {
    crowdedDay(h);
    h.view.refreshButton.focus(); h.view.render();
    assert.ok(h.view.dayPopover);
    assert.equal(h.w.document.activeElement, h.view.refreshButton);
    h.view.dayPopover.trigger.focus(); h.view.render();
    assert.ok(h.view.dayPopover);
    assert.equal(h.w.document.activeElement, h.view.dayPopover.trigger);
  } finally { h.close(); }
});

test('closing detail for an overflow activity reopens its day list and restores that activity', async () => {
  const h = await harness();
  try {
    crowdedDay(h);
    const id = h.view.activities[4].id;
    const button = [...h.view.dayPopover.node.querySelectorAll('[data-activity-id]')].find(node => node.dataset.activityId === id);
    button.focus(); button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.view.modal.overlay.hidden, false);
    h.view.modal.close();
    assert.ok(h.view.dayPopover);
    assert.equal(h.w.document.activeElement.dataset.activityId, id);
    assert.ok(h.view.dayPopover.node.contains(h.w.document.activeElement));
  } finally { h.close(); }
});

test('removing day overflow returns close-control focus to the remaining activity in that day', async () => {
  const h = await harness();
  try {
    crowdedDay(h);
    h.view.activities = h.view.activities.slice(0, 2);
    h.view.render();
    assert.equal(h.view.dayPopover, null);
    assert.equal(h.w.document.activeElement.dataset.activityId, h.view.activities[0].id);
  } finally { h.close(); }
});

for (const provider of ['nespa', 'plato']) {
  test(`a reopened ${provider} detail cannot be overwritten by its earlier closed dialog response`, async () => {
    const h = await harness(), pending = deferred();
    const item = provider === 'nespa' ? nespaItem : { ...platoItem, eventId: 1, courseId: '9', typeCode: 'assign',
      activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=7' };
    let calls = 0, submissions = 0;
    if (provider === 'nespa') h.detailHandler = activity => ++calls === 1 ? pending.promise : Promise.resolve({ ...activity, title: 'Latest detail', score: 50 });
    else {
      h.view.dataSource.getDetail = () => ++calls === 1 ? pending.promise : Promise.resolve({ name: 'Latest detail' });
      h.view.dataSource.getSubmission = async () => { submissions++; return { submissionStatus: '미제출', submissionCheck: 'verified' }; };
    }
    try {
      h.view.activities = [item];
      const old = h.view.modal.open(item, false);
      h.view.modal.close();
      await h.view.modal.open(item, false);
      assert.equal(h.view.activities[0].title, 'Latest detail');
      pending.resolve(provider === 'nespa' ? { ...item, title: 'Obsolete detail', score: 100 } : { name: 'Obsolete detail', completed: true });
      await old;
      assert.equal(h.view.activities[0].title, 'Latest detail');
      assert.equal(h.view.modal.activity.title, 'Latest detail');
      if (provider === 'nespa') assert.equal(h.view.modal.activity.score, 50);
      else assert.equal(submissions, 1, 'old event responses must not start follow-up status reads');
    } finally { pending.resolve(null); h.close(); }
  });
}

test('observed NESPA expiry clears all visible personal fields and the open dialog while preserving PLATO', async () => {
  const h = await harness();
  const personal = { ...nespaItem, submissionStatus: '제출됨', submissionCheck: 'verified', score: 100, attempts: 3 };
  try {
    h.view.activities = [{ ...platoItem, submissionStatus: '제출 완료' }, personal,
      { ...personal, id: 'activity:nespa:ds2026:99', problemId: '99' }];
    h.view.providerNotes = ['NESPA 연동됨', 'PLATO note'];
    await h.view.modal.open(personal, false);
    h.privateListeners.forEach(listener => listener('auth-required'));
    const nespa = h.view.activities.filter(item => item.provider === 'nespa');
    assert.ok(nespa.every(item => item.score === null && item.attempts === null && item.submissionStatus === '확인 필요'));
    assert.equal(h.view.modal.activity.score, null);
    assert.equal(h.view.modal.activity.attempts, null);
    assert.match(h.view.modal.feedback.textContent, /직접 로그인/);
    assert.doesNotMatch(h.view.modal.body.textContent, /최고 채점점수|제출됨/);
    assert.equal(h.view.activities.find(item => item.provider === 'plato').submissionStatus, '제출 완료');
    assert.ok(h.view.providerNotes.includes('PLATO note'));
    assert.ok(h.view.providerNotes.some(note => note.includes('직접 로그인')));
    h.view.destroy();
    assert.equal(h.privateListeners.size, 0);
  } finally { h.close(); }
});
