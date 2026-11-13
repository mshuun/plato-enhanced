(function initDataSource(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const config = namespace.config;
  const parser = namespace.parser;
  const userScopeOf = context => {
    const id = String(context?.userId || "");
    return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? id : "default";
  };

  class PlatoDataSource {
    constructor() {
      this.monthCache = new Map();
      this.monthPending = new Map();
      this.pending = new Map();
      this.submissionCache = new Map();
      this.submissionPending = new Map();
      this.completionCache = new Map();
      this.completionPending = new Map();
      this.controllers = new Set();
      this.userScope = "default";
      this.scopeGeneration = 0;
      this.contextSequence = 0;
      this.appliedContextSequence = 0;
      this.destroyed = false;
      this.boundResponse = this.handleResponse.bind(this);
      document.addEventListener(config.responseEvent, this.boundResponse);
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.invalidateUserData();
      document.removeEventListener(config.responseEvent, this.boundResponse);
      this.pending.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId);
        reject(new Error("PLATO_DATA_SOURCE_DESTROYED"));
      });
      this.pending.clear();
    }

    invalidateUserData() {
      this.scopeGeneration += 1;
      this.monthCache.clear();
      this.monthPending.clear();
      this.submissionCache.clear();
      this.completionCache.clear();
      this.submissionPending.clear();
      this.completionPending.clear();
      this.controllers.forEach(controller => controller.abort());
      this.controllers.clear();
    }

    assertCurrent(generation) {
      if (this.destroyed) throw new Error("PLATO_DATA_SOURCE_DESTROYED");
      if (generation !== this.scopeGeneration) throw new Error("PLATO_ACCOUNT_CHANGED");
    }

    request(operation, parameters) {
      if (this.destroyed) {
        return Promise.reject(new Error("PLATO_DATA_SOURCE_DESTROYED"));
      }
      const requestId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error("PLATO_DATA_REQUEST_TIMEOUT"));
        }, config.bridgeTimeoutMs);

        this.pending.set(requestId, { resolve, reject, timeoutId });
        const detail = JSON.stringify({ requestId, operation, ...parameters });
        document.dispatchEvent(new CustomEvent(config.requestEvent, { detail }));
      });
    }

    handleResponse(event) {
      let response;
      try {
        response = JSON.parse(typeof event.detail === "string" ? event.detail : "");
      } catch (_error) {
        return;
      }
      if (!response || typeof response !== "object") return;
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timeoutId);
      this.pending.delete(response.requestId);
      if (response.ok) {
        pending.resolve(response.payload);
      } else {
        pending.reject(new Error(response.error || "PLATO_DATA_REQUEST_FAILED"));
      }
    }

    async getMonth(year, month, forceRefresh) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      if (forceRefresh) {
        // Even a failed context check must not let a prior snapshot reappear.
        this.monthCache.delete(key);
        this.monthPending.delete(key);
      }
      // The context bridge is local; checking it does not make an HTTP request.
      // Do this before a cache hit so another observed account cannot see it.
      await this.getContext();
      const generation = this.scopeGeneration;
      if (!forceRefresh && this.monthPending.has(key)) return this.monthPending.get(key).promise;
      const cached = this.monthCache.get(key);
      const age = Date.now() - cached?.fetchedAt;
      if (!forceRefresh && cached && age >= 0 && age < config.cacheTtlMs) {
        return cached;
      }
      // A forced refresh replaces this month's request and cache. Ordinary
      // readers join it; an older response must never revive an old snapshot.
      this.monthCache.delete(key);
      const pending = {};
      pending.promise = (async () => {
        const payload = await this.request("month", { year, month });
        this.assertCurrent(generation);
        if (this.monthPending.get(key) !== pending) throw new Error("PLATO_MONTH_OBSOLETE");
        if (userScopeOf(payload?.context) !== this.userScope) {
          this.invalidateUserData();
          throw new Error("PLATO_ACCOUNT_CHANGED");
        }
        const result = {
          activities: parser.normalizeMonthPayload(payload),
          userScope: this.userScope,
          timezone: payload && payload.context ? payload.context.timezone : null,
          fetchedAt: Date.now(), partial: payload?.action?.complete === false
        };
        this.monthCache.set(key, result);
        return result;
      })().finally(() => { if (this.monthPending.get(key) === pending) this.monthPending.delete(key); });
      this.monthPending.set(key, pending);
      return pending.promise;
    }

    async getContext() {
      const sequence = ++this.contextSequence;
      const context = await this.request("context", {});
      if (this.destroyed) throw new Error("PLATO_DATA_SOURCE_DESTROYED");
      if (sequence < this.appliedContextSequence) throw new Error("PLATO_ACCOUNT_CHANGED");
      this.appliedContextSequence = sequence;
      const scope = userScopeOf(context);
      if (scope !== this.userScope) {
        this.invalidateUserData();
        this.userScope = scope;
      }
      return context;
    }

    updateActivities(activities) {
      if (!activities.length) return;
      const updates = new Map(activities.map(activity => [activity.id, activity]));
      this.monthCache.forEach((month) => {
        month.activities = month.activities.map(item => updates.has(item.id) ? { ...updates.get(item.id) } : item);
      });
    }

    getSubmission(activity, forceRefresh = false) {
      return this.getStatus(namespace.submissionParser.assignmentUrl(activity.activityUrl), forceRefresh,
        this.submissionCache, this.submissionPending, "submissionCheckedAt", url => this.fetchSubmission(url));
    }

    getCourseCompletions(courseId, forceRefresh = false) {
      return this.getStatus(namespace.submissionParser.reportUrl(courseId), forceRefresh,
        this.completionCache, this.completionPending, "checkedAt", url => this.fetchCourseCompletions(url));
    }

    async getStatus(url, forceRefresh, cache, pending, timestamp, read) {
      if (!url || this.destroyed || this.userScope === "default") return null;
      const generation = this.scopeGeneration;
      const key = `${this.userScope}|${url}`;
      if (!forceRefresh && pending.has(key)) return pending.get(key);
      const cached = cache.get(key);
      const age = Date.now() - cached?.[timestamp];
      if (!forceRefresh && cached && age >= 0 && age < config.cacheTtlMs) return cached;
      cache.delete(key);
      const task = read(url).then((result) => {
        if (this.destroyed || generation !== this.scopeGeneration) return null;
        // Existing readers also need the newer status: returning their old
        // result (or an empty result) could undo a newer open-detail update.
        if (pending.get(key) !== task) return pending.get(key) || cache.get(key) || null;
        cache.set(key, result);
        return result;
      }).finally(() => { if (pending.get(key) === task) pending.delete(key); });
      pending.set(key, task);
      return task;
    }

    async fetchSubmission(url) {
      try {
        const html = await this.fetchStatusPage(url);
        return { ...namespace.submissionParser.parseDetails(html), submissionCheckedAt: Date.now() };
      } catch (_error) {
        return { submissionStatus: null, submissionCheck: "failed", submissionCheckedAt: Date.now() };
      }
    }

    async fetchCourseCompletions(url) {
      try {
        const entries = namespace.submissionParser.parseCourse(await this.fetchStatusPage(url));
        return { entries: entries || {}, check: entries ? "verified" : "unavailable", checkedAt: Date.now() };
      } catch (_error) {
        return { entries: {}, check: "failed", checkedAt: Date.now() };
      }
    }

    async fetchStatusPage(url) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), config.submissionTimeoutMs);
      try {
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok || response.url !== url) throw new Error("STATUS_REQUEST_FAILED");
        const html = await response.text();
        if (html.length > 5000000) throw new Error("SUBMISSION_RESPONSE_TOO_LARGE");
        return html;
      } finally {
        window.clearTimeout(timeout);
        this.controllers.delete(controller);
      }
    }

    async getDetail(eventId) {
      if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) <= 0) {
        return null;
      }
      const generation = this.scopeGeneration;
      const detail = await this.request("event", { eventId: Number(eventId) });
      this.assertCurrent(generation);
      return detail;
    }
  }

  namespace.PlatoDataSource = PlatoDataSource;
})(globalThis);
