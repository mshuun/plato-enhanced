import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

test('unified manifest preserves script ordering, execution worlds and packaged assets', async () => {
  assert.equal(manifest.name, 'Plato Enhanced');
  assert.equal(manifest.content_scripts.length, 3);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(manifest.content_scripts[2].matches, ['https://plato.pusan.ac.kr/course/view.php*']);
  assert.deepEqual(manifest.content_scripts[2].js, ['weekly/quiz-status.js', 'weekly/content.js']);
  for (const entry of manifest.content_scripts) {
    for (const file of [...entry.js, ...(entry.css || [])]) {
      assert.ok((await readFile(new URL(file, root))).length);
    }
  }
});

test('calendar and weekly scripts coexist on a course page without mounting a home calendar', async () => {
  const dom = new JSDOM('<main><div class="dashboard-section">original</div></main>', {
    url: 'https://plato.pusan.ac.kr/course/view.php?id=6544', runScripts: 'outside-only'
  });
  let requests = 0;
  dom.window.fetch = async href => {
    requests++;
    return { ok: true, url: String(href), text: async () => '<ul><li class="course-section" data-for="section" data-number="1"><h3 class="sectionname">1주차</h3><ul><li data-for="cmitem" class="modtype_resource"><a class="activity-container-link" href="/mod/resource/view.php?id=12"><span class="activityname">통합 테스트 자료</span></a></li></ul></li></ul>' };
  };
  try {
    for (const entry of manifest.content_scripts.filter(entry => entry.world === 'ISOLATED')) {
      for (const file of entry.js) dom.window.eval(await readFile(new URL(file, root), 'utf8'));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.match(dom.window.document.body.textContent, /통합 테스트 자료/);
    assert.equal(dom.window.document.querySelector('#plato-calendar-ext-root'), null);
    assert.equal(requests, 1);
  } finally {
    dom.window.close();
  }
});
