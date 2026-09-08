'use strict';

// Only the PLATO home content script can request this fixed, read-only page.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  let url;
  try { url = new URL(sender.url); } catch (_) { return false; }
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 ||
      url.origin !== 'https://plato.pusan.ac.kr' || !['/', '/index.php'].includes(url.pathname) ||
      message?.type !== 'plato-enhanced:timetable') return false;
  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('https://onestop.pusan.ac.kr/main', {
        credentials: 'include', cache: 'no-store', signal: controller.signal
      });
      const final = new URL(response.url);
      if (!response.ok || final.origin !== 'https://onestop.pusan.ac.kr' || final.pathname !== '/main') {
        respond({ ok: false, reason: 'login' }); return;
      }
      const html = await response.text();
      if (html.length > 3000000) throw new Error('PAGE_TOO_LARGE');
      respond({ ok: true, html });
    } catch (_) { respond({ ok: false, reason: 'unavailable' }); }
    finally { clearTimeout(timeout); }
  })();
  return true;
});
