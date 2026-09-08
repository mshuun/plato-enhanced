import assert from "node:assert/strict";
import test from "node:test";

const values = {};
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        (keys || Object.keys(values)).forEach((key) => {
          if (Object.hasOwn(values, key)) result[key] = values[key];
        });
        callback(result);
      },
      set(next, callback) {
        Object.assign(values, next);
        callback();
      }
    }
  }
};
globalThis.PlatoCalendarExt = {
  config: {
    storageKeys: {
      collapsed: "collapsed",
      manualCompletions: "manual"
    }
  }
};
await import("../src/storage.js");

const storage = globalThis.PlatoCalendarExt.storage;

test("persists collapse state", async () => {
  assert.equal(await storage.getCollapsed(), false);
  await storage.setCollapsed(true);
  assert.equal(await storage.getCollapsed(), true);
});

test("keeps manual completion separate for each PLATO user", async () => {
  await storage.setManualCompletion("user-a", "calendar:10", true);
  assert.deepEqual(await storage.getManualCompletions("user-a"), { "calendar:10": true });
  assert.deepEqual(await storage.getManualCompletions("user-b"), {});
  await storage.setManualCompletion("user-a", "calendar:10", false);
  assert.deepEqual(await storage.getManualCompletions("user-a"), {});
});

test("concurrent activity writes preserve both records", async () => {
  await Promise.all([
    storage.setManualCompletion("user-a", "calendar:21", true),
    storage.setManualCompletion("user-a", "calendar:22", true)
  ]);
  const result = await storage.getManualCompletions("user-a");
  assert.equal(result["calendar:21"], true);
  assert.equal(result["calendar:22"], true);
});

test("legacy values remain readable and cancelled legacy completion does not reappear", async () => {
  values.manual = { "user-b": { "calendar:99": true } };
  assert.equal((await storage.getManualCompletions("user-b"))["calendar:99"], true);
  await storage.setManualCompletion("user-b", "calendar:99", false);
  assert.equal((await storage.getManualCompletions("user-b"))["calendar:99"], undefined);
  await assert.rejects(storage.setManualCompletion("default", "calendar:99", true), /PLATO_USER_UNAVAILABLE/);
});
