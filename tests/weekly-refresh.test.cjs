const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const INTERVAL = 10 * 60 * 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"><section class="dashboard-section"><input id="native-input" value="original"><details id="native-week" open><summary>Native week</summary></details></section></div></body>', {
    url: 'https://plato.pusan.ac.kr/course/view.php?id=42', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const state = { now: 1800000000000, hidden: Boolean(options.hidden), fail: Boolean(options.fail), version: 1,
    count: options.count || 2, requests: [], intervals: new Map(), nextTimer: 1, active: 0, maximum: 0 };
  w.Date.now = () => state.now;
  Object.defineProperty(w.document, 'hidden', { get: () => state.hidden });
  w.setInterval = callback => { const id = state.nextTimer++; state.intervals.set(id, callback); return id; };
  w.clearInterval = id => state.intervals.delete(id);
  w.PlatoCalendarExt = { config: { cacheTtlMs: INTERVAL } };
  if (options.hiddenPane) w.document.querySelector('#host').hidden = true;
  state.sections = () => `<ul><li class="course-section current" data-for="section" data-number="1"><h3 class="sectionname">Week 1</h3>${Array.from({ length: state.count }, (_, i) => {
    const type = i === 1 ? 'quiz' : 'assign';
    return `<div data-for="cmitem" class="modtype_${type}"><a class="activity-container-link" href="https://plato.pusan.ac.kr/mod/${type}/view.php?id=${i + 1}"><span class="activityname">Task ${i + 1} version ${state.version}</span></a></div>`;
  }).join('')}</li><li class="course-section" data-for="section" data-number="2"><h3 class="sectionname">Empty week</h3></li></ul>`;
  state.detail = url => url.includes('/quiz/') ? `<main id="region-main"><ul class="list-of-attempts"><li><h6>1차</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">${state.version} / 10</span></div></li></ul></main>` :
    `<main id="region-main"><div class="submissionstatustable"><table><tr><th>제출 상태</th><td>${state.version === 1 ? '미제출' : '제출 완료'}</td></tr><tr><th>채점 상태</th><td>채점됨</td></tr></table></div></main>`;
  state.handler = async url => {
    if (url.includes('mode=sections') && state.fail) throw new Error('network');
    return { ok: true, url, text: async () => url.includes('mode=sections') ? state.sections() : state.detail(url) };
  };
  w.fetch = async (url, options) => {
    state.requests.push({ url, options });
    const detail = !url.includes('mode=sections');
    if (detail) { state.active += 1; state.maximum = Math.max(state.maximum, state.active); }
    try { return await state.handler(url, options); }
    finally { if (detail) state.active -= 1; }
  };
  for (const file of ['plato-parser.js', 'submission-parser.js']) w.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  for (const file of ['quiz-status.js', 'content.js']) w.eval(fs.readFileSync(path.join(__dirname, '../weekly', file), 'utf8'));
  state.w = w;
  state.button = () => w.document.querySelector('.pwf-refresh');
  state.pulse = () => [...state.intervals.values()].forEach(callback => callback());
  state.visible = visible => { state.hidden = !visible; w.document.dispatchEvent(new w.Event('visibilitychange')); };
  state.settled = async () => {
    for (let count = 0; count < 30; count += 1) {
      await tick();
      if (!state.button()?.disabled) return;
    }
    throw new Error('Weekly refresh did not settle');
  };
  state.close = () => w.close();
  return state;
}

test('weekly initialization waits until its PLATO pane is visible', async () => {
  const h = harness({ hiddenPane: true });
  try {
    await tick();
    assert.equal(h.requests.length, 0);
    h.w.document.querySelector('#host').hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    await h.settled();
    assert.equal(h.requests.length, 3);
  } finally { h.close(); }
});

for (const fail of [false, true]) {
  test(`weekly ${fail ? 'failed' : 'successful'} refresh can recover after a clock rollback`, async () => {
    const h = harness({ fail });
    try {
      await h.settled(); const before = h.requests.length;
      h.now -= 3600000; h.fail = false; h.version = 2;
      h.pulse(); await h.settled();
      assert.equal(h.requests.length, before + 3);
      assert.match(h.w.document.querySelector('.pwf-body').textContent, /version 2/);
      h.pulse(); await tick(); assert.equal(h.requests.length, before + 3, 'recovery must not create a retry loop');
    } finally { h.close(); }
  });
}

