const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function environment() {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../src/class-schedule-model.js'), 'utf8'));
  return { model: dom.window.PlatoCalendarExt.classScheduleModel,
    document: html => new dom.window.DOMParser().parseFromString(html, 'text/html'), close: () => dom.window.close() };
}
const card = (href, title = '자료구조 (001)') => `<a class="course-card" href="${href}"><h5>${title}</h5></a>`;

test('timetable course identities reject ambiguous, credential-bearing and noncanonical links while preserving healthy cards', () => {
  const h = environment();
  const malformed = ['/course/view.php?id=9&id=99', '/course/view.php?id=9&id=9',
    'https://name:secret@plato.pusan.ac.kr/course/view.php?id=9', '/course/view.php?id=0', '/course/view.php?id=009',
    '/course/view.php?id=-9', '/course/view.php?id=9e1', '/course/view.php', 'http://plato.pusan.ac.kr/course/view.php?id=9',
    'https://example.com/course/view.php?id=9'];
  try {
    for (const href of malformed) {
      const courses = h.model.readCourses(h.document(`<section class="ongoing-courses">${card(href)}${card('/course/view.php?id=42&mode=sections#week')}</section>`));
      assert.deepEqual(Array.from(courses, course => course.id), ['42'], href);
      assert.equal(courses[0].url, 'https://plato.pusan.ac.kr/course/view.php?id=42');
    }
  } finally { h.close(); }
});

test('identical course-card duplicates collapse but conflicting names for one ID remain excluded in any order', () => {
  const h = environment();
  const first = card('/course/view.php?id=42'), conflict = card('/course/view.php?id=42', '운영체제 (002)');
  const healthy = card('/course/view.php?id=7', '컴파일러 (003)');
  try {
    assert.equal(h.model.readCourses(h.document(`<section class="ongoing-courses">${first}${first}</section>`)).length, 1);
    for (const order of [[first, conflict, first], [conflict, first, first]]) {
      const courses = h.model.readCourses(h.document(`<section class="ongoing-courses">${order.join('')}${healthy}</section>`));
      assert.deepEqual(Array.from(courses, course => course.id), ['7']);
    }
  } finally { h.close(); }
});

test('nameless course cards and timetable entries cannot establish a matching identity', () => {
  const h = environment();
  try {
    assert.equal(h.model.readCourses(h.document(`<section class="ongoing-courses">${card('/course/view.php?id=42', '(001)')}</section>`)).length, 0);
    const timetable = h.document('<div id="ptTable"></div><div class="schedule-info"><h5 class="modal-title">[001]</h5><dt>강의일자</dt><dd>2026-01-01 ~ 2026-12-31</dd><dt>강의시간</dt><dd>금요일 09:00 ~ 11:00</dd></div>');
    assert.equal(h.model.parseTimetable(timetable).length, 0);
  } finally { h.close(); }
});

test('cached meetings cannot bypass the same ambiguous course-name check used by live matching', () => {
  const h = environment();
  try {
    const courses = h.model.readCourses(h.document(`<section class="ongoing-courses">${card('/course/view.php?id=42')}${card('/course/view.php?id=43')}</section>`));
    const meeting = { key: courses[0].key, courseId: '42', day: 5, start: 540, end: 660, from: '2026-01-01', to: '2026-12-31', room: 'Example' };
    assert.equal(h.model.connect(courses, [meeting]).length, 0);
    assert.equal(h.model.validMeeting(meeting, courses), false);
    assert.equal(h.model.validMeeting(meeting, [courses[0]]), true);
  } finally { h.close(); }
});
