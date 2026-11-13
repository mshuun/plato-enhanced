(() => {
  'use strict';
  const current = new URL(location.href);
  if (current.searchParams.get('mode') === 'sections') return;
  const cards = [...document.querySelectorAll('.dashboard-section')];
  if (!cards.length) return;
  const refreshIntervalMs = globalThis.PlatoCalendarExt?.config?.cacheTtlMs || 10 * 60 * 1000;
  const controllers = new Set();
  let busy = false, destroyed = false, generation = 0, lastAttempt = 0, lastSuccess = 0;
  const clean = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const decode = value => {
    const text = document.createElement('textarea');
    text.innerHTML = value;
    return text.value;
  };
  const types = {ubfile:'파일', resource:'파일', folder:'폴더', ubfolder:'폴더', assign:'과제', quiz:'퀴즈', vod:'동영상', ubboard:'게시판', url:'링크', forum:'토론'};
  const node = (tag, cls, text) => {
    const el = document.createElement(tag);
    el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  const moduleUrl = (value, base, route = /^\/mod\/[a-z][a-z0-9_]*\/view\.php$/) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      if (url.origin !== current.origin || url.username || url.password || !route.test(url.pathname) ||
          url.searchParams.getAll('id').length !== 1 || !/^[1-9]\d*$/.test(url.searchParams.get('id'))) return null;
      return url;
    } catch (_) { return null; }
  };
  const statusText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const findInlineStatus = (activity, pattern) => {
    const candidates = [...activity.querySelectorAll('.activity-extend-info .text, .activity-extend-info-item, .completion-info, .submissionstatus, .gradestatus')]
      .map(clean).filter(Boolean);
    return candidates.find(value => pattern.test(value)) || '';
  };
  const scoreFromText = text => {
    const source = statusText(text);
    const preferred = [...source.matchAll(/(?:획득\s*점수|내\s*점수|점수)\s*[:：]\s*([0-9]+(?:[.,][0-9]+)?(?:\s*\/\s*[0-9]+(?:[.,][0-9]+)?)?)/g)]
      .find(item => !source.slice(Math.max(0, item.index - 3), item.index).includes('최고'));
    if (preferred) return preferred[1].replace(/\s+/g, '');
    const matches = [...source.matchAll(/(?:점수|성적)\s*[:：]?\s*([0-9]+(?:[.,][0-9]+)?(?:\s*\/\s*[0-9]+(?:[.,][0-9]+)?)?)/g)];
    const match = matches.find(item => !/최고|최대|배점|만점/.test(source.slice(Math.max(0, item.index - 5), item.index)));
    return match ? match[1].replace(/\s+/g, '') : '';
  };
  const activityStatus = (activity, type) => ({
    completion: findInlineStatus(activity, /^(완료|미완료)$/) || (activity.classList.contains('activity-completed') ? '완료' : ''),
    submission: type === 'assign' || type === 'quiz' ? findInlineStatus(activity, /제출/) : '',
    grading: type === 'assign' || type === 'quiz' ? findInlineStatus(activity, /채점|채점됨|미채점/) : '',
    score: type === 'quiz' ? scoreFromText(clean(activity.querySelector('.activity-extend-info'))) : ''
  });
  const appendStatus = (container, label, value, variant) => {
    if (!value) return;
    const chip = node('span', `pwf-status ${variant || ''}`, `${label}: ${value}`);
    container.append(chip);
  };
  const renderStatus = (container, type, status) => {
    container.replaceChildren();
    appendStatus(container, '활동', status.completion, status.completion === '완료' ? 'pwf-done' : 'pwf-pending');
    appendStatus(container, '제출', status.submission || '확인 불가', /^(제출 완료|제출함|제출됨)$/.test(status.submission) ? 'pwf-done' : 'pwf-pending');
    appendStatus(container, '채점', status.grading || '확인 불가', /^(완료|채점됨|채점 완료)$/.test(status.grading) ? 'pwf-done' : 'pwf-pending');
    if (type === 'quiz') {
      if (status.attempt) container.append(node('span', 'pwf-status', status.attempt));
      appendStatus(container, status.scoreLabel || '점수', status.score, 'pwf-score');
    }
  };
  const fetchActivityStatus = async (href, type) => {
    const activity = moduleUrl(href, current);
    if (!activity || !['assign', 'quiz'].includes(type) || activity.pathname !== `/mod/${type}/view.php`) return null;
    // Native links can select another user, attempt, group or an edit action.
    // Automatic checks always read the current user's plain activity view.
    const readUrl = `${activity.origin}${activity.pathname}?id=${activity.searchParams.get('id')}`;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(readUrl, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal});
      if (!response.ok || response.url !== readUrl) return null;
      const detail = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (type === 'quiz') return globalThis.PlatoQuizStatus.parse(detail);
      return globalThis.PlatoCalendarExt?.submissionParser?.readAssignmentStatus(detail) || null;
    } catch (_) {
      return null;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  };
  const host = cards[0].parentElement;
  const panel = node('section', 'pwf-panel');
  const toolbar = node('div', 'pwf-toolbar');
  const panelHeading = node('h3', '', '강의 자료');
  panelHeading.tabIndex = -1;
  toolbar.append(panelHeading);
  const refresh = node('button', 'pwf-toggle pwf-refresh', '새로고침');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', '강의 자료와 과제·퀴즈 상태 새로고침');
  refresh.addEventListener('click', () => load());
  toolbar.append(refresh);
  const toggle = node('button', 'pwf-toggle', '기존 화면 보기');
  toggle.type = 'button';
  toolbar.append(toggle);
  const emptyToggle = node('button', 'pwf-toggle', '빈 주차 보기');
  emptyToggle.type = 'button';
  emptyToggle.hidden = true;
  emptyToggle.setAttribute('aria-pressed', 'false');
  toolbar.insertBefore(emptyToggle, toggle);
  emptyToggle.addEventListener('click', () => {
    const show = panel.classList.toggle('pwf-show-empty');
    emptyToggle.setAttribute('aria-pressed', String(show));
    emptyToggle.textContent = show ? '빈 주차 숨기기' : '빈 주차 보기';
  });
  const body = node('div', 'pwf-body');
  body.setAttribute('aria-live', 'polite');
  const updateStatus = node('p', 'pwf-update-status', '10분마다 자료와 활동 상태를 새로고침합니다.');
  updateStatus.setAttribute('role', 'status');
  updateStatus.setAttribute('aria-live', 'polite');
  panel.append(toolbar, updateStatus, body);
  host.insertBefore(panel, cards[0]);
  let original = false;
  toggle.addEventListener('click', () => {
    original = !original;
    cards.forEach(card => card.classList.toggle('pwf-hidden', !original));
    body.hidden = original;
    emptyToggle.hidden = original || !body.querySelector('.pwf-empty-week');
    toggle.textContent = original ? '자료 바로보기' : '기존 화면 보기';
  });
  function replaceMaterials(fragment) {
    // Capture at commit time: the user may have moved focus while the request ran.
    const focused = document.activeElement;
    const ownsFocus = body.contains(focused) && !body.hidden && !document.hidden && !panel.closest('[hidden]');
    const week = focused?.closest('.pwf-week')?.dataset.week;
    const key = focused?.closest('.pwf-row')?.dataset.activityKey;
    const action = focused?.classList.contains('pwf-open') ? '.pwf-open' : '.pwf-item';
    const top = ownsFocus ? focused.getBoundingClientRect().top : 0;
    body.replaceChildren(fragment);
    if (!ownsFocus || ![document.body, document.documentElement, focused, null].includes(document.activeElement)) return;
    const nextWeek = [...body.querySelectorAll('.pwf-week')].find(item => item.dataset.week === week);
    const nextRow = key ? [...(nextWeek?.querySelectorAll('.pwf-row') || [])].find(item => item.dataset.activityKey === key) : null;
    let target = nextRow?.querySelector(action + '[href]') || nextWeek?.querySelector('h4') || panelHeading;
    if (target.closest('.pwf-empty-week') && !panel.classList.contains('pwf-show-empty')) target = panelHeading;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) {
      const delta = target.getBoundingClientRect().top - top;
      if (delta) window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
    }
  }
  async function load() {
    if (destroyed || busy || document.hidden || panel.closest('[hidden]')) return;
    if (!panel.isConnected) { destroy(); return; }
    const sequence = ++generation;
    busy = true;
    lastAttempt = Date.now();
    refresh.disabled = true;
    updateStatus.textContent = '자료와 과제·퀴즈 상태를 새로고침하고 있습니다…';
    if (!body.childNodes.length) body.replaceChildren(node('p', 'pwf-message', '주차별 자료를 불러오는 중입니다…'));
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const url = new URL(current);
      url.search = '';
      url.searchParams.set('id', current.searchParams.get('id'));
      url.searchParams.set('mode', 'sections');
      url.hash = '';
      const response = await fetch(url.href, {credentials:'same-origin', cache: 'no-store', signal:controller.signal});
      if (!canContinue(sequence)) return;
      const final = new URL(response.url);
      if (!response.ok || final.origin !== current.origin || final.pathname !== '/course/view.php' || final.searchParams.get('id') !== current.searchParams.get('id')) throw new Error('load');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!canContinue(sequence)) return;
      const sections = [...doc.querySelectorAll('li.course-section[data-for="section"]')];
      if (!sections.length) throw new Error('structure');
      const fragment = document.createDocumentFragment();
      const statusJobs = [];
      for (const section of sections) {
        const week = section.dataset.number;
        if (!/^\d+$/.test(week)) continue;
        const box = node('section', 'pwf-week');
        box.dataset.week = week;
        if (section.classList.contains('current')) box.classList.add('pwf-current');
        const heading = node('div', 'pwf-week-heading');
        const weekHeading = node('h4', '', clean(section.querySelector('h3.sectionname')) || `${week}주차`);
        weekHeading.tabIndex = -1;
        heading.append(weekHeading);
        const period = clean(section.querySelector('.section-period-text')).match(/\d+월\s*\d+일\s*-\s*\d+월\s*\d+일/);
        if (period) heading.append(node('span', 'pwf-period', period[0]));
        if (section.classList.contains('current')) heading.append(node('span', 'pwf-now', '이번 주'));
        box.append(heading);
        const list = node('ul', 'pwf-list');
        for (const activity of section.querySelectorAll('[data-for="cmitem"]')) {
          // PLATO folders use a title link instead of the wrapper link used by files/quizzes.
          const source = activity.querySelector('a.activity-container-link')
            || activity.querySelector('.activityname a.aalink[href]');
          const title = clean(activity.querySelector('.activityname')) || decode(activity.querySelector('[data-activityname]')?.dataset.activityname || '');
          if (!title) continue;
          const row = node('li', 'pwf-row');
          const target = moduleUrl(source?.getAttribute('href'), url);
          const href = target?.href;
          if (target) row.dataset.activityKey = `${target.pathname}?id=${target.searchParams.get('id')}`;
          const item = node(href ? 'a' : 'div', 'pwf-item');
          if (href) item.href = href;
          const type = target ? target.pathname.split('/')[2] : [...activity.classList].find(c => c.startsWith('modtype_'))?.slice(8);
          // Extract only the original same-site viewer URL; never execute inline code.
          if (href && type === 'ubfile') {
            const popup = source.getAttribute('onclick')?.match(/window\.open\(\s*['"]([^'"]+)['"]/);
            if (popup) {
              const viewer = moduleUrl(popup[1], url, /^\/mod\/ubfile\/viewer\.php$/);
              if (viewer && viewer.searchParams.get('id') === target.searchParams.get('id')) {
                item.href = viewer.href;
                item.target = '_blank';
                item.rel = 'noopener';
                item.title = '자료를 새 탭에서 열기';
              }
            }
          }
          item.append(node('span', 'pwf-type', types[type] || '활동'));
          const details = node('div', 'pwf-details');
          details.append(node('span', 'pwf-name', title));
          const dates = clean(activity.querySelector('[data-region="activity-dates"]'));
          if (dates) details.append(node('span', 'pwf-dates', dates));
          if (['assign', 'quiz'].includes(type)) {
            const status = node('div', 'pwf-statuses');
            renderStatus(status, type, activityStatus(activity, type));
            details.append(status);
            if (href) {
              statusJobs.push({ href, type, status });
            }
          }
          if (!href) details.append(node('span', 'pwf-dates', clean(activity.querySelector('.availabilityinfo')) || '강의 상세 화면에서 확인'));
          item.append(details);
          row.append(item);
          if (href && ['ubfile', 'resource', 'folder', 'ubfolder'].includes(type)) {
            const open = node('a', 'pwf-open', '열기 ↗');
            open.href = item.href;
            open.target = '_blank';
            open.rel = 'noopener';
            open.setAttribute('aria-label', `${title} 새 탭에서 열기`);
            row.append(open);
          }
          list.append(row);
        }
        box.append(list.children.length ? list : node('p', 'pwf-empty', '공개된 파일이나 활동이 없습니다.'));
        if (!list.children.length && !section.classList.contains('current')) box.classList.add('pwf-empty-week');
        fragment.append(box);
      }
      if (!fragment.childNodes.length) throw new Error('empty');
      replaceMaterials(fragment);
      emptyToggle.hidden = original || !body.querySelector('.pwf-empty-week');
      cards.forEach(card => card.classList.toggle('pwf-hidden', !original));
      let nextJob = 0, failed = 0;
      const worker = async () => {
        while (nextJob < statusJobs.length && canContinue(sequence)) {
          const job = statusJobs[nextJob++];
          const remote = await fetchActivityStatus(job.href, job.type);
          if (!canContinue(sequence)) return;
          if (!remote?.submission) failed += 1;
          // Missing private fields stay unknown; do not revive inline values
          // from before the detail request (for example after reopening a draft).
          renderStatus(job.status, job.type, remote || { completion: '', submission: '', grading: '', score: '' });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (!canContinue(sequence)) return;
      lastSuccess = Date.now();
      const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(lastSuccess);
      updateStatus.textContent = `${time} 갱신 · 10분마다 자동 새로고침${failed ? ' · 일부 활동 상태를 확인하지 못했습니다.' : ''}`;
    } catch (_) {
      if (!canContinue(sequence)) return;
      updateStatus.textContent = '자료를 갱신하지 못했습니다. 로그인 상태를 확인하고 새로고침해 주세요. 다음 주기에 다시 시도합니다.';
      if (!lastSuccess) body.replaceChildren(node('p', 'pwf-message', '자료를 불러오지 못했습니다. 아래 원래 화면을 이용하거나 새로고침해 주세요.'));
      else updateStatus.textContent += ' 표시 중인 자료는 이전 조회 결과입니다.';
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      if (!destroyed && sequence === generation) { busy = false; refresh.disabled = false; }
    }
  }
  function pause() {
    const wasBusy = busy;
    generation += 1;
    controllers.forEach(controller => controller.abort());
    controllers.clear();
    busy = false;
    refresh.disabled = false;
    lastAttempt = 0;
    if (wasBusy) updateStatus.textContent = '조회가 중단되었습니다. 화면이 다시 표시되면 자료와 활동 상태를 다시 확인합니다.';
  }
  function canContinue(sequence) {
    if (destroyed || sequence !== generation) return false;
    if (!panel.isConnected) { destroy(); return false; }
    if (document.hidden || panel.closest('[hidden]')) { pause(); return false; }
    return true;
  }
  function pulse() {
    if (destroyed) return;
    if (!panel.isConnected) { destroy(); return; }
    if (document.hidden || panel.closest('[hidden]')) {
      if (busy) pause();
      return;
    }
    const age = Date.now() - lastAttempt;
    if (!busy && (age < 0 || age >= refreshIntervalMs)) load();
  }
  function pageShow(event) { if (event.persisted) { lastAttempt = 0; pulse(); } }
  function pageHide(event) {
    if (!event.persisted) { destroy(); return; }
    pause();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    clearInterval(refreshTimer);
    controllers.forEach(controller => controller.abort());
    controllers.clear();
    document.removeEventListener('visibilitychange', pulse);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('pagehide', pageHide);
    cards.forEach(card => card.classList.remove('pwf-hidden'));
    panel.remove();
  }
  const refreshTimer = setInterval(pulse, Math.min(60000, refreshIntervalMs));
  document.addEventListener('visibilitychange', pulse);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('pagehide', pageHide);
  if (!document.hidden) load();
})();