test('weekly work pauses in a hidden PLATO pane and resumes when visible', async () => {
  const h = harness();
  try {
    await h.settled();
    const host = h.w.document.querySelector('#host');
    host.hidden = true;
    h.now += INTERVAL;
    h.pulse(); await tick();
    assert.equal(h.requests.length, 3);
    host.hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    await h.settled();
    assert.equal(h.requests.length, 6);
  } finally { h.close(); }
});

test('switching away during weekly refresh aborts work and cannot start hidden status requests', async () => {
  const h = harness();
  try {
    await h.settled();
    const original = h.handler;
    let finish;
    h.handler = url => new Promise(resolve => { finish = () => resolve({ ok: true, url, text: async () => h.sections() }); });
    h.button().click();
    const request = h.requests.at(-1);
    const host = h.w.document.getElementById('host');
    host.hidden = true;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    assert.equal(request.options.signal.aborted, true);
    finish(); await tick();
    assert.equal(h.requests.length, 4);
    h.handler = original;
    host.hidden = false;
    h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
    await h.settled();
    assert.equal(h.requests.length, 7);
    assert.equal(h.w.document.getElementById('native-input').value, 'original');
  } finally { h.close(); }
});

for (const phase of ['section body', 'detail checks']) {
  for (const hidden of ['pane', 'tab', 'detached panel']) {
    test(`weekly ${phase} discard late results for a ${hidden} without a visibility event`, async () => {
      const h = harness({ hidden: true, count: 7 }), releases = [];
      const normal = h.handler;
      try {
        h.visible(true); await h.settled();
        const before = h.requests.length;
        const host = h.w.document.getElementById('host'), panel = h.w.document.querySelector('.pwf-panel');
        h.version = 2;
        h.handler = async (url, options) => {
          if (phase === 'section body' && url.includes('mode=sections')) return { ok: true, url,
            text: () => new Promise(resolve => releases.push(() => resolve(h.sections()))) };
          if (phase === 'detail checks' && !url.includes('mode=sections')) return new Promise(resolve => {
            releases.push(() => normal(url, options).then(resolve));
          });
          return normal(url, options);
        };
        h.button().click(); await tick();
        assert.equal(releases.length, phase === 'section body' ? 1 : 3);
        const displayed = panel.querySelector('.pwf-body').textContent;
        if (hidden === 'pane') host.hidden = true;
        if (hidden === 'tab') h.hidden = true;
        if (hidden === 'detached panel') panel.remove();
        releases.shift()(); await tick();
        assert.equal(h.requests.length, before + (phase === 'section body' ? 1 : 4), 'no later detail jobs may start');
        assert.equal(panel.querySelector('.pwf-body').textContent, displayed, 'hidden results must not update materials/status');
        const unfinished = h.requests.slice(before + (phase === 'detail checks' ? 2 : 0));
        assert.ok(unfinished.every(request => request.options.signal.aborted), 'the still-pending reads must be aborted');
        releases.splice(0).forEach(release => release()); await tick();
        if (hidden === 'detached panel') {
          assert.equal(h.intervals.size, 0);
          assert.equal(h.w.document.querySelector('.dashboard-section').classList.contains('pwf-hidden'), false);
        } else {
          h.handler = normal; h.version = 3;
          host.hidden = false; h.visible(true); await h.settled();
          assert.equal(h.requests.length, before + (phase === 'section body' ? 1 : 4) + 8);
          assert.match(h.w.document.querySelector('.pwf-body').textContent, /version 3/);
        }
      } finally { releases.splice(0).forEach(release => release()); await tick(); h.close(); }
    });
  }
}

