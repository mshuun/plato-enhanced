import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Structure observed on authenticated PLATO, 2026-09-07.
// All titles, IDs, and content below are synthetic; no submission files or identity data are retained.
const assignment = (status = '제출 완료', completion = '완료') => `<!doctype html><body id="page-mod-assign-view">
<div class="mod-header-extrainfo"><div class="extrainfo-item"><div class="item-text"><span id="csms-mod-completion"><div class="csms-chips csms-chips-dot csms-chips-blue"><svg></svg><span class="text">${completion}</span></div></span></div></div></div>
<section id="region-main"><div id="intro">설명에 제출 완료를 언급해도 판정하지 않는다.</div>
<div class="csms-box csms-box-md"><div class="csms-box-header"><h5 class="csms-title csms-title-md">제출 상태</h5></div>
<div class="csms-box-content"><ul><li class="cml-item"><div class="cml-label"><svg></svg>제출 상태</div><div class="cml-text"><div class="csms-chips csms-chips-dot csms-chips-lg csms-chips-blue"><svg></svg>${status}</div></div></li>
<li class="cml-item"><div class="cml-label"><svg></svg>채점 상태</div><div class="cml-text submissionnotgraded"><div class="csms-chips csms-chips-dot csms-chips-lg csms-chips-red"><svg></svg>미채점</div></div></li></ul></div></div></section></body>`;
const row = (id, module, status, prefix = '') => `<tr>${prefix}<td class="td-cell td-activity"><a href="https://plato.pusan.ac.kr/mod/${module}/view.php?id=${id}">활동</a></td><td class="td-cell td-status"><div class="csms-chips csms-chips-dot csms-chips-blue csms-chips-status"><svg></svg>${status}</div></td><td class="td-cell td-date"></td></tr>`;
const report = (rows) => `<!doctype html><body id="page-report-ublogs-student-activity"><section id="region-main"><table class="table table-coursemos table-bordered table-lg table-learning-student-activity"><thead><tr><th>주차</th><th>학습활동명</th><th>완료 상태</th><th>완료 일시</th></tr></thead><tbody>${rows}</tbody></table></section></body>`;

async function setup() {
  const dom = new JSDOM('', { url: 'https://plato.pusan.ac.kr/', runScripts: 'outside-only' });
  for (const file of ['config', 'plato-parser', 'submission-parser', 'calendar-model', 'data-source']) {
    dom.window.eval(await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8'));
  }
  return dom;
}

test('PLATO list layout distinguishes submission from grading and reads header completion', async () => {
  const dom = await setup();
  try {
    const p = dom.window.PlatoCalendarExt.submissionParser;
    const result = p.parseDetails(assignment());
    assert.equal(result.submissionStatus, '제출 완료');
    assert.equal(result.sourceStatus.code, 'completed');
    assert.equal(result.completionCheck, 'verified');
    const negative = p.parseDetails(assignment('미제출', '미완료'));
    assert.equal(negative.submissionStatus, '미제출');
    assert.equal(negative.sourceStatus.code, 'incomplete');
    assert.equal(p.parse(assignment().replace('제출 상태</h5>', '다른 정보</h5>')), null);
    assert.equal(p.parse(assignment().replace('id="page-mod-assign-view"', 'id="page-login-index"')), null);
    assert.equal(p.parse(assignment().replace('id="region-main"', 'id="intro"')), null);
  } finally { dom.window.close(); }
});

test('PLATO course report maps module links despite week rowspans', async () => {
  const dom = await setup();
  try {
    const p = dom.window.PlatoCalendarExt.submissionParser;
    const html = report(row(10, 'assign', '완료', '<td rowspan="3">1주차</td>') + row(11, 'quiz', '완료') + row(12, 'quiz', '미완료'));
    const result = p.parseCourse(html);
    assert.equal(Object.keys(result).length, 3);
    assert.equal(result['https://plato.pusan.ac.kr/mod/assign/view.php?id=10'].code, 'completed');
    assert.equal(result['https://plato.pusan.ac.kr/mod/quiz/view.php?id=11'].code, 'completed');
    assert.equal(result['https://plato.pusan.ac.kr/mod/quiz/view.php?id=12'].code, 'incomplete');
    assert.equal(p.parseCourse('<body id="page-login-index"></body>'), null);
    const conflict = p.parseCourse(report(row(11, 'quiz', '완료') + row(11, 'quiz', '미완료')));
    assert.equal(Object.keys(conflict).length, 0);
  } finally { dom.window.close(); }
});

test('live-layout fetching produces submitted assignments and completed/incomplete quizzes', async () => {
  const dom = await setup();
  const w = dom.window;
  let ds;
  try {
    const p = w.PlatoCalendarExt.submissionParser;
    let calls = 0;
    w.fetch = async (url) => {
      calls++;
      return { ok: true, url, text: async () => url.includes('/report/') ? report(row(11, 'quiz', '완료') + row(12, 'quiz', '미완료')) : assignment() };
    };
    ds = new w.PlatoCalendarExt.PlatoDataSource();
    const [a, b] = await Promise.all([ds.getCourseCompletions('3'), ds.getCourseCompletions('3')]);
    assert.equal(calls, 1);
    assert.equal(a.check, 'verified');
    assert.equal(b.check, 'verified');
    const model = w.PlatoCalendarExt.calendarModel;
    for (const [id, expected] of [[11, 'completed'], [12, 'incomplete']]) {
      const url = `https://plato.pusan.ac.kr/mod/quiz/view.php?id=${id}`;
      assert.equal(model.classifyActivity({ deadline: 9999999999, typeCode: 'quiz', sourceStatus: a.entries[url] }, false, 1, 48).code, expected);
    }
    const submission = await ds.getSubmission({ activityUrl: 'https://plato.pusan.ac.kr/mod/assign/view.php?id=10' });
    assert.equal(model.classifyActivity({ ...submission, deadline: 1, typeCode: 'assign' }, false, 2, 48).code, 'submitted');
    assert.equal(p.reportUrl('3&userid=4'), null);
    w.fetch = async () => { throw new Error('login redirect'); };
    assert.equal((await ds.getCourseCompletions('3', true)).check, 'failed');
  } finally { ds?.destroy(); w.close(); }
});
