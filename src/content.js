(function bootstrapPlatoCalendar(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt;
  const config = namespace.config;
  let app = null;
  let mounting = false;
  let debounceTimer = null;

  function isHomePage() {
    return ["/", "/index.php"].includes(window.location.pathname) && document.body && document.body.matches(config.selectors.pageBody);
  }

  async function ensureCalendar() {
    if (app && (!app.root || !app.root.isConnected)) {
      app.destroy();
      app = null;
    }

    if (!isHomePage()) {
      if (app) {
        app.destroy();
        app = null;
      }
      return;
    }

    const ongoingCourses = document.querySelector(config.selectors.ongoingCourses);
    if (!ongoingCourses || !ongoingCourses.parentNode) {
      return;
    }

    const existing = document.getElementById(config.rootId);
    if (existing) {
      if (!app) {
        existing.remove();
        scheduleEnsure();
        return;
      }
      if (existing.nextElementSibling !== ongoingCourses) {
        ongoingCourses.parentNode.insertBefore(existing, ongoingCourses);
      }
      return;
    }
    if (mounting) {
      scheduleEnsure();
      return;
    }

    mounting = true;
    const candidate = new namespace.CalendarView();
    app = candidate;
    try {
      await candidate.mount(ongoingCourses);
      if (app !== candidate || !isHomePage()) {
        candidate.destroy();
        if (app === candidate) {
          app = null;
        }
      }
    } catch (_error) {
      candidate.destroy();
      if (app === candidate) {
        app = null;
      }
      console.warn("[PLATO 달력] 달력 섹션을 초기화하지 못했습니다.");
    } finally {
      mounting = false;
    }
  }

  function scheduleEnsure() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(ensureCalendar, 180);
  }

  function observePage() {
    const target = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !app?.root?.contains(mutation.target) &&
          !app?.modal?.overlay?.contains(mutation.target))) scheduleEnsure();
    });
    observer.observe(target, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleEnsure);
    window.addEventListener("pageshow", scheduleEnsure);
    ensureCalendar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observePage, { once: true });
  } else {
    observePage();
  }
})(globalThis);