test('weekly manual and periodic refresh reload both materials and assignment/quiz status', async () => {
  const h = harness();
  try {
    await h.settled();
    assert.equal(h.requests.length, 3);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /미제출/);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /1 \/ 10/);
    h.version = 2;
    h.button().click();
    await h.settled();
    assert.equal(h.requests.length, 6);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /version 2/);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /제출 완료/);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /2 \/ 10/);
    h.now += INTERVAL - 1;
    h.pulse(); await tick();
    assert.equal(h.requests.length, 6);
    h.now += 1; h.version = 3;
    h.pulse(); await h.settled();
    assert.equal(h.requests.length, 9);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /version 3/);
    assert.ok(h.requests.every(request => request.options.cache === 'no-store'));
    assert.equal(h.button().disabled, false);
  } finally { h.close(); }
});

test('hidden weekly pages skip network and catch up once when visible', async () => {
  const h = harness({ hidden: true });
  try {
    await tick(); assert.equal(h.requests.length, 0);
    h.pulse(); await tick(); assert.equal(h.requests.length, 0);
    h.visible(true); await h.settled();
    assert.equal(h.requests.length, 3);
    h.visible(false); h.now += INTERVAL; h.version = 2;
    h.pulse(); await tick(); assert.equal(h.requests.length, 3);
    h.visible(true); await h.settled();
    assert.equal(h.requests.length, 6);
    h.visible(true); await tick(); assert.equal(h.requests.length, 6);
  } finally { h.close(); }
});

test('a failed refresh retries once per interval and retains a manual retry button', async () => {
  const h = harness({ fail: true });
  try {
    await h.settled();
    assert.equal(h.requests.length, 1);
    assert.equal(h.button().disabled, false);
    for (let i = 0; i < 5; i += 1) h.pulse();
    await tick(); assert.equal(h.requests.length, 1);
    h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.requests.length, 2);
    h.fail = false; h.button().click(); await h.settled();
    assert.equal(h.requests.length, 5);
    assert.equal(h.w.document.querySelectorAll('.pwf-refresh').length, 1);
  } finally { h.close(); }
});

test('refresh preserves original/empty-week view choices and native input state', async () => {
  const h = harness();
  try {
    await h.settled();
    const native = h.w.document.getElementById('native-input');
    native.value = 'unsaved work';
    [...h.w.document.querySelectorAll('.pwf-toggle')].find(button => button.textContent === '빈 주차 보기').click();
    [...h.w.document.querySelectorAll('.pwf-toggle')].find(button => button.textContent === '기존 화면 보기').click();
    h.version = 2; h.button().click(); await h.settled();
    assert.equal(h.w.document.querySelector('.pwf-body').hidden, true);
    assert.equal(h.w.document.querySelector('.pwf-panel').classList.contains('pwf-show-empty'), true);
    assert.equal(h.w.document.getElementById('native-input'), native);
    assert.equal(native.value, 'unsaved work');
    assert.equal(h.w.document.getElementById('native-week').open, true);
    assert.equal(h.w.document.querySelector('.dashboard-section').classList.contains('pwf-hidden'), false);
  } finally { h.close(); }
});

test('weekly automatic refresh retains the focused activity while its title changes', async () => {
  const h = harness();
  try {
    await h.settled();
    h.w.document.querySelector('.pwf-item').focus();
    const href = h.w.document.activeElement.href;
    h.version = 2; h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.w.document.activeElement.href, href);
    assert.match(h.w.document.activeElement.textContent, /version 2/);
  } finally { h.close(); }
});

test('a removed focused activity returns focus to its surviving week heading', async () => {
  const h = harness();
  try {
    await h.settled();
    const focused = h.w.document.querySelectorAll('.pwf-item')[1];
    focused.focus();
    h.count = 1; h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.w.document.activeElement.tagName, 'H4');
    assert.equal(h.w.document.activeElement.closest('.pwf-week').dataset.week, '1');
  } finally { h.close(); }
});

