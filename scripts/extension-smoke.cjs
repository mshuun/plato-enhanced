'use strict';
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { launch, delay, until } = require('./chromium-harness.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'extension-smoke');
const fixture = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', name), 'utf8');
const historyFixtures = Object.fromEntries(['history-duplicate', 'history-conflict', 'history-partial'].map(mode => {
  const doc = new JSDOM(fixture('nespa-submission-complete.html'));
  const row = doc.window.document.querySelector('#score_table tbody tr');
  if (mode === 'history-partial') row.parentElement.insertAdjacentHTML('beforeend', '<tr><td colspan="9">일부 제출 내역을 불러올 수 없습니다.</td></tr>');
  else {
    const copy = row.cloneNode(true); copy.cells[8].textContent = mode === 'history-conflict' ? '50' : '100.0'; row.parentElement.append(copy);
  }
  const html = doc.serialize(); doc.window.close(); return [mode, html];
}));
const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
const year = now.getFullYear(), month = now.getMonth() + 1;
const catalog = new JSDOM(fixture('nespa-assignments.html'));
[...catalog.window.document.querySelectorAll('tbody tr')].forEach((row, index) => {
  row.cells[6].textContent = month + '/1 00:00';
  row.cells[7].textContent = month + '/' + (12 + index) + ' 22:00';
});
const catalogHtml = catalog.serialize(); catalog.window.close();
const home = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anonymous PLATO fixture</title>
<link rel="stylesheet" href="/fixture.css"><script src="/fixture-amd.js"></script></head>
<body id="page-site-index"><main class="dashboard-container"><section class="ongoing-courses"><h3>진행 중인 강좌</h3><a class="course-card" href="/course/view.php?id=9"><h5>자료구조 (001)</h5></a></section>
<label>기존 페이지 메모<input id="native-draft" value="보존할 메모"></label></main></body></html>`;
const amd = `window.M={cfg:{userId:'42',usertimezone:'Asia/Seoul'}};
function fixtureEvent(y,m){return {id:101,course:{id:9,fullname:'PLATO 검증 강좌'},modulename:'assign',
name:'PLATO test assignment',timestart:Date.UTC(y,m-1,15)/1000,url:'https://plato.pusan.ac.kr/mod/assign/view.php?id=101'};}
function fixturePayload(y,m){return window.fixtureMonth?window.fixtureMonth(y,m):{events:[fixtureEvent(y,m)]};}
window.require=(names,resolve)=>resolve(names[0]==='core_calendar/repository'?{
getCalendarMonthData:(y,m)=>Promise.resolve(fixturePayload(y,m)),
getEventById:id=>Promise.resolve(window.fixtureEventDetail?window.fixtureEventDetail(id):fixturePayload(${year},${month}).events.find(event=>event.id===Number(id))||null)}:{queryByTime:args=>window.fixtureAction?window.fixtureAction(args):Promise.resolve({events:[]})});`;
const timetable = '<div id="ptTable"></div><div class="schedule-info"><h5 class="modal-title">자료구조[001]</h5><dl>' +
  [...'일월화수목금토'].map(day => `<dt>강의일자</dt><dd>${year}-01-01 ~ ${year + 1}-12-31</dd><dt>강의시간</dt><dd>${day}요일 00:00 ~ 23:59</dd><dt>강의실</dt><dd>익명 예시 강의실</dd>`).join('') + '</dl></div>';
const course = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anonymous course fixture</title><link rel="stylesheet" href="/fixture.css"></head><body id="page-course-view-topics">
<main id="region-main"><section class="dashboard-section"><label>원래 입력란<input id="weekly-native-draft" value="native course draft"></label></section></main></body></html>`;
let materialVersion = 1, removedMaterial = null, nespaMode = 'normal', quizCompleted = false;
function sections() {
  return [1, 2].map(week => {
    const ids = Array.from({ length: week === 1 && materialVersion > 1 ? 24 : 20 }, (_, i) => week * 100 + i + 1);
    return `<li class="course-section current" data-for="section" data-number="${week}"><h3 class="sectionname">${week}주차 예시 자료</h3>` +
      ids.filter(id => id !== removedMaterial).map(id => `<div data-for="cmitem" class="modtype_resource"><a class="activity-container-link" href="/mod/resource/view.php?id=${id}"><span class="activityname">예시 강의 자료 ${id} version ${materialVersion}</span></a></div>`).join('') +
      (week === 1 ? '<div data-for="cmitem" class="modtype_assign"><a class="activity-container-link" href="/mod/assign/view.php?id=101"><span class="activityname">예시 과제</span></a></div><div data-for="cmitem" class="modtype_quiz"><a class="activity-container-link" href="/mod/quiz/view.php?id=102"><span class="activityname">예시 퀴즈</span></a></div>' : '') + '</li>';
  }).join('');
}

async function findTarget(session, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const target = (await session.list()).find(predicate);
    if (target) return target;
    await delay(100);
  }
  throw new Error('Expected browser target did not appear');
}

