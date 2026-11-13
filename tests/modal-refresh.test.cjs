const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const INTERVAL = 10 * 60 * 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = { id: 'calendar:1', eventId: 1, provider: 'plato', title: 'Example', courseName: 'Course', typeCode: 'assign',
  typeLabel: '과제', deadline: 1800000900, activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=1' };
const nespa = { ...item, id: 'activity:nespa:ds2026:13', eventId: null, provider: 'nespa', score: null,
  activityUrl: 'https://emerald.pusan.ac.kr/ds2026/submission_detail/?prob_id=13',
  problemUrl: 'https://emerald.pusan.ac.kr/media/ds2026/assignment/documents/example.pdf' };

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness() {
  const dom = new JSDOM('<!doctype html><body><button id="outside">Open</button></body>', {
    url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const state = { now: 1800000000000, hidden: false, calls: 0, timers: new Map(), nextTimer: 1 };
  w.Date.now = () => state.now;
  Object.defineProperty(w.document, 'hidden', { get: () => state.hidden });
  w.setTimeout = (callback, delay) => { const id = state.nextTimer++; state.timers.set(id, { callback, due: state.now + delay }); return id; };
  w.clearTimeout = id => state.timers.delete(id);
  for (const file of ['config.js', 'plato-parser.js', 'submission-parser.js', 'nespa-parser.js', 'calendar-model.js', 'activity-modal.js']) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  }
  state.handler = async activity => ({ ...activity, submissionStatus: '제출 완료', score: state.calls });
  state.save = async (_activity, completed) => completed;
  const modal = new w.PlatoCalendarExt.ActivityModal({ timezone: 'Asia/Seoul', canSaveManual: () => true,
    loadDetail(activity) { state.calls += 1; return state.handler(activity); },
    onToggleManual(activity, completed) { return state.save(activity, completed); } });
  state.modal = modal; state.w = w;
  state.advance = async duration => {
    state.now += duration;
    for (let rounds = 0; rounds < 10; rounds += 1) {
      const due = [...state.timers.entries()].filter(([, value]) => value.due <= state.now);
      if (!due.length) return;
      for (const [id, task] of due) { state.timers.delete(id); await task.callback(); }
    }
    throw new Error('Modal timer loop');
  };
  state.visible = async visible => { state.hidden = !visible; w.document.dispatchEvent(new w.Event('visibilitychange')); await tick(); };
  state.close = () => { modal.destroy(); w.close(); };
  return state;
}

function detailFields(modal) {
  return Object.fromEntries([...modal.body.querySelectorAll('.plato-calendar-ext-detail-row')]
    .map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
}

for (const attempts of [null, 1]) {
  test(`partial NESPA detail explains uncertain history while retaining ${attempts === null ? 'unknown' : 'verified'} attempt count`, async () => {
    const h = harness();
    h.handler = async activity => ({ ...activity, submissionStatus: '제출됨', submissionCheck: 'verified', score: null, attempts, detailPartial: true });
    try {
      await h.modal.open(nespa, false);
      const fields = detailFields(h.modal);
      assert.equal(fields['제출 여부'], '제출됨'); assert.equal(fields['확인된 제출 횟수'], attempts === null ? '확인 불가' : '1회');
      assert.equal(fields['최고 채점점수'], undefined);
      assert.match(h.modal.feedback.textContent, /일부 제출 내역/);
      h.handler = async activity => ({ ...activity, score: 80, attempts: 2, detailPartial: false });
      await h.modal.refreshDetail();
      assert.equal(h.modal.feedback.textContent, ''); assert.equal(detailFields(h.modal)['최고 채점점수'], '80');
    } finally { h.close(); }
  });
}

test('a course-backed activity without an event number refreshes periodically and keeps manual completion', async () => {
  const h = harness();
  const quiz = { ...item, id: 'activity:9:quiz:7', eventId: null, courseId: '9', typeCode: 'quiz',
    activityUrl: 'https://plato.pusan.ac.kr/mod/quiz/view.php?id=7' };
  try {
    await h.modal.open(quiz, true);
    assert.equal(h.calls, 1); assert.equal(h.modal.refreshButton.hidden, false);
    await h.advance(INTERVAL);
    assert.equal(h.calls, 2); assert.equal(h.modal.manualCompleted, true);
    assert.equal(h.modal.overlay.hidden, false);
  } finally { h.close(); }
});

for (const courseId of [null, '0', '9&id=10', 'unknown']) {
  test(`an activity without a usable event, assignment or course key stays non-refreshable: ${courseId}`, async () => {
    const h = harness();
    try {
      await h.modal.open({ ...item, eventId: null, typeCode: 'quiz', courseId }, false);
      assert.equal(h.calls, 0); assert.equal(h.modal.refreshButton.hidden, true);
      await h.advance(INTERVAL);
      assert.equal(h.calls, 0);
    } finally { h.close(); }
  });
}

test('visible modal detail refresh recovers after the system clock moves backwards', async () => {
  const h = harness();
  try {
    await h.modal.open(item, false);
    await h.visible(false); h.now -= 3600000;
    await h.visible(true);
    assert.equal(h.calls, 2);
  } finally { h.close(); }
});

test('modal scheduling cannot postpone a refresh for an extra hour after clock rollback', async () => {
  const h = harness();
  try {
    await h.modal.open(item, false);
    h.now -= 3600000; h.modal.scheduleDetailRefresh();
    assert.ok([...h.timers.values()].every(timer => timer.due <= h.now + INTERVAL));
    await h.advance(0); assert.equal(h.calls, 2);
  } finally { h.close(); }
});

test('NESPA detail shows original assignment limits, start date and verified zero attempts', async () => {
  const h = harness();
  h.handler = async activity => activity;
  const startTime = Date.parse('2026-10-29T00:00:00+09:00') / 1000;
  try {
    await h.modal.open({ ...nespa, startTime, submissionCheck: 'verified', attempts: 0, score: 0,
      assignmentInfo: { maxSize: '16 KB', tokenSize: '0', timeout: '1.0 sec', maxTry: '0', evaluation: 'Sum' } }, false);
    const fields = detailFields(h.modal);
    assert.equal(fields['시작일'], new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).format(new Date(startTime * 1000)));
    assert.equal(fields['파일 크기 제한'], '16 KB');
    assert.equal(fields['토큰 제한'], '0');
    assert.equal(fields['실행시간 제한'], '1.0 sec');
    assert.equal(fields['최대 제출 횟수'], '0');
    assert.equal(fields['평가 방식'], 'Sum');
    assert.equal(fields['확인된 제출 횟수'], '0회');
    assert.equal(fields['최고 채점점수'], '0');
    assert.equal(h.modal.manualButton.hidden, true);
  } finally { h.close(); }
});

test('legacy or partial NESPA metadata shows explicit missing fields without stale personal counts', async () => {
  const h = harness();
  h.handler = async activity => activity;
  try {
    await h.modal.open({ ...nespa, startTime: null, attempts: 9, submissionCheck: 'unavailable' }, false);
    let fields = detailFields(h.modal);
    for (const name of ['파일 크기 제한', '토큰 제한', '실행시간 제한', '최대 제출 횟수', '평가 방식']) assert.equal(fields[name], '정보 없음');
    assert.equal(fields['시작일'], '확인 불가');
    assert.equal(fields['확인된 제출 횟수'], '확인 불가');
    h.modal.activity.assignmentInfo = { maxSize: '4096', tokenSize: null, timeout: '', maxTry: '  ', evaluation: 'Last' };
    h.modal.render(); fields = detailFields(h.modal);
    assert.equal(fields['파일 크기 제한'], '4096'); // No inferred bytes or KB suffix.
    assert.equal(fields['토큰 제한'], '정보 없음');
    assert.equal(fields['실행시간 제한'], '정보 없음');
    assert.equal(fields['최대 제출 횟수'], '정보 없음');
    assert.equal(fields['평가 방식'], 'Last');
  } finally { h.close(); }
});

test('NESPA metadata refresh updates the existing dialog and keeps the new limits visible', async () => {
  const h = harness();
  h.handler = async activity => activity;
  try {
    await h.modal.open(nespa, false);
    const dialog = h.modal.dialog;
    h.handler = async activity => ({ ...activity, startTime: 1793199600, submissionCheck: 'verified', attempts: 3,
      assignmentInfo: { maxSize: '2048 bytes', tokenSize: '1500', timeout: '0.5', maxTry: '20', evaluation: 'Max' } });
    await h.advance(INTERVAL);
    assert.equal(h.modal.dialog, dialog);
    assert.equal(h.modal.overlay.hidden, false);
    const fields = detailFields(h.modal);
    assert.equal(fields['토큰 제한'], '1500');
    assert.equal(fields['실행시간 제한'], '0.5');
    assert.equal(fields['확인된 제출 횟수'], '3회');
    assert.notEqual(fields['시작일'], '확인 불가');
  } finally { h.close(); }
});

test('PLATO detail does not gain NESPA constraint fields or lose manual completion controls', async () => {
  const h = harness();
  try {
    await h.modal.open({ ...item, startTime: 1793199600, attempts: 0,
      assignmentInfo: { tokenSize: '999' } }, true);
    const fields = detailFields(h.modal);
    for (const name of ['시작일', '파일 크기 제한', '토큰 제한', '실행시간 제한', '최대 제출 횟수', '평가 방식', '확인된 제출 횟수']) assert.equal(fields[name], undefined);
    assert.equal(h.modal.manualButton.hidden, false);
    assert.equal(h.modal.manualButton.textContent, '수동 완료 취소');
    assert.equal(h.modal.openLink.href, item.activityUrl);
  } finally { h.close(); }
});

test('PLATO detail keeps draft and reopened submissions visible when activity completion says completed', async () => {
  const h = harness();
  h.handler = async activity => activity;
  try {
    for (const submissionStatus of ['초안 저장', '재제출 필요', '미제출']) {
      h.now = 1800000000000;
      await h.modal.open({ ...item, submissionStatus, submissionCheck: 'verified',
        sourceStatus: { code: 'completed', label: 'PLATO에서 완료 확인', source: 'PLATO 활동 현황' } }, false);
      let fields = detailFields(h.modal);
      assert.match(fields['현재 상태'], new RegExp(submissionStatus));
      assert.match(fields['현재 상태'], /마감 임박/);
      assert.equal(fields['제출 여부'], submissionStatus);
      h.now = (item.deadline + 1) * 1000;
      h.modal.render();
      fields = detailFields(h.modal);
      assert.match(fields['현재 상태'], new RegExp(submissionStatus));
      assert.match(fields['현재 상태'], /마감됨/);
      assert.equal(h.modal.body.querySelector('.plato-calendar-ext-detail-status-finished-past'), null);
    }
  } finally { h.close(); }
});

test('open detail refreshes periodically and manually in the same dialog with manual state intact', async () => {
  const h = harness();
  try {
    await h.modal.open(item, true);
    const dialog = h.modal.dialog;
    h.modal.openLink.focus();
    await h.advance(INTERVAL - 1);
    assert.equal(h.calls, 1);
    await h.advance(1);
    assert.equal(h.calls, 2);
    assert.equal(h.modal.dialog, dialog);
    assert.equal(h.modal.overlay.hidden, false);
    assert.equal(h.modal.manualCompleted, true);
    assert.equal(h.w.document.activeElement, h.modal.openLink);
    h.modal.refreshButton.click(); await tick();
    assert.equal(h.calls, 3);
    assert.equal(h.modal.manualCompleted, true);
    assert.equal(h.modal.refreshButton.textContent, '상태 새로고침');
  } finally { h.close(); }
});

test('periodic detail refresh preserves focus on recreated NESPA links', async () => {
  const h = harness();
  try {
    await h.modal.open(nespa, false);
    const oldLink = h.modal.extraLinks.querySelector('a');
    oldLink.focus();
    await h.advance(INTERVAL);
    assert.equal(oldLink.isConnected, false);
    assert.equal(h.w.document.activeElement.href, nespa.problemUrl);
    assert.equal(h.modal.activity.score, 2);
  } finally { h.close(); }
});

test('hidden open dialogs defer periodic requests and refresh when visible again', async () => {
  const h = harness();
  try {
    await h.modal.open(item, false);
    await h.visible(false);
    await h.advance(INTERVAL * 2);
    assert.equal(h.calls, 1);
    await h.visible(true);
    assert.equal(h.calls, 2);
    await h.visible(true);
    assert.equal(h.calls, 2);
    assert.equal(h.modal.overlay.hidden, false);
  } finally { h.close(); }
});

test('detail refresh waits for manual saving and keeps the saved completion', async () => {
  const h = harness(); const saving = deferred();
  try {
    await h.modal.open(item, false);
    h.save = () => saving.promise;
    h.modal.manualButton.click();
    assert.equal(h.modal.saving, true);
    await h.advance(INTERVAL);
    assert.equal(h.calls, 1);
    assert.equal(h.modal.refreshButton.disabled, true);
    saving.resolve(true); await tick();
    await h.advance(0);
    assert.equal(h.calls, 2);
    assert.equal(h.modal.manualCompleted, true);
  } finally { h.close(); }
});

for (const outcome of ['saved', 'failed']) {
  test(`manual ${outcome} does not steal focus moved to another dialog control`, async () => {
    const h = harness(), saving = deferred();
    h.save = () => saving.promise;
    try {
      await h.modal.open(item, false);
      h.modal.manualButton.focus(); h.modal.manualButton.click();
      h.modal.closeButton.focus();
      saving.resolve(outcome === 'saved' ? true : Promise.reject(new Error('WRITE_FAILED')));
      await tick();
      assert.equal(h.w.document.activeElement, h.modal.closeButton);
      assert.equal(h.modal.manualButton.disabled, false);
      assert.equal(h.modal.manualCompleted, outcome === 'saved');
      assert.equal(h.modal.feedback.textContent.includes('저장하지 못했습니다'), outcome === 'failed');
    } finally { saving.resolve(false); h.close(); }
  });
}

test('manual saving restores its button after disabling it has blurred focus into the document', async () => {
  const h = harness(), saving = deferred();
  h.save = () => saving.promise;
  try {
    await h.modal.open(item, false);
    h.modal.manualButton.focus(); h.modal.manualButton.click();
    // JSDOM keeps a disabled button focused; emulate Chromium's focus loss.
    h.w.document.body.tabIndex = -1; h.w.document.body.focus();
    assert.equal(h.w.document.activeElement, h.w.document.body);
    saving.resolve(true); await tick();
    assert.equal(h.w.document.activeElement, h.modal.manualButton);
    assert.equal(h.modal.manualCompleted, true);
  } finally { saving.resolve(false); h.close(); }
});

test('a finished manual save cannot move focus after the user closes the dialog', async () => {
  const h = harness(), saving = deferred();
  h.save = () => saving.promise;
  try {
    h.w.document.querySelector('#outside').focus();
    await h.modal.open(item, false);
    h.modal.manualButton.click(); h.modal.close();
    saving.resolve(true); await tick();
    assert.equal(h.w.document.activeElement.id, 'outside');
    assert.equal(h.modal.overlay.hidden, true);
  } finally { saving.resolve(false); h.close(); }
});

test('loading coalesces refresh requests and failures wait one interval unless manually retried', async () => {
  const h = harness(); const pending = deferred();
  try {
    h.handler = () => pending.promise;
    const opening = h.modal.open(item, false);
    h.modal.refreshButton.click();
    await h.modal.autoRefreshDetail();
    assert.equal(h.calls, 1);
    pending.resolve(item); await opening;
    h.handler = async () => { throw new Error('network'); };
    await h.advance(INTERVAL);
    assert.equal(h.calls, 2);
    assert.match(h.modal.feedback.textContent, /새로고침/);
    await h.advance(INTERVAL - 1);
    assert.equal(h.calls, 2);
    h.handler = async activity => ({ ...activity, score: 50 });
    h.modal.refreshButton.click(); await tick();
    assert.equal(h.calls, 3);
    assert.equal(h.modal.activity.score, 50);
  } finally { h.close(); }
});

for (const action of ['close', 'destroy', 'new activity']) {
  test(`late detail response is ignored after ${action}`, async () => {
    const h = harness(); const pending = deferred();
    try {
      h.handler = () => pending.promise;
      const opening = h.modal.open(nespa, false);
      if (action === 'new activity') {
        h.handler = async activity => activity;
        await h.modal.open({ ...item, id: 'calendar:2', title: 'Second' }, true);
      } else h.modal[action]();
      pending.resolve({ ...nespa, title: 'Obsolete private result', score: 100 });
      await opening;
      assert.notEqual(h.modal.activity.title, 'Obsolete private result');
      if (action === 'new activity') {
        assert.equal(h.modal.activity.id, 'calendar:2');
        assert.equal(h.modal.manualCompleted, true);
      } else {
        assert.equal(h.modal.overlay.hidden, true);
        assert.equal(h.timers.size, 0);
        await h.visible(true);
        assert.equal(h.calls, 1);
      }
    } finally { h.close(); }
  });
}