test('weekly refresh does not steal focus moved to a native input during its request', async () => {
  const h = harness();
  try {
    await h.settled();
    const normal = h.handler;
    let finish;
    h.handler = url => url.includes('mode=sections') ? new Promise(resolve => { finish = () => normal(url).then(resolve); }) : normal(url);
    h.w.document.querySelector('.pwf-item').focus();
    h.version = 2; h.now += INTERVAL; h.pulse(); await tick();
    [...h.w.document.querySelectorAll('.pwf-toggle')].find(button => button.textContent === '기존 화면 보기').click();
    const input = h.w.document.getElementById('native-input');
    input.value = 'typing during refresh'; input.focus();
    finish(); await h.settled();
    assert.equal(h.w.document.activeElement, input);
    assert.equal(input.value, 'typing during refresh');
    assert.equal(h.w.document.querySelector('.pwf-body').hidden, true);
  } finally { h.close(); }
});

test('a file new-tab action retains its focus separately from the primary activity link', async () => {
  const h = harness({ hidden: true });
  h.sections = () => `<li class="course-section current" data-for="section" data-number="1"><h3 class="sectionname">Week 1</h3><div data-for="cmitem" class="modtype_resource"><a class="activity-container-link" href="/mod/resource/view.php?id=11"><span class="activityname">File version ${h.version}</span></a></div></li>`;
  try {
    h.visible(true); await h.settled();
    h.w.document.querySelector('.pwf-open').focus();
    h.version = 2; h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.w.document.activeElement.classList.contains('pwf-open'), true);
    assert.equal(h.w.document.activeElement.getAttribute('aria-label'), 'File version 2 새 탭에서 열기');
  } finally { h.close(); }
});

test('a removed focused week returns focus to the materials heading', async () => {
  const h = harness();
  try {
    await h.settled();
    h.w.document.querySelector('.pwf-item').focus();
    h.sections = () => '<li class="course-section current" data-for="section" data-number="3"><h3 class="sectionname">Replacement week</h3></li>';
    h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.w.document.activeElement.tagName, 'H3');
    assert.equal(h.w.document.activeElement.textContent, '강의 자료');
  } finally { h.close(); }
});

test('duplicate module links retain focus in the correct week when weeks are reordered', async () => {
  const h = harness({ hidden: true });
  h.sections = () => (h.version === 1 ? [1, 2] : [2, 1]).map(week => `<li class="course-section" data-for="section" data-number="${week}"><h3 class="sectionname">Week ${week}</h3><div data-for="cmitem" class="modtype_resource"><a class="activity-container-link" href="/mod/resource/view.php?id=11"><span class="activityname">Same file</span></a></div></li>`).join('');
  try {
    h.visible(true); await h.settled();
    h.w.document.querySelector('.pwf-week[data-week="2"] .pwf-open').focus();
    h.version = 2; h.now += INTERVAL; h.pulse(); await h.settled();
    assert.equal(h.w.document.activeElement.classList.contains('pwf-open'), true);
    assert.equal(h.w.document.activeElement.closest('.pwf-week').dataset.week, '2');
  } finally { h.close(); }
});

test('weekly status refresh limits concurrent detail requests and coalesces busy clicks', async () => {
  const h = harness({ hidden: true, count: 7 });
  const releases = [];
  const normal = h.handler;
  h.handler = (url, options) => url.includes('mode=sections') ? normal(url, options) : new Promise(resolve => releases.push(() => normal(url, options).then(resolve)));
  try {
    h.visible(true); await tick();
    assert.equal(releases.length, 3);
    h.button().click(); h.pulse();
    assert.equal(h.requests.filter(request => request.url.includes('mode=sections')).length, 1);
    for (let round = 0; round < 3; round += 1) { releases.splice(0).forEach(release => release()); await tick(); }
    await h.settled();
    assert.equal(h.maximum, 3);
    assert.equal(h.requests.length, 8);
  } finally { h.close(); }
});

test('BFCache restore refreshes once and detached panels stop their timer', async () => {
  const h = harness();
  try {
    await h.settled();
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide', { persisted: true }));
    h.version = 2;
    h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow', { persisted: true }));
    await h.settled();
    assert.equal(h.requests.length, 6);
    h.w.document.querySelector('.pwf-panel').remove();
    h.now += INTERVAL; h.pulse(); await tick();
    assert.equal(h.requests.length, 6);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.w.document.querySelector('.dashboard-section').classList.contains('pwf-hidden'), false);
  } finally { h.close(); }
});

