(function initConfig(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});

  namespace.config = Object.freeze({
    rootId: "plato-calendar-ext-root",
    origin: "https://plato.pusan.ac.kr",
    requestEvent: "plato-calendar-ext:request:v1",
    responseEvent: "plato-calendar-ext:response:v1",
    bridgeTimeoutMs: 20000,
    cacheTtlMs: 10 * 60 * 1000,
    submissionTimeoutMs: 8000,
    defaultTimezone: "Asia/Seoul",
    dueSoonHours: 48,
    maxVisibleItemsPerDay: 3,
    selectors: Object.freeze({
      pageBody: "body#page-site-index",
      dashboard: "body#page-site-index .dashboard-container",
      ongoingCourses: "body#page-site-index .dashboard-container > .ongoing-courses"
    }),
    storageKeys: Object.freeze({
      collapsed: "platoCalendarExt.collapsed",
      manualCompletions: "platoCalendarExt.manualCompletions"
    })
  });
})(globalThis);