(async () => {
  const session = await launch(output, ['--enable-unsafe-extension-debugging']);
  const requests = [], checks = [], unexpected = [], cancelledRequests = [], metrics = [];
  const pageContexts = new Map();
  let statusRace = null, timetableRace = null, weeklyRace = null, nespaSessionRace = null;
  let extension, page;
  async function reloadPage() {
    await page.send('Page.bringToFront');
    const oldLoader = (await page.send('Page.getFrameTree')).frameTree.frame.loaderId;
    await page.send('Page.reload');
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await page.send('Page.getFrameTree')).frameTree.frame.loaderId !== oldLoader) {
        await until(page, () => document.readyState === 'complete');
        return;
      }
      await delay(100);
    }
    throw new Error('Page reload did not create a new document');
  }
  async function intercept(client, source) {
    client.on('Fetch.requestPaused', async event => {
      const url = new URL(event.request.url), request = { source, method: event.request.method, url: url.href };
      if (url.origin === 'https://emerald.pusan.ac.kr') request.scenario = nespaMode;
      requests.push(request);
      let body = '', type = 'text/html; charset=utf-8', code = 200;
      if (request.method !== 'GET') { unexpected.push(request); code = 405; }
      else if (url.origin === 'https://plato.pusan.ac.kr') {
        if (url.pathname === '/' || url.pathname === '/index.php') body = home;
        else if (url.pathname === '/fixture-amd.js') { body = amd; type = 'application/javascript; charset=utf-8'; }
        else if (url.pathname === '/fixture.css') { body = fixture('plato-preview.css'); type = 'text/css'; }
        else if (url.pathname === '/favicon.ico') code = 204;
        else if (url.pathname === '/mod/assign/view.php') {
          let status = '미제출';
          if (weeklyRace?.resource === 'detail' && !weeklyRace.held) {
            weeklyRace.held = true;
            await new Promise(resolve => weeklyRace.releases.push(resolve));
          }
          if (statusRace && source === 'page' && !statusRace.submission) {
            statusRace.submission = true;
            await new Promise(resolve => statusRace.releases.push(resolve));
            status = '제출 완료';
          }
          body = `<!doctype html><body id="page-mod-assign-view"><main id="region-main"><table class="submissionstatustable"><tr><th>제출 상태</th><td>${status}</td></tr></table></main></body>`;
        }
        else if (url.pathname === '/mod/quiz/view.php') body = '<!doctype html><body id="page-mod-quiz-view"><main id="region-main"><ul class="list-of-attempts"><li><h6>1차 응시</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">8 / 10</span></div></li></ul></main></body>';
        else if (url.pathname === '/report/ublogs/student/activity.php') {
          let status = '미완료';
          if (statusRace && source === 'page' && !statusRace.course) {
            statusRace.course = true;
            await new Promise(resolve => statusRace.releases.push(resolve));
            status = '완료';
          }
          body = `<!doctype html><body id="page-report-ublogs-student-activity"><main id="region-main"><table class="table-learning-student-activity"><tbody><tr><td class="td-activity"><a href="/mod/assign/view.php?id=101">과제</a></td><td class="td-status"><span class="csms-chips-status">${status}</span></td></tr><tr><td class="td-activity"><a href="/mod/quiz/view.php?id=102">시험</a></td><td class="td-status"><span class="csms-chips-status">${quizCompleted ? '완료' : '미완료'}</span></td></tr></tbody></table></main></body>`;
        }
        else if (url.pathname === '/course/view.php') {
          if (url.searchParams.get('mode') === 'sections' && weeklyRace?.resource === 'sections' && !weeklyRace.held) {
            weeklyRace.held = true;
            await new Promise(resolve => weeklyRace.releases.push(resolve));
          }
          body = url.searchParams.get('mode') === 'sections' ? sections() : course;
        }
        else { unexpected.push(request); code = 404; }
      } else if (url.origin === 'https://emerald.pusan.ac.kr') {
        if (url.pathname === '/ds2026/assignment_list/' && nespaMode === 'offline-list') {
          await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'InternetDisconnected' });
          return;
        }
        if (url.pathname === '/ds2026/assignment_list/') body = nespaMode === 'login-list' ? fixture('nespa-login.html') : catalogHtml;
        else if (url.pathname === '/ds2026/submission_detail/') {
          if (source === 'worker' && nespaSessionRace) {
            const race = nespaSessionRace;
            if (url.searchParams.get('prob_id') === '001' && !race.held) {
              race.held = true;
              await new Promise(resolve => race.releases.push(resolve));
              body = fixture('nespa-submission-complete.html');
            } else if (url.searchParams.get('prob_id') === '13' && race.phase === 'expired') code = 401;
            else body = fixture('nespa-submission-empty.html');
          }
          else if (nespaMode === 'expired-detail') code = 401;
          else body = url.searchParams.get('prob_id') === '001'
            ? historyFixtures[nespaMode] || fixture('nespa-submission-complete.html') : fixture('nespa-submission-empty.html');
        }
        else if (url.pathname === '/favicon.ico') code = 204;
        else { unexpected.push(request); code = 404; }
      } else if (url.origin === 'https://onestop.pusan.ac.kr' && url.pathname === '/main') {
        if (timetableRace) await new Promise(resolve => timetableRace.releases.push(resolve));
        body = timetable;
      }
      else { unexpected.push(request); code = 404; }
      // Every HTTPS request from tested targets is fulfilled locally, including unexpected routes.
      try {
        await client.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: code,
          responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' },
            { name: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }],
          body: Buffer.from(body).toString('base64') });
      } catch (error) {
        // Reload/navigation can cancel an intercepted request before its local reply is delivered.
        if (error.message === 'Invalid InterceptionId.') cancelledRequests.push(request); else throw error;
      }
    });
    await client.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
    await client.send('Runtime.enable');
  }
  async function screenshot(client, name) {
    await client.send('Page.bringToFront');
    const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64'));
  }
  try {
    const schema = (await session.protocol()).domains.find(domain => domain.domain === 'Extensions');
    assert.ok(schema?.commands.some(command => command.name === 'loadUnpacked'), 'Chromium must support Extensions.loadUnpacked');
    extension = await session.client.send('Extensions.loadUnpacked', { path: root });
    const workerTarget = await findTarget(session, target => target.type === 'service_worker' && target.url === `chrome-extension://${extension.id}/src/background.js`);
    const worker = await session.connect(workerTarget.webSocketDebuggerUrl);
    await intercept(worker, 'worker');
    await worker.evaluate(async currentYear => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ 'platoEnhanced.nespa.settings': { enabled: true,
        courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: currentYear } });
    }, year);
    const pageTarget = await findTarget(session, target => target.type === 'page' && target.url === 'about:blank');
    page = await session.connect(pageTarget.webSocketDebuggerUrl);
    page.on('Runtime.executionContextCreated', event => pageContexts.set(event.context.id, event.context));
    page.on('Runtime.executionContextDestroyed', event => pageContexts.delete(event.executionContextId));
    page.on('Runtime.executionContextsCleared', () => pageContexts.clear());
    await intercept(page, 'page');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Honolulu' });
    await page.send('Page.navigate', { url: 'https://plato.pusan.ac.kr/' });
    await until(page, () => document.querySelectorAll('[data-activity-id]').length === 4 &&
      document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]')?.textContent.includes('제출됨'));
    assert.deepEqual(await page.evaluate(() => ({ mainBridge: window.__platoCalendarExtBridgeInstalledV1,
      isolatedGlobals: typeof window.PlatoCalendarExt, nativeDraft: document.querySelector('#native-draft').value,
      count: document.querySelectorAll('[data-activity-id]').length })),
    { mainBridge: true, isolatedGlobals: 'undefined', nativeDraft: '보존할 메모', count: 4 });
    assert.equal(requests.filter(request => request.source === 'worker' && request.url.includes('/ds2026/')).length, 4);
    checks.push('manifest MAIN/ISOLATED worlds, calendar bridge and native background host requests');
    await until(page, () => !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    await page.evaluate(() => {
      window.beforeIdlessMonth = window.fixtureMonth;
      window.fixtureMonth = (y, m) => ({ events: [fixtureEvent(y, m), { name: 'Quiz without calendar ID', modulename: 'quiz',
        course: { id: 9, fullname: 'PLATO 검증 강좌' }, timestart: Date.UTC(y, m - 1, 16) / 1000,
        url: 'https://plato.pusan.ac.kr/mod/quiz/view.php?id=102' }] });
      document.querySelector('[aria-label="현재 달 일정 새로고침"]').click();
    });
    await until(page, () => Boolean(document.querySelector('[data-activity-id="activity:9:quiz:102"]')) &&
      !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    await page.evaluate(() => document.querySelector('[data-activity-id="activity:9:quiz:102"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')]
      .some(button => button.textContent === '상태 새로고침' && !button.hidden && !button.disabled)), true);
    quizCompleted = true;
    const idlessRefreshStart = requests.length;
    await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').focus());
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() &&
      document.querySelector('[data-activity-id="activity:9:quiz:102"]').classList.contains('plato-calendar-ext-status-completed'));
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '상태 새로고침');
    assert.equal(await page.evaluate(() => document.querySelector('[data-activity-id="activity:9:quiz:102"]').classList.contains('plato-calendar-ext-status-completed')), true);
    const idlessReads = requests.slice(idlessRefreshStart).filter(request => request.source === 'page');
    assert.deepEqual(idlessReads.map(request => request.url), ['https://plato.pusan.ac.kr/report/ublogs/student/activity.php?id=9']);
    await screenshot(page, 'installed-idless-quiz-refresh.png');
    await page.evaluate(() => {
      document.querySelector('.plato-calendar-ext-modal-header button').click();
      window.fixtureMonth = window.beforeIdlessMonth; delete window.beforeIdlessMonth;
      document.querySelector('[aria-label="현재 달 일정 새로고침"]').click();
    });
    quizCompleted = false;
    await until(page, () => document.querySelectorAll('[data-activity-id]').length === 4 &&
      !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    checks.push('a quiz without a calendar event ID refreshes its course completion by native Enter, updates calendar and dialog, and retains button focus');
    await until(page, () => document.querySelector('.pe-classroom-enter') && document.querySelector('.pe-classroom-body').textContent.includes('익명 예시 강의실'));
    assert.equal(await page.evaluate(() => document.querySelector('.pe-classroom-enter').href), 'https://plato.pusan.ac.kr/course/view.php?id=9');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('platoEnhanced.timetable.v1.42'))['platoEnhanced.timetable.v1.42'].meetings.length), 7);
    checks.push('real timetable message, fixed host read, course matching and scoped native cache');
    for (const outside of [false, true]) {
      timetableRace = { releases: [] };
      const courseHref = await page.evaluate(() => {
        const link = document.querySelector('.pe-classroom-enter'); link.focus();
        document.querySelector('.pe-classroom-refresh').click();
        return link.href;
      });
      for (let attempt = 0; timetableRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
      assert.equal(timetableRace.releases.length, 1);
      assert.equal(await page.evaluate(() => document.activeElement.href), courseHref);
      if (outside) await page.evaluate(() => { document.querySelector('#native-draft').focus(); });
      timetableRace.releases.splice(0).forEach(release => release()); timetableRace = null;
      await until(page, () => !document.querySelector('.pe-classroom-refresh').disabled);
      assert.equal(await page.evaluate(() => document.activeElement.id || document.activeElement.href), outside ? 'native-draft' : courseHref);
    }
    checks.push('native timetable refresh retains focused course links without stealing focus moved into the page draft');
    for (const outside of [false, true]) {
      timetableRace = { releases: [] };
      await page.evaluate(() => document.querySelector('.pe-classroom-refresh').focus());
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      for (let attempt = 0; timetableRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
      assert.equal(timetableRace.releases.length, 1);
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('pe-classroom-note')), true);
      if (outside) await page.evaluate(() => document.querySelector('#native-draft').focus());
      else await screenshot(page, 'installed-timetable-loading-focus.png');
      timetableRace.releases.splice(0).forEach(release => release()); timetableRace = null;
      await until(page, () => !document.querySelector('.pe-classroom-refresh').disabled);
      assert.equal(await page.evaluate(() => document.activeElement.id || document.activeElement.className), outside ? 'native-draft' : 'pe-classroom-refresh');
    }
    checks.push('native Enter refresh moves focus into its loading status and restores the toolbar button only when the user stays there');
    await page.evaluate(() => document.querySelector('.pe-classroom-enter').focus());
    await screenshot(page, 'installed-timetable-focus.png');
    assert.deepEqual(await page.evaluate(() => {
      const korea = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      return { browserTimezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        calendarDate: document.querySelector('.plato-calendar-ext-today')?.dataset.dayKey === korea,
        timetableDate: document.querySelector('.pe-classroom-clock').textContent.startsWith(korea.slice(5).replace('-', '/')) };
    }), { browserTimezone: 'Pacific/Honolulu', calendarDate: true, timetableDate: true });
    checks.push('calendar today and timetable date stay in Korea time in a Honolulu browser');
    await screenshot(page, 'installed-calendar.png');

    await page.evaluate(() => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]').click());
    await until(page, () => [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(node => node.textContent === '최고 채점점수')?.nextElementSibling.textContent === '100' && !document.querySelector('.plato-calendar-ext-detail-loading')?.checkVisibility());
    nespaMode = 'expired-detail';
    await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').click());
    await until(page, () => [...document.querySelectorAll('[data-activity-id^="activity:nespa:"]')].every(node => node.textContent.includes('확인 필요')) &&
      document.querySelector('.plato-calendar-ext-modal-feedback').textContent.includes('직접 로그인'));
    assert.deepEqual(await page.evaluate(() => {
      const fields = [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')];
      return { scoreShown: fields.some(node => node.textContent === '최고 채점점수'),
        attempts: fields.find(node => node.textContent === '확인된 제출 횟수')?.nextElementSibling.textContent };
    }), { scoreShown: false, attempts: '확인 불가' });
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-activity-id="calendar:101"]'))), true);
    await screenshot(page, 'installed-expired-detail.png');
    await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    for (const scenario of ['login-list', 'offline-list']) {
      nespaMode = scenario;
      await page.evaluate(() => document.querySelector('[aria-label="현재 달 일정 새로고침"]').click());
      await until(page, () => !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled && document.querySelectorAll('[data-activity-id]').length === 4 &&
        [...document.querySelectorAll('[data-activity-id^="activity:nespa:"]')].every(node => node.textContent.includes('확인 필요')));
    }
    nespaMode = 'normal';
    await page.evaluate(() => document.querySelector('[aria-label="현재 달 일정 새로고침"]').click());
    await until(page, () => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]')?.textContent.includes('제출됨'));
    checks.push('native HTTP expiry clears private dialog data; login HTML and network failure retain only common schedules; retry recovers');

    nespaMode = 'history-duplicate';
    await page.evaluate(() => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
    const historyFields = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.plato-calendar-ext-modal-body dt')]
      .map(term => [term.textContent, term.nextElementSibling.textContent])));
    assert.equal((await historyFields())['확인된 제출 횟수'], '1회');
    assert.equal((await historyFields())['최고 채점점수'], '100');
    nespaMode = 'history-conflict';
    await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() && document.querySelector('.plato-calendar-ext-modal-feedback').textContent.includes('일부 제출 내역'));
    assert.equal((await historyFields())['제출 여부'], '제출됨'); assert.equal((await historyFields())['확인된 제출 횟수'], '1회');
    assert.equal((await historyFields())['최고 채점점수'], undefined);
    await screenshot(page, 'installed-history-conflict.png');
    checks.push('duplicate native submission IDs count once; conflicting duplicate scores retain verified submission and count while withholding the maximum');

    nespaMode = 'history-partial';
    await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() &&
      [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(term => term.textContent === '확인된 제출 횟수')?.nextElementSibling.textContent === '확인 불가');
    assert.equal((await historyFields())['제출 여부'], '제출됨'); assert.equal((await historyFields())['최고 채점점수'], undefined);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const partialLayout = await page.evaluate(() => {
      const feedback = document.querySelector('.plato-calendar-ext-modal-feedback'), footer = document.querySelector('.plato-calendar-ext-modal-footer');
      const dialog = document.querySelector('.plato-calendar-ext-modal'), rect = dialog.getBoundingClientRect();
      return { width: innerWidth, inside: rect.left >= 0 && rect.right <= innerWidth,
        feedbackBeforeFooter: feedback.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top,
        feedbackFits: feedback.scrollHeight <= feedback.clientHeight,
        actionsFit: [...footer.querySelectorAll('a,button')].filter(node => node.getClientRects().length)
          .every(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
        message: feedback.textContent, role: feedback.getAttribute('role') };
    });
    assert.equal(partialLayout.width, 390); assert.equal(partialLayout.inside, true); assert.equal(partialLayout.feedbackBeforeFooter, true);
    assert.equal(partialLayout.feedbackFits, true, JSON.stringify(partialLayout)); assert.equal(partialLayout.actionsFit, true, JSON.stringify(partialLayout));
    assert.equal(partialLayout.role, 'status'); assert.ok(partialLayout.message.includes('일부 제출 내역'));
    await screenshot(page, 'installed-history-partial-mobile.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(() => { document.querySelector('.plato-calendar-ext-modal-header button').click(); document.querySelector('[aria-label="현재 달 일정 새로고침"]').click(); });
    await until(page, () => !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled &&
      document.querySelector('.plato-calendar-ext-load-status').textContent.includes('일부 NESPA') && document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]').textContent.includes('제출됨'));
    nespaMode = 'normal';
    await page.evaluate(() => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() &&
      [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(term => term.textContent === '최고 채점점수')?.nextElementSibling.textContent === '100');
    assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-feedback').textContent), '');
    assert.equal((await historyFields())['확인된 제출 횟수'], '1회');
    await page.evaluate(() => { document.querySelector('.plato-calendar-ext-modal-header button').click(); document.querySelector('[aria-label="현재 달 일정 새로고침"]').click(); });
    await until(page, () => !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled && !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('일부 NESPA'));
    checks.push('mixed native history errors retain submitted evidence, mark counts/maximum unknown, announce partial status on mobile and recover cleanly on retry');

    await page.evaluate(() => document.querySelector('[data-activity-id="calendar:101"]').click());
    await until(page, () => document.querySelector('.plato-calendar-ext-button-secondary') &&
      [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].some(button => button.textContent === '수동 완료' && !button.disabled));
    await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '수동 완료').click());
    await until(page, () => document.querySelector('[data-activity-id="calendar:101"]')?.classList.contains('plato-calendar-ext-status-manual'));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('platoCalendarExt.manualCompletions.v2.42.calendar:101'))['platoCalendarExt.manualCompletions.v2.42.calendar:101']), true);
    await reloadPage();
    await until(page, () => document.querySelector('[data-activity-id="calendar:101"]')?.classList.contains('plato-calendar-ext-status-manual'));
    checks.push('manual completion writes native scoped storage and survives reload');

    await worker.evaluate(() => chrome.runtime.openOptionsPage());
    const optionsTarget = await findTarget(session, target => target.url === `chrome-extension://${extension.id}/options.html`);
    const options = await session.connect(optionsTarget.webSocketDebuggerUrl);
    await intercept(options, 'options'); await options.send('Page.enable');
    await until(options, () => document.querySelector('#settings-form')?.getAttribute('aria-busy') === 'false');
    await options.evaluate(() => { document.querySelector('#enabled').checked = false; document.querySelector('#settings-form').requestSubmit(); });
    await until(options, () => document.querySelector('#status').textContent.includes('연동을 껐습니다'));
    await until(page, () => document.querySelectorAll('[data-activity-id]').length === 1 && Boolean(document.querySelector('[data-activity-id="calendar:101"]')));
    const disabledCount = requests.filter(request => request.source === 'worker').length;
    await reloadPage();
    await until(page, () => document.querySelectorAll('[data-activity-id]').length === 1);
    assert.equal(requests.filter(request => request.source === 'worker').length, disabledCount);
    checks.push('native options save propagates to existing tab; OFF survives reload without NESPA requests');
    await options.send('Page.bringToFront');
    await options.evaluate(() => { document.querySelector('#enabled').checked = true; document.querySelector('#settings-form').requestSubmit(); });
    await until(options, () => document.querySelector('#status').textContent.includes('저장했습니다'));
    await page.send('Page.bringToFront');
    await until(page, () => document.querySelectorAll('[data-activity-id]').length === 4);
    checks.push('reenabling NESPA restores tasks through the real storage event');
    await screenshot(options, 'installed-options.png');

    const secondTarget = await session.client.send('Target.createTarget', { url: `chrome-extension://${extension.id}/options.html` });
    const secondInfo = await findTarget(session, target => target.id === secondTarget.targetId);
    const second = await session.connect(secondInfo.webSocketDebuggerUrl);
    await intercept(second, 'second-options'); await second.send('Page.enable');
    await until(second, () => document.querySelector('#settings-form')?.getAttribute('aria-busy') === 'false');
    assert.equal(await options.evaluate(() => typeof navigator.locks?.request), 'function');
    await options.evaluate(() => { document.querySelector('#course-name').value = '다른 창의 강좌명'; document.querySelector('#settings-form').requestSubmit(); });
    await until(options, () => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false');
    await until(second, () => document.querySelector('#course-name').value === '다른 창의 강좌명');
    await second.evaluate(() => { document.querySelector('#enabled').checked = false; document.querySelector('#settings-form').requestSubmit(); });
    await until(second, () => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await worker.evaluate(async () => {
      const value = (await chrome.storage.local.get('platoEnhanced.nespa.settings'))['platoEnhanced.nespa.settings'];
      return { enabled: value.enabled, name: value.courseName };
    }), { enabled: false, name: '다른 창의 강좌명' });
    checks.push('two actual options tabs share external updates and independent edits preserve each other');

    async function holdSettings() {
      await worker.evaluate(() => {
        globalThis.settingsLockReady = false;
        globalThis.settingsLockTask = navigator.locks.request('platoEnhanced.nespa.settings', () => new Promise(resolve => {
          globalThis.releaseSettingsLock = resolve; globalThis.settingsLockReady = true;
        }));
        return true;
      });
      await until(worker, () => globalThis.settingsLockReady);
    }
    async function releaseSettings() {
      await worker.evaluate(() => { globalThis.releaseSettingsLock(); return true; });
    }
    await holdSettings();
    await options.evaluate(() => { globalThis.patchSave = PlatoCalendarExt.nespaSettings.save({ courseName: '동시에 저장한 강좌명' }); return true; });
    await second.evaluate(() => { globalThis.patchSave = PlatoCalendarExt.nespaSettings.save({ enabled: true }); return true; });
    await until(worker, async () => (await navigator.locks.query()).pending.filter(lock => lock.name === 'platoEnhanced.nespa.settings').length === 2);
    await releaseSettings();
    await Promise.all([options.evaluate(() => globalThis.patchSave), second.evaluate(() => globalThis.patchSave)]);
    await until(options, () => document.querySelector('#course-name').value === '동시에 저장한 강좌명' && document.querySelector('#enabled').checked);
    await until(second, () => document.querySelector('#course-name').value === '동시에 저장한 강좌명' && document.querySelector('#enabled').checked);
    assert.deepEqual(await worker.evaluate(async () => {
      const value = (await chrome.storage.local.get('platoEnhanced.nespa.settings'))['platoEnhanced.nespa.settings'];
      return { enabled: value.enabled, name: value.courseName };
    }), { enabled: true, name: '동시에 저장한 강좌명' });
    checks.push('native Web Locks serialize concurrent patches from separate extension contexts');

    await holdSettings();
    await options.evaluate(() => { document.querySelector('#course-name').value = '먼저 저장한 강좌명'; document.querySelector('#settings-form').requestSubmit(); });
    await second.evaluate(() => { document.querySelector('#course-name').value = '두 번째 창의 입력'; document.querySelector('#settings-form').requestSubmit(); });
    await until(worker, async () => (await navigator.locks.query()).pending.filter(lock => lock.name === 'platoEnhanced.nespa.settings').length === 2);
    await releaseSettings();
    await until(second, () => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false' && document.querySelector('#status').textContent.includes('먼저 저장한 강좌명'));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('platoEnhanced.nespa.settings'))['platoEnhanced.nespa.settings'].courseName), '먼저 저장한 강좌명');
    assert.equal(await second.evaluate(() => document.querySelector('#course-name').value), '두 번째 창의 입력');
    await second.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await screenshot(second, 'installed-options-conflict-mobile.png');
    assert.equal(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await second.evaluate(() => document.querySelector('#status').getBoundingClientRect().bottom <= document.querySelector('button[type="submit"]').getBoundingClientRect().top), true);
    await second.evaluate(() => document.querySelector('#settings-form').requestSubmit());
    await until(second, () => document.querySelector('#settings-form').getAttribute('aria-busy') === 'false' && document.querySelector('#status').textContent.includes('저장했습니다'));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('platoEnhanced.nespa.settings'))['platoEnhanced.nespa.settings'].courseName), '두 번째 창의 입력');
    checks.push('simultaneous same-field edit is rejected, current value disclosed and draft kept for a reviewed retry');
    await session.client.send('Target.closeTarget', { targetId: secondTarget.targetId });

    await page.send('Page.bringToFront');
    await until(page, () => !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled && document.querySelectorAll('[data-activity-id]').length === 4);
    await page.evaluate(() => {
      window.fixtureAction = () => Promise.resolve(null);
      document.querySelector('[aria-label="현재 달 일정 새로고침"]').click();
    });
    await until(page, () => document.querySelector('.plato-calendar-ext-load-status').textContent.includes('일부 할 일 상태를 확인하지 못했습니다.') &&
      document.querySelectorAll('[data-activity-id]').length === 4);
    checks.push('malformed timeline response preserves both calendars and exposes incomplete-status warning');
    await screenshot(page, 'installed-partial.png');

    const parserRequestStart = requests.length;
    await page.evaluate(() => {
      window.fixtureAction = null;
      window.fixtureMonth = (y, m) => {
        const valid = fixtureEvent(y, m);
        const make = (id, day, url, name) => ({ ...valid, id, name, url, timestart: Date.UTC(y, m - 1, day) / 1000 });
        const shared = 'https://plato.pusan.ac.kr/calendar/view.php?view=day';
        window.fixtureAction = () => Promise.resolve({ events: [
          { ...valid, url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=999', timesort: Date.UTC(y, m - 1, 19) / 1000, submitted: true },
          { ...valid, id: 888, url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=888', timesort: Date.UTC(y, m - 1, 18) / 1000, instance: null, submitted: true }
        ] });
        return { events: [{ ...valid, modulename: 'quiz' },
          make(102, 16, 'https://user:pass@plato.pusan.ac.kr/mod/assign/view.php?id=202', 'Invalid credential link'),
          make(103, 17, 'https://plato.pusan.ac.kr/mod/assign/view.php?id=203&id=204', 'Ambiguous activity link'),
          { ...make(104, 18, shared, 'Shared calendar first'), instance: null }, { ...make(105, 18, shared, 'Shared calendar second'), instance: null }] };
      };
      document.querySelector('[aria-label="현재 달 일정 새로고침"]').click();
    });
    await until(page, () => !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled && document.querySelectorAll('[data-activity-id]').length === 8 &&
      !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    for (const id of [102, 103, 104, 105]) {
      assert.equal(await page.evaluate(value => Boolean(document.querySelector(`[data-activity-id="calendar:${value}"]`)), id), true);
    }
    assert.equal(requests.slice(parserRequestStart).some(request => /[?&]id=(?:202|203|204|888|999)(?:&|$)/.test(request.url)), false);
    assert.equal(await page.evaluate(() => document.querySelector('[data-activity-id="calendar:101"]').closest('[data-day-key]').dataset.dayKey), `${year}-${String(month).padStart(2, '0')}-15`);
    await page.evaluate(() => document.querySelector('[data-activity-id="calendar:103"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
    assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-footer > a').hidden), true);
    await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    await screenshot(page, 'installed-calendar-invalid-links.png');
    await page.evaluate(() => document.querySelector('[data-activity-id="calendar:101"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(node => node.textContent === '활동 유형')?.nextElementSibling.textContent), '과제');
    await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    checks.push('invalid/conflicting activity links and missing IDs cannot redirect status reads or deadlines; shared calendar links retain distinct tasks; native route wins stale type');

    const mismatchRequestStart = requests.length;
    await page.evaluate((y, m) => {
      window.fixtureEventDetail = () => ({ ...fixtureEvent(y, m), id: 999, name: 'Wrong activity', url: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=999' });
      document.querySelector('[data-activity-id="calendar:101"]').click();
    }, year, month);
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() && document.querySelector('.plato-calendar-ext-modal-feedback').textContent.includes('일정 상세 조회에 실패'));
    assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-title').textContent), 'PLATO test assignment');
    assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-footer > a').href), 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101');
    assert.equal(requests.slice(mismatchRequestStart).some(request => new URL(request.url).searchParams.get('id') === '999'), false);
    await screenshot(page, 'installed-mismatched-detail.png');
    await page.evaluate(() => {
      window.fixtureEventDetail = () => ({ event: null });
      [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').click();
    });
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() && document.querySelector('.plato-calendar-ext-modal-feedback').textContent.includes('일정 상세 조회에 실패'));
    assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-footer > a').href), 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101');
    await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    checks.push('wrong or missing calendar details show a warning without replacing the selected link or redirecting status requests');

    await page.evaluate(() => {
      window.fixtureEventDetail = () => ({ id: 101, name: 'Out-of-range detail timestamp', timesort: 1e100 });
      document.querySelector('[data-activity-id="calendar:101"]').click();
    });
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() &&
      document.querySelector('.plato-calendar-ext-modal-title').textContent === 'Out-of-range detail timestamp');
    assert.deepEqual(await page.evaluate((y, m) => {
      const deadline = [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(node => node.textContent === '마감')?.nextElementSibling.textContent;
      const expected = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric',
        weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.UTC(y, m - 1, 15)));
      return { preserved: deadline === expected, feedback: document.querySelector('.plato-calendar-ext-modal-feedback').textContent,
        disabled: [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(button => button.textContent === '상태 새로고침').disabled };
    }, year, month), { preserved: true, feedback: '', disabled: false });
    await screenshot(page, 'installed-invalid-detail-date.png');
    await page.evaluate(() => { document.querySelector('.plato-calendar-ext-modal-header button').click(); delete window.fixtureEventDetail; });
    checks.push('an out-of-range native detail deadline preserves the selected deadline, accepts other detail fields and leaves refresh usable');

    // Exercise the shipped content-world source and real MAIN-world bridge.
    // These extra sources are destroyed before resuming the visible calendar.
    const selectContentContext = async () => {
      for (const context of pageContexts.values()) {
        if (context.auxData?.isDefault) continue;
        const probe = await page.send('Runtime.evaluate', { contextId: context.id,
          expression: 'Boolean(globalThis.PlatoCalendarExt?.PlatoDataSource)', returnByValue: true });
        if (probe.result?.value) return context.id;
      }
      throw new Error('Installed extension content world must be available');
    };
    let contentContext = await selectContentContext();
    const content = { async evaluate(fn, ...args) {
      const expression = '(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')';
      const result = await page.send('Runtime.evaluate', { contextId: contentContext, expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } };
    // Keep the real native storage write; fail only the following read boundary.
    await content.evaluate(() => {
      globalThis.manualReadStorage = PlatoCalendarExt.storage;
      PlatoCalendarExt.storage = { ...manualReadStorage, async getManualCompletions() { throw new Error('TEST_STORAGE_READ_FAILED'); } };
    });
    try {
      await page.evaluate(() => document.querySelector('[data-activity-id="calendar:101"]').click());
      await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
      for (const completed of [false, true]) {
        await page.evaluate(() => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')]
          .find(button => button.textContent.startsWith('수동 완료')).click());
        await until(page, value => {
          const button = [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(node => node.textContent.startsWith('수동 완료'));
          return button && !button.disabled && button.textContent === (value ? '수동 완료 취소' : '수동 완료') &&
            document.querySelector('[data-activity-id="calendar:101"]').classList.contains('plato-calendar-ext-status-manual') === value;
        }, completed);
        assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('platoCalendarExt.manualCompletions.v2.42.calendar:101'))['platoCalendarExt.manualCompletions.v2.42.calendar:101']), completed);
        assert.equal(await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-feedback').textContent), '');
      }
      await screenshot(page, 'installed-manual-read-failure.png');
      await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    } finally {
      await content.evaluate(() => { PlatoCalendarExt.storage = manualReadStorage; delete globalThis.manualReadStorage; });
    }
    checks.push('acknowledged native manual completion and cancellation update both calendar and dialog despite a simulated follow-up read failure');

    await content.evaluate(() => {
      globalThis.manualFocusStorage = PlatoCalendarExt.storage;
      PlatoCalendarExt.storage = { ...manualFocusStorage, async setManualCompletion(...args) {
        await manualFocusStorage.setManualCompletion(...args);
        await new Promise(resolve => { globalThis.releaseManualSave = resolve; });
      } };
    });
    try {
      await page.evaluate(() => document.querySelector('[data-activity-id="calendar:101"]').click());
      await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
      for (const moved of [true, false]) {
        await page.evaluate(() => {
          const button = [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(node => node.textContent.startsWith('수동 완료'));
          button.focus(); button.click();
        });
        await until(content, () => typeof globalThis.releaseManualSave === 'function');
        if (moved) await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').focus());
        else assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        await content.evaluate(() => { releaseManualSave(); delete globalThis.releaseManualSave; });
        await until(page, () => [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].some(node => node.textContent.startsWith('수동 완료') && !node.disabled));
        assert.equal(await page.evaluate(value => document.activeElement === (value ? document.querySelector('.plato-calendar-ext-modal-header button') :
          [...document.querySelectorAll('.plato-calendar-ext-modal-footer button')].find(node => node.textContent.startsWith('수동 완료'))), moved), true);
        if (moved) await screenshot(page, 'installed-manual-save-focus.png');
      }
      await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-header button').click());
    } finally {
      await content.evaluate(() => { globalThis.releaseManualSave?.(); delete globalThis.releaseManualSave;
        PlatoCalendarExt.storage = manualFocusStorage; delete globalThis.manualFocusStorage; });
    }
    checks.push('native manual writes preserve focus moved to the close control and restore the save button only after focus falls into the document');

    const detailRaceSettings = await worker.evaluate(async () => (await chrome.storage.local.get('platoEnhanced.nespa.settings'))['platoEnhanced.nespa.settings']);
    try {
      await page.evaluate(() => {
        window.fixtureEventDetail = () => new Promise(resolve => { window.releaseOldDetail = () => resolve({ id: 101, name: 'Obsolete detail after settings change', submitted: true }); });
        document.querySelector('[data-activity-id="calendar:101"]').click();
      });
      await until(page, () => typeof window.releaseOldDetail === 'function');
      await worker.evaluate(async settings => { await chrome.storage.local.set({ 'platoEnhanced.nespa.settings': { ...settings, courseName: 'Race course' } }); }, detailRaceSettings);
      await until(page, () => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]')?.textContent.includes('Race course') &&
        !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
      const currentDetailTitle = await page.evaluate(() => document.querySelector('.plato-calendar-ext-modal-title').textContent);
      await page.evaluate(() => window.releaseOldDetail());
      await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
      assert.deepEqual(await page.evaluate(() => ({ title: document.querySelector('.plato-calendar-ext-modal-title').textContent,
        submission: [...document.querySelectorAll('.plato-calendar-ext-modal-body dt')].find(node => node.textContent === '제출 여부')?.nextElementSibling.textContent,
        feedback: document.querySelector('.plato-calendar-ext-modal-feedback').textContent })),
      { title: currentDetailTitle, submission: '미제출', feedback: '' });
      await screenshot(page, 'installed-late-detail-settings.png');
    } finally {
      await page.evaluate(() => { window.releaseOldDetail?.(); document.querySelector('.plato-calendar-ext-modal-header button').click(); delete window.fixtureEventDetail; delete window.releaseOldDetail; });
      await worker.evaluate(async settings => { await chrome.storage.local.set({ 'platoEnhanced.nespa.settings': settings }); }, detailRaceSettings);
      await until(page, name => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]')?.textContent.includes(name), detailRaceSettings.courseName);
    }
    checks.push('a native settings change refreshes an open PLATO dialog; its late earlier detail cannot restore obsolete metadata or submitted status');
    await page.evaluate(() => {
      const list = document.querySelector('.ongoing-courses');
      for (const href of ['/course/view.php?id=9&id=99', 'https://name:secret@plato.pusan.ac.kr/course/view.php?id=9', '/course/view.php?id=0']) {
        const copy = list.querySelector('.course-card').cloneNode(true); copy.href = href; copy.dataset.identityFixture = 'invalid'; list.append(copy);
      }
    });
    assert.deepEqual(await content.evaluate(() => PlatoCalendarExt.classScheduleModel.readCourses(document).map(course => course.id)), ['9']);
    await delay(250);
    assert.equal(await page.evaluate(() => document.querySelector('.pe-classroom-enter').href), 'https://plato.pusan.ac.kr/course/view.php?id=9');
    await page.evaluate(() => {
      document.querySelectorAll('[data-identity-fixture]').forEach(node => node.remove());
      const list = document.querySelector('.ongoing-courses'), copy = list.querySelector('.course-card').cloneNode(true);
      copy.dataset.identityFixture = 'conflict'; copy.querySelector('h5').textContent = '상충하는 강좌 (002)'; list.append(copy);
    });
    await until(page, () => !document.querySelector('.pe-classroom-enter'));
    assert.equal(await content.evaluate(() => PlatoCalendarExt.classScheduleModel.readCourses(document).length), 0);
    await page.evaluate(() => document.querySelectorAll('[data-identity-fixture]').forEach(node => node.remove()));
    await until(page, () => document.querySelector('.pe-classroom-enter')?.href === 'https://plato.pusan.ac.kr/course/view.php?id=9' && !document.querySelector('.pe-classroom-refresh').disabled);
    checks.push('native timetable ignores ambiguous/credential links and conflicting names for one course ID; healthy cards and cached navigation recover');
    await page.evaluate(() => {
      window.raceMonthCalls = 0;
      window.fixtureAction = () => Promise.resolve({ events: [] });
      window.fixtureMonth = (y, m) => {
        const event = fixtureEvent(y, m);
        if (++window.raceMonthCalls === 1) return new Promise(resolve => {
          window.releaseOldMonth = () => resolve({ events: [{ ...event, name: 'Obsolete month snapshot' }] });
        });
        return { events: [{ ...event, name: 'Latest month snapshot' }] };
      };
    });
    await content.evaluate((y, m) => {
      globalThis.raceSource = new PlatoCalendarExt.PlatoDataSource();
      globalThis.monthRace = {};
      raceSource.getMonth(y, m, true).then(() => { monthRace.old = 'accepted'; }, error => { monthRace.old = error.message; });
    }, year, month);
    await until(page, () => window.raceMonthCalls === 1);
    await content.evaluate((y, m) => {
      raceSource.getMonth(y, m, true).then(result => { monthRace.fresh = result.activities[0].title; }, error => { monthRace.error = error.message; });
    }, year, month);
    await until(content, () => globalThis.monthRace.fresh === 'Latest month snapshot');
    await page.evaluate(() => { window.releaseOldMonth(); });
    await until(content, () => globalThis.monthRace.old === 'PLATO_MONTH_OBSOLETE');
    assert.equal(await content.evaluate(async (y, m) => (await raceSource.getMonth(y, m, false)).activities[0].title, year, month), 'Latest month snapshot');
    assert.equal(await page.evaluate(() => window.raceMonthCalls), 2);
    checks.push('installed content source rejects a late month bridge response and retains the newer cached snapshot');

    statusRace = { releases: [] };
    const statusRaceStart = requests.length;
    await content.evaluate(() => {
      globalThis.statusRaceResult = {};
      raceSource.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101' }, false)
        .then(result => { statusRaceResult.oldSubmission = result; });
      raceSource.getCourseCompletions('9', false).then(result => { statusRaceResult.oldCourse = result; });
    });
    for (let attempt = 0; statusRace.releases.length < 2 && attempt < 80; attempt++) await delay(100);
    assert.equal(statusRace.releases.length, 2);
    await content.evaluate(() => {
      const activity = { activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101' };
      Promise.all([raceSource.getSubmission(activity, true), raceSource.getCourseCompletions('9', true),
        raceSource.getSubmission(activity, false), raceSource.getCourseCompletions('9', false)])
        .then(results => { statusRaceResult.fresh = results; });
    });
    await until(content, () => globalThis.statusRaceResult.fresh?.length === 4);
    for (const release of statusRace.releases) release();
    await until(content, () => globalThis.statusRaceResult.oldSubmission?.submissionStatus === '미제출' &&
      globalThis.statusRaceResult.oldCourse?.entries['https://plato.pusan.ac.kr/mod/assign/view.php?id=101']?.code === 'incomplete');
    assert.deepEqual(await content.evaluate(async () => {
      const submission = await raceSource.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101' }, false);
      const report = await raceSource.getCourseCompletions('9', false);
      return { submission: submission.submissionStatus, course: report.entries['https://plato.pusan.ac.kr/mod/assign/view.php?id=101'].code,
        ordinaryJoined: statusRaceResult.fresh[0].submissionStatus === statusRaceResult.fresh[2].submissionStatus &&
          statusRaceResult.fresh[1].entries['https://plato.pusan.ac.kr/mod/assign/view.php?id=101'].code === statusRaceResult.fresh[3].entries['https://plato.pusan.ac.kr/mod/assign/view.php?id=101'].code };
    }), { submission: '미제출', course: 'incomplete', ordinaryJoined: true });
    assert.equal(requests.slice(statusRaceStart).filter(request => request.source === 'page' &&
      /\/(?:mod\/assign\/view|report\/ublogs\/student\/activity)\.php/.test(new URL(request.url).pathname)).length, 4);
    statusRace = null;
    await content.evaluate(() => {
      raceSource.destroy(); delete globalThis.raceSource; delete globalThis.monthRace; delete globalThis.statusRaceResult;
    });
    await page.evaluate(() => { delete window.releaseOldMonth; delete window.raceMonthCalls; });
    checks.push('native forced assignment and course HTTP checks replace old requests; late completed responses cannot overwrite newer incomplete status');

    nespaSessionRace = { phase: 'old', releases: [] };
    const sessionRaceStart = requests.length;
    await content.evaluate(async () => {
      globalThis.sessionRaceSource = new PlatoCalendarExt.NespaDataSource();
      const settings = await PlatoCalendarExt.nespaSettings.get();
      globalThis.sessionRaceItems = ['001', '13'].map(problemId => PlatoCalendarExt.nespaParser.activityFromCatalog({ problemId, title: 'Session race', deadline: Date.now() / 1000 }, settings));
      globalThis.sessionRaceResult = {};
      sessionRaceSource.getDetail(sessionRaceItems[0], true).then(result => { sessionRaceResult.old = result; });
    });
    for (let attempt = 0; nespaSessionRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
    assert.equal(nespaSessionRace.releases.length, 1);
    nespaSessionRace.phase = 'expired';
    await content.evaluate(async () => { await sessionRaceSource.getDetail(sessionRaceItems[1], true); });
    nespaSessionRace.phase = 'recovered';
    await content.evaluate(() => { sessionRaceSource.getDetail(sessionRaceItems[0], true).then(result => { sessionRaceResult.fresh = result; }); });
    await until(content, () => globalThis.sessionRaceResult.fresh?.submissionCheck === 'verified');
    assert.equal(await content.evaluate(() => sessionRaceResult.fresh.submissionStatus), '미제출');
    nespaSessionRace.releases.splice(0).forEach(release => release());
    await until(content, () => Boolean(globalThis.sessionRaceResult.old));
    await delay(100);
    assert.deepEqual(await content.evaluate(() => ({ old: sessionRaceResult.old.submissionCheck,
      score: sessionRaceSource.details.get('ds2026:001')?.score, status: sessionRaceSource.details.get('ds2026:001')?.submissionStatus })),
    { old: 'failed', score: null, status: '미제출' });
    assert.equal(requests.slice(sessionRaceStart).filter(request => request.source === 'worker' && new URL(request.url).searchParams.get('prob_id') === '001').length, 2);
    await content.evaluate(() => { sessionRaceSource.destroy(); delete globalThis.sessionRaceSource; delete globalThis.sessionRaceItems; delete globalThis.sessionRaceResult; });
    nespaSessionRace = null;
    checks.push('observed native HTTP expiry cancels an older shared worker read; retry uses a second request and late old data cannot replace recovered private status');

    await page.evaluate(() => {
      window.beforeClockMonth = window.fixtureMonth; window.clockMonthCalls = 0;
      window.fixtureMonth = (y, m) => { window.clockMonthCalls++; return window.beforeClockMonth(y, m); };
    });
    const clockCacheStart = requests.length;
    const cacheClockResult = await content.evaluate(async (y, m) => {
      const source = new PlatoCalendarExt.CombinedDataSource(), originalNow = Date.now;
      const activity = { activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=101' };
      try {
        const first = await source.getMonth(y, m, false);
        await Promise.all([source.getSubmission(activity, false), source.getCourseCompletions('9', false)]);
        Date.now = () => originalNow() - 3600000;
        const second = await source.getMonth(y, m, false);
        const [submission, course] = await Promise.all([source.getSubmission(activity, false), source.getCourseCompletions('9', false)]);
        return { before: first.activities.length, after: second.activities.length,
          submission: submission.submissionStatus, course: course.check, nespa: second.providerState.nespa };
      } finally { Date.now = originalNow; source.destroy(); }
    }, year, month);
    assert.deepEqual(cacheClockResult, { before: 4, after: 4, submission: '미제출', course: 'verified', nespa: 'ok' });
    assert.equal(await page.evaluate(() => window.clockMonthCalls), 2);
    const clockCacheRequests = requests.slice(clockCacheStart);
    assert.equal(clockCacheRequests.filter(request => request.source === 'worker' && request.url.includes('/ds2026/assignment_list/')).length, 2);
    assert.equal(clockCacheRequests.filter(request => request.source === 'worker' && request.url.includes('/ds2026/submission_detail/')).length, 6);
    assert.equal(clockCacheRequests.filter(request => request.source === 'page' && /\/(?:mod\/assign\/view|report\/ublogs\/student\/activity)\.php/.test(new URL(request.url).pathname)).length, 4);
    checks.push('installed PLATO month/status and NESPA list/private caches re-read future-dated entries after a simulated one-hour clock rollback');

    await page.evaluate(() => { window.clockMonthCalls = 0; });
    const homeClockStart = requests.length;
    await content.evaluate(() => {
      globalThis.clockOriginalNow = Date.now;
      Date.now = () => clockOriginalNow() - 3600000;
    });
    try {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await until(page, () => window.clockMonthCalls === 1 && !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled &&
        !document.querySelector('.pe-classroom-refresh').disabled && !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
      assert.equal(requests.slice(homeClockStart).filter(request => request.url === 'https://onestop.pusan.ac.kr/main').length, 1);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await delay(50);
      assert.equal(await page.evaluate(() => window.clockMonthCalls), 1);
    } finally { await content.evaluate(() => { Date.now = clockOriginalNow; delete globalThis.clockOriginalNow; }); }
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(page, () => window.clockMonthCalls === 2 && !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled &&
      !document.querySelector('.pe-classroom-refresh').disabled && !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    await page.evaluate(() => { window.fixtureMonth = window.beforeClockMonth; delete window.beforeClockMonth; delete window.clockMonthCalls; });
    await page.evaluate(() => document.querySelector('[data-activity-id="activity:nespa:ds2026:001"]').click());
    await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility());
    const detailClockStart = requests.length;
    await content.evaluate(() => {
      globalThis.clockOriginalNow = Date.now;
      Date.now = () => clockOriginalNow() - 3600000;
    });
    try {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      for (let attempt = 0; !requests.slice(detailClockStart).some(request => request.url.includes('/submission_detail/?prob_id=001')) && attempt < 80; attempt++) await delay(100);
      assert.equal(requests.slice(detailClockStart).filter(request => request.url.includes('/submission_detail/?prob_id=001')).length, 1);
      await until(page, () => !document.querySelector('.plato-calendar-ext-detail-loading').checkVisibility() && !document.querySelector('.pe-classroom-refresh').disabled);
    } finally { await content.evaluate(() => { Date.now = clockOriginalNow; delete globalThis.clockOriginalNow; }); }
    await page.evaluate(() => { document.querySelector('.plato-calendar-ext-modal-header button').click(); document.dispatchEvent(new Event('visibilitychange')); });
    await until(page, () => !document.querySelector('.pe-classroom-refresh').disabled);
    metrics.push({ name: 'simulated content-world clock rollback', offsetMs: -3600000, sourceMonthReads: 2,
      nespaLists: 2, nespaDetails: 6, platoStatusReads: 4, visibleMonthRefreshes: 1, visibleModalRefreshes: 1 });
    checks.push('visible calendar, timetable and open detail resume automatic reads after simulated clock rollback without a repeated-refresh loop');

    const largeStart = await page.evaluate(() => {
      globalThis.largeCalendarVersion = 1;
      window.fixtureMonth = (y, m) => ({ events: Array.from({ length: 200 }, (_, index) => ({
        id: 20001 + index, course: { id: 9, fullname: 'Large fixture course' }, modulename: 'resource',
        name: `Large resource ${index + 1} version ${globalThis.largeCalendarVersion}`,
        timestart: Date.UTC(y, m - 1, globalThis.largeCalendarVersion > 1 && index === 196 ? 2 : index % 28 + 1) / 1000,
        url: `https://plato.pusan.ac.kr/mod/resource/view.php?id=${20001 + index}`
      })) });
      window.fixtureAction = args => {
        const start = args.aftereventid ? args.aftereventid - 100000 : 0;
        return Promise.resolve({ events: Array.from({ length: Math.max(0, Math.min(50, 500 - start)) }, (_, index) => ({
          id: 100001 + start + index, course: { id: 9 }, modulename: 'resource', timestart: args.starttime + 3600,
          url: `https://plato.pusan.ac.kr/mod/resource/view.php?id=${100001 + start + index}`
        })) });
      };
      const started = performance.now();
      document.querySelector('[aria-label="현재 달 일정 새로고침"]').click();
      return started;
    });
    await until(page, () => document.querySelector('.plato-calendar-ext-count').textContent === '203' &&
      !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled &&
      !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다'));
    metrics.push({ name: 'large month load with local fixtures and completion polling', events: 200, actions: 500,
      elapsedMs: await page.evaluate(started => Math.round((performance.now() - started) * 100) / 100, largeStart) });
    const focusedLarge = await page.evaluate(() => {
      document.querySelector('.plato-calendar-ext-more-button').click();
      const items = document.querySelectorAll('.plato-calendar-ext-day-popover [data-activity-id]');
      items[items.length - 1].focus();
      globalThis.largeCalendarVersion = 2;
      return document.activeElement.dataset.activityId;
    });
    await page.evaluate(() => document.querySelector('[aria-label="현재 달 일정 새로고침"]').click());
    await until(page, id => document.querySelector('.plato-calendar-ext-count').textContent === '203' &&
      !document.querySelector('[aria-label="현재 달 일정 새로고침"]').disabled &&
      !document.querySelector('.plato-calendar-ext-load-status').textContent.includes('학습활동 상태를 확인하고 있습니다') &&
      document.activeElement.dataset.activityId === id && document.activeElement.textContent.includes('version 2'), focusedLarge);
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-day-key]').dataset.dayKey), `${year}-${String(month).padStart(2, '0')}-02`);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.plato-calendar-ext-day-popover'))), true);
    await screenshot(page, 'installed-large-calendar.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await until(page, () => document.querySelector('.plato-calendar-ext-day-popover').getBoundingClientRect().width < document.querySelector('.plato-calendar-ext-content').clientWidth);
    const largeMobile = await page.evaluate(() => {
      const focused = document.activeElement.getBoundingClientRect(), area = document.querySelector('.plato-calendar-ext-content').getBoundingClientRect();
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, id: document.activeElement.dataset.activityId,
        inside: focused.left >= area.left && focused.right <= area.right };
    });
    assert.equal(largeMobile.id, focusedLarge); assert.equal(largeMobile.inside, true);
    assert.equal(largeMobile.width, 390);
    assert.ok(largeMobile.scrollWidth <= largeMobile.width, JSON.stringify(largeMobile));
    await screenshot(page, 'installed-large-calendar-mobile.png');
    timetableRace = { releases: [] };
    await page.evaluate(() => {
      document.querySelector('.pe-classroom-enter').focus();
      document.querySelector('.pe-classroom-refresh').click();
    });
    for (let attempt = 0; timetableRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
    assert.equal(timetableRace.releases.length, 1);
    timetableRace.releases.splice(0).forEach(release => release()); timetableRace = null;
    await until(page, () => !document.querySelector('.pe-classroom-refresh').disabled);
    const mobileTimetable = await page.evaluate(() => {
      const target = document.activeElement, bounds = target.getBoundingClientRect();
      const color = getComputedStyle(document.querySelector('.pe-classroom-clock')).color.match(/[\d.]+/g).slice(0, 3).map(Number);
      const linear = color.map(value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      return { focused: target.classList.contains('pe-classroom-enter'), width: innerWidth,
        inside: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
        clockContrastOnWhite: 1.05 / (luminance + 0.05) };
    });
    assert.equal(mobileTimetable.focused, true); assert.equal(mobileTimetable.inside, true); assert.equal(mobileTimetable.width, 390);
    assert.ok(mobileTimetable.clockContrastOnWhite >= 4.5, JSON.stringify(mobileTimetable));
    metrics.push({ name: '390px timetable keyboard and text contrast', ...mobileTimetable });
    await screenshot(page, 'installed-timetable-focus-mobile.png');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), 'plato-calendar-ext-content');
    checks.push('390px timetable focus remains within the mobile viewport, Tab continues to calendar controls, and small clock text meets 4.5:1 contrast on the fixture background');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    checks.push('large month: 200 activities and 500 paged actions load with NESPA retained; full refresh preserves overflow focus and mobile bounds');

    await page.send('Page.navigate', { url: 'https://plato.pusan.ac.kr/course/view.php?id=9' });
    await until(page, () => document.querySelectorAll('.pwf-row').length === 42 && !document.querySelector('.pwf-refresh').disabled);
    assert.deepEqual(await page.evaluate(() => ({ calendar: Boolean(document.querySelector('#plato-calendar-ext-root')),
      timetable: Boolean(document.querySelector('#plato-enhanced-classroom')), assignment: document.querySelector('[data-activity-key="/mod/assign/view.php?id=101"] .pwf-statuses').textContent.includes('제출: 미제출'),
      quiz: document.querySelector('[data-activity-key="/mod/quiz/view.php?id=102"] .pwf-statuses').textContent.includes('8 / 10') })),
    { calendar: false, timetable: false, assignment: true, quiz: true });
    contentContext = await selectContentContext();
    const weeklyClockStart = requests.length;
    await content.evaluate(() => {
      globalThis.clockOriginalNow = Date.now;
      Date.now = () => clockOriginalNow() - 3600000;
    });
    try {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      for (let attempt = 0; !requests.slice(weeklyClockStart).some(request => request.url.includes('mode=sections')) && attempt < 80; attempt++) await delay(100);
      assert.equal(requests.slice(weeklyClockStart).filter(request => request.url.includes('mode=sections')).length, 1);
      await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.querySelector('.pwf-update-status').textContent.includes('갱신'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await delay(50);
      assert.equal(requests.slice(weeklyClockStart).filter(request => request.url.includes('mode=sections')).length, 1);
    } finally { await content.evaluate(() => { Date.now = clockOriginalNow; delete globalThis.clockOriginalNow; }); }
    checks.push('native weekly visibility recovery rechecks materials and statuses after simulated clock rollback and then respects its retry interval');
    weeklyRace = { resource: 'sections', releases: [] };
    const hiddenRequestStart = requests.length;
    const previousMaterials = await page.evaluate(() => {
      document.querySelector('.pwf-refresh').click();
      return document.querySelector('.pwf-body').textContent;
    });
    for (let attempt = 0; weeklyRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
    assert.equal(weeklyRace.releases.length, 1);
    await page.evaluate(() => { document.querySelector('.pwf-panel').parentElement.hidden = true; });
    weeklyRace.releases.splice(0).forEach(release => release()); weeklyRace = null;
    await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.querySelector('.pwf-update-status').textContent.includes('조회가 중단'));
    assert.equal(await page.evaluate(() => document.querySelector('.pwf-body').textContent), previousMaterials);
    assert.equal(requests.slice(hiddenRequestStart).filter(request => request.source === 'page').length, 1);
    await page.evaluate(() => {
      document.querySelector('.pwf-panel').parentElement.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.querySelector('.pwf-update-status').textContent.includes('갱신'));
    checks.push('a late native sections response observes a hidden pane without a visibility event, starts no private status reads and recovers on return');
    const before = await page.evaluate(() => {
      document.querySelector('#weekly-native-draft').value = 'preserved course draft';
      const open = document.querySelector('[data-activity-key="/mod/resource/view.php?id=212"] .pwf-open');
      open.focus(); return open.getBoundingClientRect().top;
    });
    materialVersion = 2;
    await page.evaluate(() => document.querySelector('.pwf-refresh').click());
    await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.activeElement.getAttribute('aria-label')?.includes('version 2'));
    const restored = await page.evaluate(() => ({ key: document.activeElement.closest('.pwf-row').dataset.activityKey,
      action: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top,
      draft: document.querySelector('#weekly-native-draft').value }));
    assert.equal(restored.key, '/mod/resource/view.php?id=212'); assert.equal(restored.action, 'pwf-open');
    assert.ok(Math.abs(restored.top - before) < 2, JSON.stringify({ before, restored }));
    assert.equal(restored.draft, 'preserved course draft');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(() => document.activeElement.closest('.pwf-row')?.dataset.activityKey), '/mod/resource/view.php?id=213');
    checks.push('real weekly entry, assignment/quiz detail reads, focus and scroll retained after added rows, native Tab continues');
    await screenshot(page, 'installed-weekly-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobileTop = await page.evaluate(() => {
      const open = document.querySelector('[data-activity-key="/mod/resource/view.php?id=212"] .pwf-open');
      open.focus(); return open.getBoundingClientRect().top;
    });
    materialVersion = 3;
    await page.evaluate(() => document.querySelector('.pwf-refresh').click());
    await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.activeElement.getAttribute('aria-label')?.includes('version 3'));
    const mobile = await page.evaluate(() => ({ top: document.activeElement.getBoundingClientRect().top, width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(Math.abs(mobile.top - mobileTop) < 2, JSON.stringify({ mobileTop, mobile }));
    assert.ok(mobile.scrollWidth <= mobile.width, JSON.stringify(mobile));
    checks.push('mobile weekly focus and viewport retained without page overflow');
    await screenshot(page, 'installed-weekly-mobile.png');
    removedMaterial = 212;
    await page.evaluate(() => document.querySelector('.pwf-refresh').click());
    await until(page, () => !document.querySelector('.pwf-refresh').disabled && document.activeElement.tagName === 'H4');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.pwf-week')?.dataset.week), '2');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(() => document.activeElement.closest('.pwf-row')?.dataset.activityKey), '/mod/resource/view.php?id=201');
    checks.push('removed material returns focus to its week heading and Tab reaches the first surviving material');

    weeklyRace = { resource: 'detail', releases: [] };
    await page.evaluate(() => document.querySelector('.pwf-refresh').click());
    for (let attempt = 0; weeklyRace.releases.length < 1 && attempt < 80; attempt++) await delay(100);
    assert.equal(weeklyRace.releases.length, 1);
    await page.evaluate(() => { document.querySelector('.pwf-panel').remove(); });
    weeklyRace.releases.splice(0).forEach(release => release()); weeklyRace = null;
    await until(page, () => !document.querySelector('.pwf-panel') && !document.querySelector('.dashboard-section').classList.contains('pwf-hidden'));
    checks.push('a late native assignment check detects a removed weekly panel and restores the original course content without waiting for its timer');

    await page.send('Page.navigate', { url: 'https://emerald.pusan.ac.kr/ds2026/assignment_list/' });
    await until(page, () => document.readyState === 'complete' && document.querySelector('table'));
    assert.deepEqual(await page.evaluate(() => ({ calendar: Boolean(document.querySelector('#plato-calendar-ext-root')),
      bridge: typeof window.__platoCalendarExtBridgeInstalledV1, globals: typeof window.PlatoCalendarExt })),
    { calendar: false, bridge: 'undefined', globals: 'undefined' });
    checks.push('manifest does not inject calendar or bridge into NESPA');
    assert.deepEqual(unexpected, []); assert.deepEqual(session.errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, browser: session.browser, browserVersion: session.version,
      extensionId: extension.id, version: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version,
      scope: 'Installed extension in a fresh profile; HTTPS fully intercepted with anonymous local fixtures; no live authentication.',
      checks, metrics, requests, cancelledRequests, errors: session.errors }, null, 2));
    console.log(`Installed extension smoke passed: ${checks.length} checks in ${session.version}. Evidence: artifacts/extension-smoke.`);
  } catch (error) {
    const diagnostic = page && await page.evaluate(() => ({ url: location.href, visibility: document.visibilityState,
      ready: document.readyState, body: document.body?.innerText, activities: [...document.querySelectorAll('[data-activity-id]')].map(node => node.dataset.activityId) })).catch(() => null);
    if (page) await screenshot(page, 'failure.png').catch(() => {});
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: false, browserVersion: session.version,
      extensionId: extension?.id, checks, metrics, requests, cancelledRequests, unexpected, errors: session.errors, error: error.message, diagnostic }, null, 2));
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