for (const layout of ['Moodle', 'Coursemos']) {
  test(`weekly assignment status ignores instructions and reads the own ${layout} status area`, async () => {
    const h = harness({ hidden: true, count: 1 });
    const fake = '<div id="intro"><table><tr><th>제출 상태</th><td>제출됨</td></tr><tr><th>채점 상태</th><td>완료</td></tr></table></div>';
    const own = layout === 'Moodle'
      ? '<div class="submissionstatustable"><table><tr><th>제출 상태</th><td>초안 저장</td></tr><tr><th>채점 상태</th><td>채점 대기</td></tr></table></div>'
      : '<section class="csms-box"><header class="csms-box-header"><h5>제출 상태</h5></header><div class="csms-box-content"><ul><li class="cml-item"><span class="cml-label">제출 상태</span><span class="cml-text">초안 저장</span></li><li class="cml-item"><span class="cml-label">채점 상태</span><span class="cml-text">채점 대기</span></li></ul></div></section>';
    h.detail = () => `<body id="page-mod-assign-view"><main id="region-main">${fake}${own}</main></body>`;
    try {
      h.visible(true); await h.settled();
      const text = h.w.document.querySelector('.pwf-statuses').textContent;
      assert.match(text, /제출: 초안 저장/);
      assert.match(text, /채점: 채점 대기/);
      assert.doesNotMatch(text, /제출: 제출됨|채점: 완료/);
    } finally { h.close(); }
  });
}

test('weekly assignment instructions alone cannot establish submitted or graded status', async () => {
  const h = harness({ hidden: true, count: 1 });
  h.detail = () => '<body id="page-mod-assign-view"><main id="region-main"><div id="intro"><div class="submissionstatustable"><table><tr><th>제출 상태</th><td>제출됨</td></tr><tr><th>채점 상태</th><td>완료</td></tr></table></div></div></main></body>';
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelector('.pwf-statuses').textContent;
    assert.match(text, /제출: 확인 불가/);
    assert.match(text, /채점: 확인 불가/);
    assert.doesNotMatch(text, /제출됨|채점: 완료/);
    assert.match(h.w.document.querySelector('.pwf-update-status').textContent, /일부 활동 상태/);
  } finally { h.close(); }
});

test('a fresh weekly draft does not inherit inline submitted or graded fields', async () => {
  const h = harness({ hidden: true, count: 1 });
  const sections = h.sections;
  h.sections = () => sections().replace('</a>', '</a><div class="activity-extend-info"><span class="text">제출 완료</span><span class="text">채점됨</span></div>');
  h.detail = () => '<main id="region-main"><div class="submissionstatustable"><table><tr><th>제출 상태</th><td>초안 저장</td></tr></table></div></main>';
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelector('.pwf-statuses').textContent;
    assert.match(text, /제출: 초안 저장/);
    assert.match(text, /채점: 확인 불가/);
    assert.doesNotMatch(text, /제출 완료|채점됨/);
  } finally { h.close(); }
});

test('failed weekly detail reads clear unverified inline submission and grade', async () => {
  const h = harness({ hidden: true, count: 1 });
  const sections = h.sections;
  h.sections = () => sections().replace('</a>', '</a><div class="activity-extend-info"><span class="text">제출 완료</span><span class="text">채점됨</span></div>');
  const normal = h.handler;
  h.handler = async (url, options) => url.includes('mode=sections') ? normal(url, options) : { ok: false, url };
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelector('.pwf-statuses').textContent;
    assert.match(text, /제출: 확인 불가/);
    assert.match(text, /채점: 확인 불가/);
    assert.doesNotMatch(text, /제출 완료|채점됨/);
    assert.match(h.w.document.querySelector('.pwf-update-status').textContent, /일부 활동 상태/);
  } finally { h.close(); }
});

