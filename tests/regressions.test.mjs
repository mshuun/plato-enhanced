import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const source = async (name) => readFile(new URL(`src/${name}.js`, root), 'utf8');
async function setup(modules = []) {
  const dom = new JSDOM('<!doctype html><body><button id="before">before</button><div id="anchor"></div></body>', {
    url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  for (const name of ['config', 'plato-parser', 'submission-parser', 'calendar-model', ...modules]) dom.window.eval(await source(name));
  return dom;
}
const now = Date.parse('2026-09-07T12:00:00+09:00') / 1000;
const event = { id: 1, name: 'Assignment', eventtype: 'due', modulename: 'assign', timestart: now + 3600,
  url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=20', course: { id: 3, fullname: 'Course' } };

test('normalization rejects null/zero instance non-module events and missing deadlines', async () => {
  const dom = await setup();
  try {
    const p = dom.window.PlatoCalendarExt.parser;
    for (const instance of [null, 0, '', undefined]) {
      assert.equal(p.normalizeMonthPayload({ month: { events: [{ id: 8, name: 'Personal event', instance, timestart: now }] } }).length, 0);
    }
    assert.equal(p.normalizeMonthPayload({ month: { days: [{ timestamp: now, events: [{ ...event, timestart: undefined }] }] } }).length, 0);
    assert.equal(p.normalizeMonthPayload({ month: { events: [{ ...event, timesort: 0 }] } })[0].deadline, event.timestart);
  } finally { dom.window.close(); }
});

test('submitted assignments stay submitted before and after their deadline', async () => {
  const dom = await setup();
  try {
    const n = dom.window.PlatoCalendarExt;
    for (const deadline of [now - 3600, now + 3600]) {
      const a = n.parser.normalizeMonthPayload({ month: { events: [{ ...event, timestart: deadline, submitted: true }] } })[0];
      assert.equal(n.calendarModel.classifyActivity(a, false, now, 48).code, 'submitted');
    }
    const a = n.parser.normalizeMonthPayload({ month: { events: [{ ...event, completed: true }] }, action: { events: [{ ...event, overdue: true }] } })[0];
    assert.equal(a.sourceStatus.code, 'completed');
  } finally { dom.window.close(); }
});

test('detail keeps a module link and updates deadline without erasing existing submission', async () => {
  const dom = await setup();
  try {
    const p = dom.window.PlatoCalendarExt.parser;
    const a = p.normalizeMonthPayload({ month: { events: [{ ...event, submitted: true }] } })[0];
    const detail = p.mergeDetail(a, { event: { id: 1, viewurl: '/calendar/view.php?view=day', timestart: now + 86400 } });
    assert.equal(detail.activityUrl, event.url);
    assert.equal(detail.deadline, now + 86400);
    assert.equal(detail.submissionStatus, '제출 완료');
  } finally { dom.window.close(); }
});

test('submission parser reads only current status evidence, including Korean and English', async () => {
  const dom = await setup();
  try {
    const p = dom.window.PlatoCalendarExt.submissionParser;
    const fixtures = [
      ['<div class="submissionstatustable"><table><tr><th>Submission status</th><td class="submissionstatussubmitted">Submitted for grading</td></tr></table></div>', '제출 완료'],
      ['<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>제출 완료</td></tr></table></div>', '제출 완료'],
      ['<div class="submissionstatustable"><div class="submissionstatusdraft">Draft (not submitted)</div></div>', '초안 저장'],
      ['<div class="submissionstatustable"><div class="submissionstatusreopened">Reopened</div></div>', '재제출 필요'],
      ['<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>미제출</td></tr></table></div>', '미제출'],
      ['<div class="description">제출 완료</div><div class="submissionhistory"><td class="submissionstatussubmitted">Submitted</td></div>', null],
      ['<div class="submissionstatustable"><div class="submissionstatussubmitted">Submitted for grading<div>Members still need to submit</div></div></div>', null],
      ['<div class="submissionstatustable"><div class="submissionstatusdraft">Draft</div><div class="submissionstatussubmitted">Submitted</div></div>', null],
      ['<form action="/login/index.php"><input name="password"></form>', null]
    ];
    for (const [html, expected] of fixtures) assert.equal(p.parse(html), expected, html);
    assert.equal(p.parse('<div id="intro"><div class="submissionstatustable"><div class="submissionstatussubmitted">Submitted</div></div></div>'), null);
    assert.equal(p.assignmentUrl('/mod/assign/view.php?id=20&action=editsubmission&userid=7'), event.url);
    assert.equal(p.assignmentUrl('https://other.example/mod/assign/view.php?id=20'), null);
  } finally { dom.window.close(); }
});

test('today uses the same timezone as deadline grouping at a day boundary', async () => {
  const dom = await setup();
  try {
    dom.window.Date.now = () => Date.parse('2026-09-07T16:00:00Z');
    const model = dom.window.PlatoCalendarExt.calendarModel;
    assert.equal(model.getMonthGrid(2026, 9, 'Asia/Seoul').find((day) => day.isToday).key, '2026-09-08');
    assert.equal(model.getMonthGrid(2026, 9, 'America/Los_Angeles').find((day) => day.isToday).key, '2026-09-07');
  } finally { dom.window.close(); }
});

test('optional timeline timeout cannot discard a successful month', async () => {
  const dom = await setup(['data-source']);
  try {
    const w = dom.window;
    const nativeTimeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, delay) => nativeTimeout(fn, delay === 4000 ? 10 : delay);
    w.M = { cfg: { userId: 7 } };
    w.require = (names, resolve) => resolve(names[0] === 'core_calendar/repository'
      ? { getCalendarMonthData: async () => ({ events: [event] }) }
      : { queryByTime: () => new Promise(() => {}) });
    w.eval(await source('page-bridge'));
    const ds = new w.PlatoCalendarExt.PlatoDataSource();
    const month = await ds.getMonth(2026, 9, true);
    assert.equal(month.activities.length, 1);
    assert.equal(month.partial, true);
    ds.destroy();
  } finally { dom.window.close(); }
});

test('submission fetching has bounded failure, strips write parameters and deduplicates requests', async () => {
  const dom = await setup(['data-source']);
  try {
    const w = dom.window;
    let count = 0;
    w.fetch = async (url, options) => {
      count++;
      assert.equal(url, event.url);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      return { ok: true, url, text: async () => '<div class="submissionstatustable"><div class="submissionstatussubmitted">Submitted for grading</div></div>' };
    };
    const ds = new w.PlatoCalendarExt.PlatoDataSource();
    const item = { activityUrl: event.url + '&action=editsubmission' };
    const [a, b] = await Promise.all([ds.getSubmission(item), ds.getSubmission(item)]);
    assert.equal(count, 1);
    assert.equal(a.submissionStatus, '제출 완료');
    assert.equal(b.submissionCheck, 'verified');
    w.fetch = async () => { throw new Error('offline'); };
    assert.equal((await ds.getSubmission(item, true)).submissionCheck, 'failed');
    ds.destroy();
  } finally { dom.window.close(); }
});

test('month cache expires and detail updates are reflected in cached activities', async () => {
  const dom = await setup(['data-source']);
  try {
    const w = dom.window;
    let clock = 1000000;
    w.Date.now = () => clock;
    const ds = new w.PlatoCalendarExt.PlatoDataSource();
    let calls = 0;
    ds.request = async () => { calls++; return { month: { events: [event] }, context: { userId: 7 } }; };
    const first = await ds.getMonth(2026, 9);
    ds.updateActivity({ ...first.activities[0], submissionStatus: '제출 완료' });
    assert.equal((await ds.getMonth(2026, 9)).activities[0].submissionStatus, '제출 완료');
    assert.equal(calls, 1);
    clock += 599999;
    await ds.getMonth(2026, 9);
    assert.equal(calls, 1);
    clock += 1;
    await ds.getMonth(2026, 9);
    assert.equal(calls, 2);
    await ds.getMonth(2026, 9, true);
    assert.equal(calls, 3);
    ds.destroy();
  } finally { dom.window.close(); }
});

test('calendar integrates submission results, hides collapsed content, and restores modal focus', async () => {
  const dom = await setup(['activity-modal', 'calendar-view']);
  const w = dom.window;
  let view;
  try {
    const style = w.document.createElement('style');
    style.textContent = await readFile(new URL('styles/calendar.css', root), 'utf8');
    w.document.head.append(style);
    const n = w.PlatoCalendarExt;
    const item = n.parser.normalizeMonthPayload({ month: { events: [{ ...event, timestart: Date.now() / 1000 + 3600 }] } })[0];
    let cached;
    n.storage = { getCollapsed: async () => false, setCollapsed: async () => {}, getManualCompletions: async () => ({}), subscribe: () => () => {} };
    n.PlatoDataSource = class {
      getContext() { return Promise.resolve({ timezone: 'Asia/Seoul' }); }
      getMonth() { return Promise.resolve({ activities: [item], timezone: 'Asia/Seoul', userScope: '7', fetchedAt: Date.now() }); }
      getSubmission() { return Promise.resolve({ submissionStatus: '제출 완료', submissionCheck: 'verified', submissionCheckedAt: Date.now() }); }
      getCourseCompletions() { return Promise.resolve({ entries: {}, check: 'verified', checkedAt: Date.now() }); }
      getDetail() { return Promise.resolve({ event: { id: 1, timestart: item.deadline + 86400, viewurl: '/calendar/view.php' } }); }
      updateActivity(a) { cached = a; }
      destroy() {}
    };
    view = new n.CalendarView();
    await view.mount(w.document.getElementById('anchor'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.activities[0].submissionStatus, '제출 완료');
    assert.equal(cached.submissionStatus, '제출 완료');
    assert.equal(view.calendar.querySelectorAll('[role="row"]').length, 7);
    await view.toggleCollapsed();
    assert.equal(w.getComputedStyle(view.content).display, 'none');
    assert.equal(w.getComputedStyle(view.countBadge).display, 'none');
    await view.toggleCollapsed();
    const button = view.root.querySelector('[data-activity-id]');
    button.focus();
    await view.modal.open(view.activities[0], false);
    assert.equal(view.activities[0].deadline, item.deadline + 86400);
    assert.equal(view.activities[0].activityUrl, event.url);
    assert.equal(w.document.activeElement, view.modal.closeButton);
    view.modal.dialog.focus();
    const key = new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    view.modal.onKeydown(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(w.document.activeElement, view.modal.openLink);
    view.modal.close();
    assert.equal(w.document.activeElement.dataset.activityId, item.id);
    assert.notEqual(view.root.inert, true);
  } finally { view?.destroy(); w.close(); }
});
