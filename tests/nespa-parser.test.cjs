const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const settings = { enabled: true, courseUrl: 'https://emerald.pusan.ac.kr/ds2026/', courseName: '자료구조', courseYear: 2026 };
const dom = new JSDOM('', { runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(path.join(__dirname, '../src/nespa-parser.js'), 'utf8'));
const parser = dom.window.PlatoCalendarExt.nespaParser;
const plain = value => JSON.parse(JSON.stringify(value));

test('assignment parser uses headers, preserves leading zeros, and builds same-course links', () => {
  const result = parser.parseAssignments(fixture('nespa-assignments.html'), settings);
  assert.equal(result.authenticated, true);
  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(result.activities, item => item.problemId), ['001', '09', '13']);
  const disk = result.activities[2];
  assert.equal(disk.id, 'activity:nespa:ds2026:13');
  assert.equal(disk.deadline, Date.parse('2026-11-01T22:00:00+09:00') / 1000);
  assert.equal(disk.submissionUrl, 'https://emerald.pusan.ac.kr/ds2026/submission/');
  assert.equal(disk.detailUrl, 'https://emerald.pusan.ac.kr/ds2026/submission_detail/?prob_id=13');
  assert.match(disk.sampleUrl, /13_sample_data\.zip$/);
  assert.deepEqual(plain(disk.assignmentInfo), { maxSize: '10 KB', tokenSize: '1000', timeout: '1', maxTry: '10', evaluation: 'Automatic' });
  assert.equal(result.activities[0].submissionStatus, '확인 필요');
});

test('document input and reordered columns work without fixed column indices', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-assignments.html'), 'text/html');
  for (const row of page.querySelectorAll('table tr')) row.append(row.cells[0]);
  const result = parser.parseAssignments(page, settings);
  assert.equal(result.valid, true);
  assert.equal(result.activities[0].problemId, '001');
  assert.deepEqual(plain(result.activities[0].assignmentInfo), { maxSize: '10 KB', tokenSize: '1000', timeout: '1', maxTry: '10', evaluation: 'Automatic' });
});

test('assignment constraints keep original values including zero under arbitrary column order', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-assignments.html'), 'text/html');
  const first = page.querySelector('tbody tr');
  first.cells[2].textContent = '  0  ';
  first.cells[3].textContent = '0';
  first.cells[4].textContent = '  0.25 (wall time)  ';
  first.cells[5].textContent = 'Unlimited';
  first.cells[8].textContent = 'Manual + Automatic';
  const order = [8, 3, 7, 1, 5, 0, 4, 9, 2, 6];
  for (const row of page.querySelectorAll('table tr')) {
    const cells = [...row.cells];
    row.replaceChildren(...order.map(index => cells[index]));
  }
  const result = parser.parseAssignments(page, settings);
  assert.equal(result.valid, true);
  assert.deepEqual(plain(result.activities[0].assignmentInfo), { maxSize: '0', tokenSize: '0', timeout: '0.25 (wall time)', maxTry: 'Unlimited', evaluation: 'Manual + Automatic' });
});

test('missing and blank assignment constraints stay null without inferred values', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-assignments.html'), 'text/html');
  for (const row of page.querySelectorAll('tbody tr')) for (const index of [2, 3, 4, 5, 8]) row.cells[index].textContent = ' \n ';
  assert.deepEqual(plain(parser.parseAssignments(page, settings).activities[0].assignmentInfo), { maxSize: null, tokenSize: null, timeout: null, maxTry: null, evaluation: null });
  for (const row of page.querySelectorAll('table tr')) for (const index of [8, 5, 4, 3, 2]) row.cells[index].remove();
  const result = parser.parseAssignments(page, settings);
  assert.equal(result.valid, true);
  assert.equal(result.partial, false);
  assert.deepEqual(plain(result.activities[0].assignmentInfo), { maxSize: null, tokenSize: null, timeout: null, maxTry: null, evaluation: null });
});

test('dates use configured course year and KST, including year crossing', () => {
  assert.equal(parser.parseDate('11/1 22:00', 2025).timestamp, Date.parse('2025-11-01T22:00:00+09:00') / 1000);
  assert.equal(parser.dateRange('12/30 00:00', '1/2 22:00', 2026).deadline, Date.parse('2027-01-02T22:00:00+09:00') / 1000);
  assert.equal(parser.parseDate('2/29 22:00', 2026), null);
  assert.equal(parser.parseDate('11/31 22:00', 2026), null);
  assert.equal(parser.parseDate('11/1 24:00', 2026), null);
  assert.equal(parser.dateRange('11/3 00:00', '11/2 22:00', 2026), null);
  assert.equal(parser.parseDate('2025/11/1 00:00', 2026).year, 2025);
  assert.equal(parser.dateRange('12/30 00:00', '2/29 22:00', 2027)?.deadline, Date.parse('2028-02-29T22:00:00+09:00') / 1000);
  assert.equal(parser.dateRange('12/30 00:00', '2/29 22:00', 2028), null);
  assert.equal(parser.dateRange('12/30 00:00', '2/30 22:00', 2027), null);
});

