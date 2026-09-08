(function initStorage(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const keys = namespace.config.storageKeys;

  function get(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(values, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error("EXTENSION_STORAGE_READ_FAILED"));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function set(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error("EXTENSION_STORAGE_WRITE_FAILED"));
          return;
        }
        resolve();
      });
    });
  }

  function safeScope(scope) {
    const value = String(scope || "default");
    return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "default";
  }

  async function getCollapsed() {
    const result = await get([keys.collapsed]);
    return result[keys.collapsed] === true;
  }

  async function setCollapsed(collapsed) {
    await set({ [keys.collapsed]: Boolean(collapsed) });
  }

  function manualPrefix(scope) {
    return `${keys.manualCompletions}.v2.${safeScope(scope)}.`;
  }

  async function getManualCompletions(scope) {
    if (safeScope(scope) === "default") return {};
    const result = await get(null);
    const legacy = result[keys.manualCompletions]?.[safeScope(scope)];
    const scoped = legacy && typeof legacy === "object" && !Array.isArray(legacy)
      ? Object.fromEntries(Object.entries(legacy).filter(([, value]) => value === true)) : {};
    const prefix = manualPrefix(scope);
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (value === true) scoped[id] = true;
      // Persist false tombstones so a legacy completion cannot reappear.
      else if (value === false) delete scoped[id];
    }
    return scoped;
  }

  async function setManualCompletion(scope, activityId, completed) {
    if (safeScope(scope) === "default") throw new Error("PLATO_USER_UNAVAILABLE");
    if (typeof activityId !== "string" || !/^(calendar|activity):[a-zA-Z0-9:_-]{1,160}$/.test(activityId)) {
      throw new Error("INVALID_ACTIVITY_ID");
    }
    await set({ [manualPrefix(scope) + activityId]: Boolean(completed) });
    return getManualCompletions(scope);
  }

  function subscribe(listener) {
    const changed = (changes, area) => {
      if (area === "local" && Object.keys(changes).some((key) => key.startsWith(keys.manualCompletions))) listener();
    };
    chrome.storage.onChanged?.addListener(changed);
    return () => chrome.storage.onChanged?.removeListener(changed);
  }

  namespace.storage = Object.freeze({
    subscribe,
    getCollapsed,
    getManualCompletions,
    setCollapsed,
    setManualCompletion
  });
})(globalThis);