test('quiz instruction examples cannot replace the own attempt, grade or completion', async () => {
  const h = harness({ hidden: true });
  const detail = h.detail;
  h.detail = url => !url.includes('/quiz/') ? detail(url) : `<main id="region-main">
    <div id="intro"><div id="csms-mod-completion">완료</div><ul class="list-of-attempts"><li><h6>99차</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">999 / 1000</span></div></li></ul><div class="your-grade"><span class="mygrade">999</span><span class="quizgrade">1000</span></div></div>
    <div class="mod-header-extrainfo"><div id="csms-mod-completion"><span class="text">미완료</span></div></div>
    <ul class="list-of-attempts"><li><h6>1차</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">2 / 10</span></div></li></ul>
    <div class="your-grade"><span class="mygrade">2</span><span class="quizgrade">10</span></div></main>`;
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelectorAll('.pwf-statuses')[1].textContent;
    assert.match(text, /1차 응시/);
    assert.match(text, /점수: 2 \/ 10/);
    assert.match(text, /활동: 미완료/);
    assert.doesNotMatch(text, /99차|999|활동: 완료/);
  } finally { h.close(); }
});

test('quiz instructions alone never establish a real attempt or grade', async () => {
  const h = harness({ hidden: true });
  const detail = h.detail;
  h.detail = url => !url.includes('/quiz/') ? detail(url) : '<main id="region-main"><div class="quizintro"><div class="quizstartbuttondiv"><button>시험 응시</button></div><ul class="list-of-attempts"><li><h6>99차</h6><div class="user-info-item-state"><span class="user-info-value">종료</span></div><div class="user-info-item-grade"><span class="user-info-value">999 / 1000</span></div></li></ul><div class="your-grade"><span class="mygrade">999</span></div></div></main>';
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelectorAll('.pwf-statuses')[1].textContent;
    assert.match(text, /제출: 확인 불가/);
    assert.doesNotMatch(text, /제출 완료|미응시|99차|999/);
    assert.match(h.w.document.querySelector('.pwf-update-status').textContent, /일부 활동 상태/);
  } finally { h.close(); }
});

test('a supported own submitted label and grading status remain available after sharing the calendar parser', async () => {
  const h = harness({ hidden: true, count: 1 });
  h.detail = () => '<main id="region-main"><div class="submissionstatustable"><table><tr><th>제출 상태</th><td>제출함</td></tr><tr><th>채점 상태</th><td>채점됨</td></tr></table></div></main>';
  try {
    h.visible(true); await h.settled();
    const text = h.w.document.querySelector('.pwf-statuses').textContent;
    assert.match(text, /제출: 제출 완료/);
    assert.match(text, /채점: 채점됨/);
    assert.doesNotMatch(h.w.document.querySelector('.pwf-update-status').textContent, /일부 활동 상태/);
  } finally { h.close(); }
});

function weekWith(activities) {
  return `<li class="course-section current" data-for="section" data-number="1"><h3 class="sectionname">Week 1</h3>${activities}</li>`;
}

function linkActivity(type, href, title, onclick = '') {
  return `<div data-for="cmitem" class="modtype_${type}"><a class="activity-container-link" href="${href}" onclick="${onclick}"><span class="activityname">${title}</span></a></div>`;
}

for (const viewer of ['https://[', 'https://user:pass@plato.pusan.ac.kr/mod/ubfile/viewer.php?id=1']) {
  test(`an unusable file popup keeps its original link and does not hide other weekly materials: ${viewer}`, async () => {
    const h = harness({ hidden: true });
    h.sections = () => weekWith(
      linkActivity('ubfile', '/mod/ubfile/view.php?id=1', 'Fallback file', `window.open('${viewer}')`) +
      linkActivity('ubfile', '/mod/ubfile/view.php?id=2', 'Normal file', "window.open('/mod/ubfile/viewer.php?id=2')") +
      linkActivity('assign', '/mod/assign/view.php?id=3', 'Normal assignment'));
    try {
      h.visible(true); await h.settled();
      const items = [...h.w.document.querySelectorAll('.pwf-item')];
      assert.equal(items.length, 3);
      assert.equal(items[0].href, 'https://plato.pusan.ac.kr/mod/ubfile/view.php?id=1');
      assert.equal(items[1].href, 'https://plato.pusan.ac.kr/mod/ubfile/viewer.php?id=2');
      assert.match(h.w.document.querySelector('.pwf-statuses').textContent, /제출: 미제출/);
      assert.equal(h.requests.length, 2);
      assert.doesNotMatch(h.w.document.querySelector('.pwf-update-status').textContent, /자료를 갱신하지 못/);
      assert.equal(h.w.document.querySelector('#native-input').value, 'original');
    } finally { h.close(); }
  });
}

