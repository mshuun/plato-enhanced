import assert from "node:assert/strict";
import test from "node:test";

const documentEvents = new EventTarget();
globalThis.document = documentEvents;
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
};

const actionCalls = [];
const calendarRepository = {
  getCalendarMonthData: async () => ({ weeks: [] }),
  getEventById: async (id) => ({ event: { id } })
};
const actionRepository = {
  queryByTime: async (args) => {
    actionCalls.push({ ...args });
    if (!args.aftereventid) {
      return {
        events: Array.from({ length: 50 }, (_, index) => ({ id: index + 1 }))
      };
    }
    return { events: [{ id: 51 }] };
  }
};

window.M = { cfg: { userId: 7, siteId: 1, usertimezone: "Asia/Seoul" } };
window.require = (moduleNames, resolve, reject) => {
  queueMicrotask(() => {
    if (moduleNames[0] === "core_calendar/repository") {
      resolve(calendarRepository);
    } else if (moduleNames[0] === "block_timeline/calendar_events_repository") {
      resolve(actionRepository);
    } else {
      reject(new Error("UNKNOWN_MODULE"));
    }
  });
};

await import("../src/page-bridge.js");

test("requests action events in PLATO-compatible pages of at most 50", async () => {
  const responsePromise = new Promise((resolve) => {
    document.addEventListener("plato-calendar-ext:response:v1", (event) => {
      resolve(JSON.parse(event.detail));
    }, { once: true });
  });

  document.dispatchEvent(new CustomEvent("plato-calendar-ext:request:v1", {
    detail: JSON.stringify({
      requestId: "pagination-test",
      operation: "month",
      year: 2026,
      month: 9
    })
  }));

  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.equal(response.payload.action.events.length, 51);
  assert.equal(actionCalls.length, 2);
  assert.equal(actionCalls[0].limit, 50);
  assert.equal(actionCalls[0].aftereventid, undefined);
  assert.equal(actionCalls[1].limit, 50);
  assert.equal(actionCalls[1].aftereventid, 50);
});
