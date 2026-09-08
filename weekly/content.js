(() => {
  'use strict';
  const current = new URL(location.href);
  if (current.searchParams.get('mode') === 'sections') return;
  const cards = [...document.querySelectorAll('.dashboard-section')];
  if (!cards.length) return;
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
  const statusText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const findInlineStatus = (activity, pattern) => {
    const candidates = [...activity.querySelectorAll('.activity-extend-info .text, .activity-extend-info-item, .completion-info, .submissionstatus, .gradestatus')]
      .map(clean).filter(Boolean);
    return candidates.find(value => pattern.test(value)) || '';
  };
  const valueAfterLabel = (doc, label) => {
    const exact = [...doc.querySelectorAll('th,td,dt,span,div,label,strong')].filter(el => clean(el) === label && !el.querySelector('h1,h2,h3,h4,h5'));
    const candidates = [];
    for (const labelNode of exact) {
      let parent = labelNode.parentElement;
      for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
        const text = clean(parent);
        let value = text.slice(text.indexOf(label) + label.length).trim();
        if (value && value.length < 100 && !/제출 상태|채점 상태|활동 상태|최종 수정|온라인 작성/.test(value)) candidates.push(value);
      }
    }
    return candidates.sort((a,b) => a.length - b.length)[0] || '';
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
    if (!container.children.length) container.append(node('span', 'pwf-status pwf-pending', '상태 정보 없음'));
  };
  const fetchActivityStatus = async (href, type) => {
    if (!href || !['assign', 'quiz'].includes(type)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(href, {credentials: 'same-origin', signal: controller.signal});
      const final = new URL(response.url);
      if (!response.ok || final.origin !== current.origin || final.pathname !== new URL(href).pathname || final.searchParams.get('id') !== new URL(href).searchParams.get('id')) return null;
      const detail = new DOMParser().parseFromString(await response.text(), 'text/html');
      const region = detail.querySelector('#region-main') || detail.body;
      if (type === 'quiz') return globalThis.PlatoQuizStatus.parse(detail);
      // Only read explicitly labelled values, never numbers in quiz descriptions.
      const score = valueAfterLabel(region, '점수') || valueAfterLabel(region, '성적');
      return {
        completion: valueAfterLabel(detail.querySelector('.page-mod-header') || region, '활동 상태'),
        submission: valueAfterLabel(region, '제출 상태'),
        grading: valueAfterLabel(region, '채점 상태'),
        score: type === 'quiz' && /^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s*점)?$/.test(score) ? score : ''
      };
    } catch (_) {
      return null;
    } finally { clearTimeout(timer); }
  };
  const host = cards[0].parentElement;
  const panel = node('section', 'pwf-panel');
  const toolbar = node('div', 'pwf-toolbar');
  toolbar.append(node('h3', '', '강의 자료'));
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
  panel.append(toolbar, body);
  host.insertBefore(panel, cards[0]);
  let original = false;
  toggle.addEventListener('click', () => {
    original = !original;
    cards.forEach(card => card.classList.toggle('pwf-hidden', !original));
    body.hidden = original;
    emptyToggle.hidden = original || !body.querySelector('.pwf-empty-week');
    toggle.textContent = original ? '자료 바로보기' : '기존 화면 보기';
  });
  async function load() {
    body.replaceChildren(node('p', 'pwf-message', '주차별 자료를 불러오는 중입니다…'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const url = new URL(current);
      url.search = '';
      url.searchParams.set('id', current.searchParams.get('id'));
      url.searchParams.set('mode', 'sections');
      url.hash = '';
      const response = await fetch(url.href, {credentials:'same-origin', signal:controller.signal});
      if (!response.ok || new URL(response.url).pathname !== '/course/view.php') throw new Error('load');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const sections = [...doc.querySelectorAll('li.course-section[data-for="section"]')];
      if (!sections.length) throw new Error('structure');
      const fragment = document.createDocumentFragment();
      for (const section of sections) {
        const week = section.dataset.number;
        if (!/^\d+$/.test(week)) continue;
        const box = node('section', 'pwf-week');
        if (section.classList.contains('current')) box.classList.add('pwf-current');
        const heading = node('div', 'pwf-week-heading');
        heading.append(node('h4', '', clean(section.querySelector('h3.sectionname')) || `${week}주차`));
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
          let href;
          try {
            const target = new URL(source?.getAttribute('href'), url);
            if (source && target.origin === current.origin && /^\/mod\/[^/]+\/view\.php$/.test(target.pathname)) href = target.href;
          } catch (_) { /* Non-link activities remain readable. */ }
          const item = node(href ? 'a' : 'div', 'pwf-item');
          if (href) item.href = href;
          const type = [...activity.classList].find(c => c.startsWith('modtype_'))?.slice(8)
            || (href ? new URL(href).pathname.split('/')[2] : undefined);
          // Extract only the original same-site viewer URL; never execute inline code.
          if (href && type === 'ubfile') {
            const popup = source.getAttribute('onclick')?.match(/window\.open\(\s*['"]([^'"]+)['"]/);
            if (popup) {
              const viewer = new URL(popup[1], url);
              if (viewer.origin === current.origin && viewer.pathname === '/mod/ubfile/viewer.php' && viewer.searchParams.get('id') === new URL(href).searchParams.get('id')) {
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
          const initialStatus = activityStatus(activity, type);
          if (['assign', 'quiz'].includes(type)) {
            const status = node('div', 'pwf-statuses');
            renderStatus(status, type, initialStatus);
            details.append(status);
            if (href) {
              fetchActivityStatus(href, type).then(remote => {
                if (remote) {
                  const merged = {...initialStatus, ...Object.fromEntries(Object.entries(remote).filter(([,value]) => value !== ''))};
                  if (type === 'quiz') merged.score = remote.score;
                  renderStatus(status, type, merged);
                }
              });
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
      body.replaceChildren(fragment);
      emptyToggle.hidden = original || !body.querySelector('.pwf-empty-week');
      cards.forEach(card => card.classList.toggle('pwf-hidden', !original));
    } catch (_) {
      body.replaceChildren(node('p', 'pwf-message', '자료를 불러오지 못했습니다. 로그인 상태를 확인하거나 다시 시도해 주세요.'));
      const retry = node('button', 'pwf-toggle', '다시 시도');
      retry.type = 'button';
      retry.addEventListener('click', load);
      body.append(retry);
    } finally { clearTimeout(timeout); }
  }
  load();
})();