test('malformed deadlines are skipped explicitly rather than inventing a calendar date', () => {
  const html = fixture('nespa-assignments.html').replace('11/1 22:00', 'TBD');
  const result = parser.parseAssignments(html, settings);
  assert.equal(result.valid, true);
  assert.equal(result.partial, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.activities.length, 2);
});

test('an error placeholder is partial rather than a verified empty assignment list', () => {
  const html = fixture('nespa-assignments.html').replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody><tr><td colspan="10">Server error</td></tr></tbody>');
  const result = parser.parseAssignments(html, settings);
  assert.equal(result.partial, true);
  assert.equal(result.activities.length, 0);
});

test('Korean permission and connection errors never establish an empty assignment list', () => {
  for (const message of ['접근 권한이 없습니다.', '과제 목록을 불러올 수 없습니다.', 'No data could be loaded']) {
    const html = fixture('nespa-assignments.html').replace(/<tbody>[\s\S]*?<\/tbody>/,
      `<tbody><tr><td colspan="10">${message}</td></tr></tbody>`);
    const result = parser.parseAssignments(html, settings);
    assert.equal(result.partial, true, message);
    assert.equal(result.activities.length, 0);
  }
});

test('only explicit empty-list messages establish zero submissions', () => {
  const page = message => fixture('nespa-submission-empty.html').replace('<tbody></tbody>',
    `<tbody><tr><td colspan="9">${message}</td></tr></tbody>`);
  for (const message of ['접근 권한이 없습니다.', '제출 내역을 불러올 수 없습니다.', 'No submissions could be loaded']) {
    const result = parser.parseSubmissionDetail(page(message));
    assert.equal(result.valid, false, message);
    assert.equal(result.status, 'unknown', message);
    assert.equal(result.attempts, null, message);
  }
  for (const message of ['제출 내역이 없습니다.', '아직 제출한 기록이 없습니다.', 'No submissions yet', 'No data available in table.']) {
    const result = parser.parseSubmissionDetail(page(message));
    assert.equal(result.valid, true, message);
    assert.equal(result.status, 'unsubmitted', message);
    assert.equal(result.attempts, 0, message);
  }
  for (const message of ['등록된 과제가 없습니다.', 'No assignments found', 'No data available in table.']) {
    const html = fixture('nespa-assignments.html').replace(/<tbody>[\s\S]*?<\/tbody>/,
      `<tbody><tr><td colspan="10">${message}</td></tr></tbody>`);
    assert.equal(parser.parseAssignments(html, settings).partial, false, message);
  }
});

test('only own #score_table rows establish submission status', () => {
  const empty = parser.parseSubmissionDetail(fixture('nespa-submission-empty.html'));
  assert.deepEqual(plain(empty), { authenticated: true, valid: true, status: 'unsubmitted', score: null, attempts: 0 });
  const submitted = parser.parseSubmissionDetail(fixture('nespa-submission-complete.html'));
  assert.deepEqual(plain(submitted), { authenticated: true, valid: true, status: 'submitted', score: 100, attempts: 1 });
  const pending = parser.parseSubmissionDetail(fixture('nespa-submission-complete.html').replace('<td>100</td>', '<td>채점 중</td>'));
  assert.equal(pending.status, 'submitted');
  assert.equal(pending.score, null);
});

test('repeated NESPA submission IDs count once and equivalent numeric scores agree', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  const row = page.querySelector('#score_table tbody tr'), copy = row.cloneNode(true);
  copy.cells[8].textContent = '100.0'; row.parentElement.append(copy);
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.status, 'submitted'); assert.equal(result.attempts, 1); assert.equal(result.score, 100);
  assert.notEqual(result.partial, true);
});

for (const otherScore of ['50', '채점 중']) {
  test(`conflicting repeated submission scores (${otherScore}) retain submission and unique count without inventing a maximum`, () => {
    const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
    const row = page.querySelector('#score_table tbody tr'), copy = row.cloneNode(true);
    copy.cells[8].textContent = otherScore; row.parentElement.append(copy);
    const result = parser.parseSubmissionDetail(page);
    assert.equal(result.valid, true); assert.equal(result.status, 'submitted'); assert.equal(result.attempts, 1);
    assert.equal(result.score, null); assert.equal(result.partial, true);
  });
}

test('a partial submission history keeps positive submission evidence but not complete totals', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  page.querySelector('#score_table tbody').insertAdjacentHTML('beforeend', '<tr><td colspan="9">일부 내역을 불러올 수 없습니다.</td></tr>');
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.valid, true); assert.equal(result.status, 'submitted'); assert.equal(result.partial, true);
  assert.equal(result.attempts, null); assert.equal(result.score, null);
});

