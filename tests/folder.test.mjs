import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const code = await readFile(new URL('../weekly/content.js', import.meta.url), 'utf8');

test('observed PLATO folder title links produce separate open buttons', async () => {
  const dom = new JSDOM('<main><div class="dashboard-section">original</div></main>', {
    url: 'https://plato.pusan.ac.kr/course/view.php?id=6549', runScripts: 'outside-only'
  });
  const folder = (id, name, href) => `<li class="activity activity-wrapper folder modtype_folder hasinfo activity-completed" id="module-${id}" data-for="cmitem" data-id="${id}"><div class="activity-item" data-activityname="${name}"><div class="activity-container"><div class="activity-name-area"><div class="activitytitle modtype_folder"><div class="activityname"><a href="${href}" class="aalink stretched-link" onclick=""><span class="instancename">${name}<span class="accesshide"> 폴더</span></span></a></div></div></div></div></div></li>`;
  dom.window.fetch = async href => ({ ok: true, url: String(href), text: async () =>
    `<ul><li class="course-section" data-for="section" data-number="1"><h3 class="sectionname">1주차</h3><ul>${folder(4038, 'Lecture Notes', 'https://plato.pusan.ac.kr/mod/folder/view.php?id=4038')}${folder(60569, 'Java Static Test Code', '/mod/folder/view.php?id=60569')}${folder(999, 'Invalid folder', 'https://example.com/mod/folder/view.php?id=999')}</ul></li></ul>` });
  try {
    dom.window.eval(code);
    await new Promise(resolve => setTimeout(resolve, 30));
    const buttons = [...dom.window.document.querySelectorAll('.pwf-open')];
    assert.deepEqual(buttons.map(button => button.href), [
      'https://plato.pusan.ac.kr/mod/folder/view.php?id=4038',
      'https://plato.pusan.ac.kr/mod/folder/view.php?id=60569'
    ]);
    for (const button of buttons) {
      assert.equal(button.target, '_blank');
      assert.equal(button.rel, 'noopener');
      assert.equal(button.textContent, '열기 ↗');
    }
    assert.equal(dom.window.document.querySelectorAll('.pwf-item[href]').length, 2);
  } finally { dom.window.close(); }
});
