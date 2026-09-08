import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const modelCode = await readFile(new URL('src/class-schedule-model.js', root), 'utf8');
const uiCode = await readFile(new URL('src/class-schedule.js', root), 'utf8');
const background = await readFile(new URL('src/schedule-background.js', root), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 50));
const fixture = `<table id="ptTable"></table><div class="schedule-info"><h5 class="modal-title">AI프로그래밍[062]<span>컴퓨터공학전공, </span></h5><div class="detail-item"><dl>
<dt>강의일자</dt><dd>2026-09-01~ 2026-12-21</dd><dt>강의시간</dt><dd>화요일 09:00 ~ 10:30 (75분)</dd><dt>강의실</dt><dd>102-406</dd>
<dt>강의일자</dt><dd>2026-09-01~ 2026-12-21</dd><dt>강의시간</dt><dd>목요일 09:00 ~ 10:30 (75분)</dd><dt>강의실</dt><dd>102-406</dd>
</dl></div></div>`;
const home = `<body id="page-site-index"><div class="dashboard-container"><div class="dashboard-prompt">산지니 AI</div><div class="ongoing-courses"><a class="course-card" href="https://plato.pusan.ac.kr/course/view.php?id=6544"><h5>AI프로그래밍 (062)</h5></a></div></div></body>`;
function setup() {
  const dom = new JSDOM(home, { url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only' });
  dom.window.eval(modelCode);
  return dom;
}
test('observed timetable parses exact clock ranges, deduplicates modals and matches course + section', () => {
  const dom = setup();
  try {
    const model = dom.window.PlatoCalendarExt.classScheduleModel;
    const parsed = model.parseTimetable(new dom.window.DOMParser().parseFromString(fixture + fixture, 'text/html'));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].start, 540);
    assert.equal(parsed[0].end, 630); // 10:30, not start + the parenthesized 75-minute instruction time.
    assert.equal(parsed[0].room, '102-406');
    const courses = model.readCourses(dom.window.document);
    assert.equal(model.connect(courses, parsed).length, 2);
    assert.equal(model.connect([{ ...courses[0], key: 'AI프로그래밍|059' }], parsed).length, 0);
    assert.equal(model.connect([...courses, { ...courses[0], id: '999' }], parsed).length, 0);
    const bad = fixture.replace('2026-09-01', '2026-02-30').replace('목요일', '알수없는요일');
    assert.equal(model.parseTimetable(new dom.window.DOMParser().parseFromString(bad, 'text/html')).length, 0);
  } finally { dom.window.close(); }
});
test('Korea time, exact boundaries, overlaps, weekends and semester limits', () => {
  const dom = setup();
  try {
    const model = dom.window.PlatoCalendarExt.classScheduleModel;
    const meetings = model.parseTimetable(new dom.window.DOMParser().parseFromString(fixture, 'text/html'));
    const select = time => model.select(meetings, Date.parse(time));
    assert.equal(select('2026-09-08T08:59:59+09:00').active.length, 0);
    assert.equal(select('2026-09-08T09:00:00+09:00').active.length, 1);
    assert.equal(select('2026-09-08T10:29:59+09:00').active.length, 1);
    assert.equal(select('2026-09-08T10:30:00+09:00').active.length, 0);
    assert.equal(select('2026-09-08T00:00:00Z').active.length, 1);
    assert.equal(select('2026-09-12T09:00:00+09:00').active.length, 0);
    assert.equal(select('2026-12-22T09:00:00+09:00').upcoming.length, 0);
    assert.equal(model.select([...meetings, { ...meetings[0], key: 'overlap' }], Date.parse('2026-09-08T09:30:00+09:00')).active.length, 2);
  } finally { dom.window.close(); }
});
test('home replaces only AI prompt, renders live course link, and uses account-scoped cache', async () => {
  const dom = setup();
  let saved, callback;
  try {
    dom.window.Date.now = () => Date.parse('2026-09-08T09:30:00+09:00');
    dom.window.PlatoCalendarExt.PlatoDataSource = class { async getContext() { return { userId: '123' }; } };
    dom.window.chrome = { runtime: { lastError: null, sendMessage(_msg, done) { callback = done; done({ ok: true, html: fixture }); } },
      storage: { local: { get(_keys, done) { done({}); }, set(data, done) { saved = data; done(); } } } };
    dom.window.eval(uiCode); await wait();
    assert.equal(dom.window.document.querySelector('.dashboard-prompt').hidden, true);
    assert.equal(dom.window.document.querySelector('.dashboard-container').firstElementChild.id, 'plato-enhanced-classroom');
    const link = dom.window.document.querySelector('.pe-classroom-enter');
    assert.equal(link.textContent, '강의실 입장 →');
    assert.equal(link.href, 'https://plato.pusan.ac.kr/course/view.php?id=6544');
    assert.match(dom.window.document.querySelector('.pe-classroom-info').textContent, /09:00–10:30/);
    assert.ok(saved['platoEnhanced.timetable.v1.123']);
    assert.ok(callback);
  } finally { dom.window.close(); }
});
test('login failure offers connection and never makes up a live class', async () => {
  const dom = setup();
  try {
    dom.window.PlatoCalendarExt.PlatoDataSource = class { async getContext() { return { userId: '123' }; } };
    dom.window.chrome = { runtime: { lastError: null, sendMessage(_msg, done) { done({ ok: true, html: '<form>로그인</form>' }); } },
      storage: { local: { get(_keys, done) { done({}); } } } };
    dom.window.eval(uiCode); await wait();
    assert.equal(dom.window.document.querySelector('.pe-classroom-enter'), null);
    assert.equal(dom.window.document.querySelector('.pe-classroom-connect').href, 'https://onestop.pusan.ac.kr/main');
    assert.match(dom.window.document.querySelector('.pe-classroom-note').textContent, /로그인/);
  } finally { dom.window.close(); }
});
test('background accepts only home requests and fetches only the fixed timetable URL', async () => {
  let listener, fetched;
  const context = { chrome: { runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } } },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { fetched = { url, options }; return { ok: true, url, text: async () => fixture }; } };
  vm.runInNewContext(background, context);
  const sender = { id: 'extension', url: 'https://plato.pusan.ac.kr/', tab: { id: 1 }, frameId: 0 };
  assert.equal(listener({ type: 'plato-enhanced:timetable' }, { ...sender, url: 'https://example.com/' }, () => {}), false);
  assert.equal(listener({ type: 'plato-enhanced:timetable' }, { ...sender, frameId: 1 }, () => {}), false);
  const response = await new Promise(resolve => listener({ type: 'plato-enhanced:timetable', url: 'https://example.com/' }, sender, resolve));
  assert.equal(fetched.url, 'https://onestop.pusan.ac.kr/main');
  assert.equal(fetched.options.credentials, 'include');
  assert.equal(response.ok, true);
  context.fetch = async () => ({ ok: true, url: 'https://onestop.pusan.ac.kr/login', text: async () => fixture });
  const login = await new Promise(resolve => listener({ type: 'plato-enhanced:timetable' }, sender, resolve));
  assert.equal(login.ok, false);
});

