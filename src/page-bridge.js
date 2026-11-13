(function installPlatoCalendarBridge() {
  "use strict";

  const REQUEST_EVENT = "plato-calendar-ext:request:v1";
  const RESPONSE_EVENT = "plato-calendar-ext:response:v1";
  const INSTALL_FLAG = "__platoCalendarExtBridgeInstalledV1";
  const MAX_REQUIRE_ATTEMPTS = 120;
  const ACTION_PAGE_SIZE = 50;
  const MAX_ACTION_PAGES = 40;
  const ACTION_TIMEOUT_MS = 4000;

  if (window[INSTALL_FLAG]) {
    return;
  }
  window[INSTALL_FLAG] = true;

  function respond(requestId, ok, payload, errorCode) {
    const response = { requestId, ok };
    if (ok) {
      response.payload = payload;
    } else {
      response.error = errorCode || "PLATO_BRIDGE_ERROR";
    }

    let detail;
    try {
      detail = JSON.stringify(response);
    } catch (_error) {
      detail = JSON.stringify({ requestId, ok: false, error: "PLATO_RESPONSE_SERIALIZE_FAILED" });
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
  }

  function loadAmdModules(moduleNames, signal) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let retryTimer;
      const onAbort = () => finish(reject, new Error("PLATO_AMD_CANCELLED"));

      function finish(settle, value) {
        window.clearTimeout(retryTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        settle(value);
      }

      function tryLoad() {
        if (signal && signal.aborted) {
          onAbort();
          return;
        }
        if (typeof window.require === "function") {
          try {
            window.require(moduleNames, (...modules) => finish(resolve, modules), error => finish(reject, error));
          } catch (error) {
            finish(reject, error);
          }
          return;
        }

        attempts += 1;
        if (attempts >= MAX_REQUIRE_ATTEMPTS) {
          finish(reject, new Error("PLATO_AMD_UNAVAILABLE"));
          return;
        }
        retryTimer = window.setTimeout(tryLoad, 100);
      }

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      tryLoad();
    });
  }

  function toPromise(thenable) {
    return new Promise((resolve, reject) => {
      if (!thenable || typeof thenable.then !== "function") {
        resolve(thenable);
        return;
      }
      thenable.then(resolve, reject);
    });
  }

  function getSafeContext() {
    const config = window.M && window.M.cfg ? window.M.cfg : {};
    const hasUserId = config.userId !== null && config.userId !== undefined && config.userId !== "";
    const hasSiteId = config.siteId !== null && config.siteId !== undefined && config.siteId !== "";
    return {
      userId: hasUserId && Number.isSafeInteger(Number(config.userId)) && Number(config.userId) > 0 ? String(config.userId) : "default",
      siteId: hasSiteId && Number.isSafeInteger(Number(config.siteId)) ? Number(config.siteId) : null,
      timezone: typeof config.usertimezone === "string" ? config.usertimezone : null
    };
  }

  function getPaddedMonthBounds(year, month) {
    const start = new Date(year, month - 1, -6, 0, 0, 0, 0);
    const end = new Date(year, month + 1, 7, 0, 0, 0, 0);
    return {
      starttime: Math.floor(start.getTime() / 1000),
      endtime: Math.floor(end.getTime() / 1000)
    };
  }

  function actionSnapshot(state, complete) {
    return { ...state.lastResult, events: [...state.events], complete };
  }

  async function getActionData(actionRepository, bounds, state) {
    let afterEventId = 0;

    for (let page = 0; page < MAX_ACTION_PAGES; page += 1) {
      if (state.expired) break;
      const args = {
        starttime: bounds.starttime,
        endtime: bounds.endtime,
        limit: ACTION_PAGE_SIZE
      };
      if (afterEventId) {
        args.aftereventid = afterEventId;
      }

      const result = await toPromise(actionRepository.queryByTime(args));
      if (state.expired) break;
      if (!result || !Array.isArray(result.events) || result.events.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        break;
      }
      const batch = result.events;
      state.lastResult = result;
      state.events.push(...batch);
      if (batch.length < ACTION_PAGE_SIZE) {
        return actionSnapshot(state, true);
      }

      const nextAfterEventId = Number(batch[batch.length - 1].id);
      if (!Number.isSafeInteger(nextAfterEventId) || nextAfterEventId <= 0 || nextAfterEventId === afterEventId) {
        break;
      }
      afterEventId = nextAfterEventId;
    }

    return actionSnapshot(state, false);
  }

  async function getMonth(year, month) {
    const [calendarRepository] = await loadAmdModules(["core_calendar/repository"]);

    const monthPromise = toPromise(
      calendarRepository.getCalendarMonthData(year, month, 0, 0, false, false, 1, "month")
    ).then(data => {
      if (!data || typeof data !== "object") throw new Error("PLATO_MONTH_DATA_INVALID");
      return data;
    });

    const bounds = getPaddedMonthBounds(year, month);
    const state = { expired: false, events: [], lastResult: {} };
    const controller = new AbortController();
    let timer;
    let stopActions;
    const actionPromise = Promise.race([
      loadAmdModules(["block_timeline/calendar_events_repository"], controller.signal)
        .then(([actionRepository]) => getActionData(actionRepository, bounds, state))
        .catch(() => actionSnapshot(state, false)),
      new Promise((resolve) => {
        stopActions = () => {
          state.expired = true;
          controller.abort();
          resolve(actionSnapshot(state, false));
        };
        timer = window.setTimeout(stopActions, ACTION_TIMEOUT_MS);
      })
    ]).finally(() => window.clearTimeout(timer));

    try {
      const [monthData, actionData] = await Promise.all([monthPromise, actionPromise]);
      return {
        month: monthData,
        action: actionData,
        context: getSafeContext()
      };
    } finally {
      stopActions();
      window.clearTimeout(timer);
    }
  }

  async function getEvent(eventId) {
    const [calendarRepository] = await loadAmdModules(["core_calendar/repository"]);
    return toPromise(calendarRepository.getEventById(eventId));
  }

  document.addEventListener(REQUEST_EVENT, async (event) => {
    let request;
    try {
      request = JSON.parse(typeof event.detail === "string" ? event.detail : "");
    } catch (_error) {
      return;
    }

    if (!request || typeof request !== "object") return;
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    if (!requestId || requestId.length > 100) {
      return;
    }

    try {
      if (request.operation === "context") {
        respond(requestId, true, getSafeContext());
        return;
      }
      if (request.operation === "month") {
        const year = Number(request.year);
        const month = Number(request.month);
        if (!Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
          respond(requestId, false, null, "INVALID_MONTH");
          return;
        }
        respond(requestId, true, await getMonth(year, month));
        return;
      }

      if (request.operation === "event") {
        const eventId = Number(request.eventId);
        if (!Number.isSafeInteger(eventId) || eventId <= 0) {
          respond(requestId, false, null, "INVALID_EVENT_ID");
          return;
        }
        respond(requestId, true, await getEvent(eventId));
        return;
      }

      respond(requestId, false, null, "UNSUPPORTED_OPERATION");
    } catch (_error) {
      respond(requestId, false, null, "PLATO_DATA_REQUEST_FAILED");
    }
  });
})();