test('submission score overflow is not displayed as an infinite maximum', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  page.querySelector('#score_table tbody tr').cells[8].textContent = '9'.repeat(400);
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.status, 'submitted'); assert.equal(result.attempts, 1);
  assert.equal(result.score, null); assert.equal(result.partial, true);
});

test('multiple unique NESPA attempts retain their count and highest verified score', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  const row = page.querySelector('#score_table tbody tr');
  for (const [id, score] of [['1235', '채점 중'], ['1236', '50'], ['1237', '0']]) {
    const copy = row.cloneNode(true); copy.cells[1].textContent = id; copy.cells[8].textContent = score; row.parentElement.append(copy);
  }
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.attempts, 4); assert.equal(result.score, 100); assert.notEqual(result.partial, true);
});

test('a nested explanatory header cannot change the own submission ID or score columns', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  page.querySelector('#score_table').createCaption().innerHTML = '<table><thead><tr><th>제출번호</th><th>점수</th></tr></thead><tbody><tr><td>9999</td><td>999</td></tr></tbody></table>';
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.status, 'submitted'); assert.equal(result.attempts, 1); assert.equal(result.score, 100);
  assert.notEqual(result.partial, true);
});

test('a truncated submitted row keeps its known identity but marks the missing score as partial', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  page.querySelector('#score_table tbody tr').cells[8].remove();
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.status, 'submitted'); assert.equal(result.attempts, 1); assert.equal(result.score, null);
  assert.equal(result.partial, true);
});

test('contradictory empty and real submission rows cannot establish complete history totals', () => {
  const page = new dom.window.DOMParser().parseFromString(fixture('nespa-submission-complete.html'), 'text/html');
  page.querySelector('#score_table tbody').insertAdjacentHTML('beforeend', '<tr><td colspan="9">No submissions yet</td></tr>');
  const result = parser.parseSubmissionDetail(page);
  assert.equal(result.status, 'submitted'); assert.equal(result.partial, true);
  assert.equal(result.attempts, null); assert.equal(result.score, null);
});

test('login and changed layouts never imply unsubmitted', () => {
  assert.equal(parser.parseAssignments(fixture('nespa-login.html'), settings).error, 'auth-required');
  assert.equal(parser.parseSubmissionDetail(fixture('nespa-login.html')).status, 'unknown');
  const broken = fixture('nespa-submission-empty.html').replace('id="score_table"', 'id="new_table"');
  assert.equal(parser.parseSubmissionDetail(broken).valid, false);
  assert.equal(parser.parseSubmissionDetail(broken).status, 'unknown');
});

test('URL validation is restricted to HTTPS NESPA and the selected course', () => {
  for (const value of ['https://example.com/ds2026/a', 'javascript:alert(1)', 'http://emerald.pusan.ac.kr/ds2026/a',
    'https://name:secret@emerald.pusan.ac.kr/ds2026/a', '/other2026/assignment_list/', '/media/other2026/file.pdf', '/ds2026/%2e%2e/logout']) {
    assert.equal(parser.safeUrl(value, settings), null, value);
  }
  assert.equal(parser.safeUrl('/media/ds2026/assignment/sampledata/13/a.zip', settings), 'https://emerald.pusan.ac.kr/media/ds2026/assignment/sampledata/13/a.zip');
  assert.equal(parser.safeUrl('https://emerald.pusan.ac.kr/other2026/submission/?pe_problem=1'), 'https://emerald.pusan.ac.kr/other2026/submission/?pe_problem=1');
});

test('catalog reconstruction discards injected private status and unsafe links', () => {
  const item = parser.activityFromCatalog({ problemId: '001', title: 'Example', deadline: 1800000000,
    problemUrl: 'https://evil.example/file', submissionStatus: '제출됨', score: 100, attempts: 9,
    assignmentInfo: { tokenSize: '0', maxTry: '10', score: '100', attempts: '9', evaluation: {} } }, settings);
  assert.equal(item.problemUrl, null);
  assert.equal(item.submissionStatus, '확인 필요');
  assert.equal(item.score, null);
  assert.equal(item.attempts, null);
  assert.deepEqual(plain(item.assignmentInfo), { maxSize: null, tokenSize: '0', timeout: null, maxTry: '10', evaluation: null });
});

test('legacy catalog entries without constraints still reconstruct assignments', () => {
  const item = parser.activityFromCatalog({ problemId: '001', title: 'Example', deadline: 1800000000 }, settings);
  assert.equal(item.problemId, '001');
  assert.deepEqual(plain(item.assignmentInfo), { maxSize: null, tokenSize: null, timeout: null, maxTry: null, evaluation: null });
});
