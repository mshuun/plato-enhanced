const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the complete manifest course entry shares the assignment parser and renders verified weekly statuses', async () => {
  const url = 'https://plato.pusan.ac.kr/course/view.php?id=42';
  const dom = new JSDOM('<!doctype html><body id="page-course-view"><nav>Native menu</nav><main><section class="dashboard-section"><input id="native-draft" value="unsaved"></section></main></body>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, errors = [], requests = [];
  w.addEventListener('error', event => errors.push(event.message));
  w.fetch = async (href, options) => {
    requests.push({ href, options });
    const target = new URL(href);
    let html;
    if (target.pathname === '/course/view.php' && target.searchParams.get('mode') === 'sections') {
      html = '<li class="course-section current" data-for="section" data-number="1"><h3 class="sectionname">Week 1</h3>' +
        '<div data-for="cmitem" class="modtype_assign"><a class="activity-container-link" href="/mod/assign/view.php?id=7"><span class="activityname">Assignment</span></a></div>' +
        '<div data-for="cmitem" class="modtype_quiz"><a class="activity-container-link" href="/mod/quiz/view.php?id=8"><span class="activityname">Quiz</span></a></div></li>';
    } else if (target.pathname === '/mod/assign/view.php') {
      html = '<body id="page-mod-assign-view"><main id="region-main"><section class="csms-box"><header class="csms-box-header"><h5>제출 상태</h5></header><div class="csms-box-content"><ul><li class="cml-item"><span class="cml-label">제출 상태</span><span class="cml-text">초안 저장</span></li></ul></div></section></main></body>';
    } else if (target.pathname === '/mod/quiz/view.php') {
      html = '<main id="region-main"><ul class="list-of-attempts"><li><h6>1차</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">2 / 10</span></div></li></ul></main>';
    } else throw new Error('Unexpected request: ' + target.pathname);
    return { ok: true, url: target.href, text: async () => html };
  };
  try {
    const manifest = JSON.parse(read('manifest.json'));
    for (const entry of manifest.content_scripts) {
      if (!entry.matches.some(pattern => pattern === 'https://plato.pusan.ac.kr/*' || pattern === 'https://plato.pusan.ac.kr/course/view.php*')) continue;
      for (const file of entry.js || []) w.eval(read(file));
    }
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    for (let count = 0; count < 30; count += 1) {
      await tick();
      if (w.document.querySelector('.pwf-refresh')?.disabled === false) break;
    }
    assert.equal(w.document.querySelector('.pwf-refresh')?.disabled, false);
    const statuses = [...w.document.querySelectorAll('.pwf-statuses')].map(node => node.textContent);
    assert.equal(statuses.length, 2);
    assert.match(statuses[0], /제출: 초안 저장/);
    assert.match(statuses[1], /제출: 제출 완료/);
    assert.match(statuses[1], /2 \/ 10/);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.options.cache === 'no-store'));
    assert.equal(w.document.querySelector('nav').textContent, 'Native menu');
    assert.equal(w.document.getElementById('native-draft').value, 'unsaved');
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