test('fresh account cache avoids fetching; expired and changed-course caches are not shown', async () => {
  for (const mode of ['fresh', 'expired', 'changed']) {
    const dom = setup();
    try {
      const now = Date.parse('2026-09-08T09:30:00+09:00');
      dom.window.Date.now = () => now;
      const model = dom.window.PlatoCalendarExt.classScheduleModel;
      const courses = model.readCourses(dom.window.document);
      const meetings = model.connect(courses, model.parseTimetable(new dom.window.DOMParser().parseFromString(fixture, 'text/html')));
      const fingerprint = courses.map(item => `${item.id}:${item.key}`).sort().join(',');
      const cache = { fingerprint: mode === 'changed' ? 'different' : fingerprint, meetings,
        updated: now - (mode === 'expired' ? 8 * 86400000 : 60000) };
      let fetches = 0;
      dom.window.PlatoCalendarExt.PlatoDataSource = class { async getContext() { return { userId: '456' }; } };
      dom.window.chrome = { runtime: { lastError: null, sendMessage(_msg, done) { fetches++; done({ ok: false }); } },
        storage: { local: { get(keys, done) { assert.equal(keys[0], 'platoEnhanced.timetable.v1.456'); done({ [keys[0]]: cache }); } } } };
      dom.window.eval(uiCode); await wait();
      assert.equal(Boolean(dom.window.document.querySelector('.pe-classroom-enter')), mode === 'fresh', mode);
      assert.equal(fetches, mode === 'fresh' ? 0 : 1);
    } finally { dom.window.close(); }
  }
});