test('weekly status reads strip action, user, group and session parameters from native activity links', async () => {
  const h = harness({ hidden: true });
  h.sections = () => weekWith(
    linkActivity('assign', '/mod/assign/view.php?id=7&userid=555&group=99&action=editsubmission&sesskey=example#intro', 'Assignment') +
    linkActivity('quiz', '/mod/quiz/view.php?id=8&attempt=9&userid=555&action=continue#attempt', 'Quiz'));
  try {
    h.visible(true); await h.settled();
    assert.deepEqual(h.requests.slice(1).map(request => request.url).sort(), [
      'https://plato.pusan.ac.kr/mod/assign/view.php?id=7',
      'https://plato.pusan.ac.kr/mod/quiz/view.php?id=8'
    ]);
    for (const { options } of h.requests.slice(1)) {
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
    }
    assert.match(h.w.document.querySelectorAll('.pwf-statuses')[0].textContent, /제출: 미제출/);
    assert.match(h.w.document.querySelectorAll('.pwf-statuses')[1].textContent, /1 \/ 10/);
  } finally { h.close(); }
});

test('invalid module IDs and credential-bearing links stay readable without navigation or status requests', async () => {
  const h = harness({ hidden: true });
  const urls = ['https://user:pass@plato.pusan.ac.kr/mod/assign/view.php?id=1', '/mod/assign/view.php?id=0',
    '/mod/assign/view.php?id=NaN', '/mod/quiz/view.php?userid=555', '/mod/assign/view.php?id=1&id=2'];
  h.sections = () => weekWith(urls.map((url, index) => linkActivity(index === 3 ? 'quiz' : 'assign', url, `Unavailable ${index}`)).join(''));
  try {
    h.visible(true); await h.settled();
    assert.equal(h.requests.length, 1);
    assert.equal(h.w.document.querySelectorAll('.pwf-item').length, urls.length);
    assert.equal(h.w.document.querySelectorAll('a.pwf-item').length, 0);
    assert.equal(h.w.document.querySelectorAll('.pwf-statuses .pwf-done').length, 0);
    assert.match(h.w.document.querySelector('.pwf-body').textContent, /강의 상세 화면에서 확인/);
  } finally { h.close(); }
});

test('a valid activity route selects the status parser when its CSS module type is outdated', async () => {
  const h = harness({ hidden: true });
  h.sections = () => weekWith(linkActivity('assign', '/mod/quiz/view.php?id=8', 'Quiz with outdated metadata'));
  try {
    h.visible(true); await h.settled();
    assert.equal(h.w.document.querySelector('.pwf-type').textContent, '퀴즈');
    assert.match(h.w.document.querySelector('.pwf-statuses').textContent, /제출: 제출 완료/);
    assert.match(h.w.document.querySelector('.pwf-statuses').textContent, /1 \/ 10/);
    assert.equal(h.requests.length, 2);
  } finally { h.close(); }
});

test('a detail response with changed identity parameters stays unknown and can be retried', async () => {
  const h = harness({ hidden: true, count: 1 });
  const normal = h.handler;
  h.handler = async (url, options) => url.includes('mode=sections') ? normal(url, options) :
    { ok: true, url: url + '&userid=555', text: async () => '<main id="region-main"><div class="submissionstatustable"><table><tr><th>제출 상태</th><td>제출 완료</td></tr></table></div></main>' };
  try {
    h.visible(true); await h.settled();
    assert.match(h.w.document.querySelector('.pwf-statuses').textContent, /제출: 확인 불가/);
    assert.doesNotMatch(h.w.document.querySelector('.pwf-statuses').textContent, /제출 완료/);
    assert.match(h.w.document.querySelector('.pwf-update-status').textContent, /일부 활동 상태/);
    h.handler = normal;
    h.button().click(); await h.settled();
    assert.match(h.w.document.querySelector('.pwf-statuses').textContent, /제출: 미제출/);
  } finally { h.close(); }
});
