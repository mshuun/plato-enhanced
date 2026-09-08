(function initDataSource(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const config = namespace.config;
  const parser = namespace.parser;

  class PlatoDataSource {
    constructor() {
      this.monthCache = new Map();
      this.pending = new Map();
      this.submissionCache = new Map();
      this.submissionPending = new Map();
      this.completionCache = new Map();
      this.completionPending = new Map();
      this.controllers = new Set();
      this.userScope = "default";
      this.destroyed = false;
      this.boundResponse = this.handleResponse.bind(this);
      document.addEventListener(config.responseEvent, this.boundResponse);
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      document.removeEventListener(config.responseEvent, this.boundResponse);
      this.pending.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId);
        reject(new Error("PLATO_DATA_SOURCE_DESTROYED"));
      });
      this.pending.clear();
      this.controllers.forEach((controller) => controller.abort());
      this.controllers.clear();
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
      if (!forceRefresh && this.monthCache.has(key) && Date.now() - this.monthCache.get(key).fetchedAt < config.cacheTtlMs) {
        return this.monthCache.get(key);
      }
      const payload = await this.request("month", { year, month });
      const result = {
        activities: parser.normalizeMonthPayload(payload),
        userScope: payload && payload.context && payload.context.userId
          ? String(payload.context.userId)
          : "default",
        timezone: payload && payload.context ? payload.context.timezone : null
      };
      if (this.userScope !== result.userScope) {
        this.submissionCache.clear();
        this.completionCache.clear();
      }
      this.userScope = result.userScope;
      result.fetchedAt = Date.now();
      result.partial = payload?.action?.complete === false;
      this.monthCache.set(key, result);
      return result;
    }

    getContext() {
      return this.request("context", {});
    }

    updateActivity(activity) {
      this.monthCache.forEach((month) => {
        month.activities = month.activities.map((item) => item.id === activity.id ? { ...activity } : item);
      });
    }

    async getSubmission(activity, forceRefresh = false) {
      const url = namespace.submissionParser.assignmentUrl(activity.activityUrl);
      if (!url || this.destroyed) return null;
      const key = `${this.userScope}|${url}`;
      const cached = this.submissionCache.get(key);
      if (!forceRefresh && cached && Date.now() - cached.submissionCheckedAt < config.cacheTtlMs) return cached;
      if (this.submissionPending.has(key)) return this.submissionPending.get(key);
      const task = this.fetchSubmission(url).then((result) => {
        if (!this.destroyed) this.submissionCache.set(key, result);
        return result;
      }).finally(() => this.submissionPending.delete(key));
      this.submissionPending.set(key, task);
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

    async getCourseCompletions(courseId, forceRefresh = false) {
      const url = namespace.submissionParser.reportUrl(courseId);
      if (!url || this.destroyed) return null;
      const key = `${this.userScope}|${url}`;
      const cached = this.completionCache.get(key);
      if (!forceRefresh && cached && Date.now() - cached.checkedAt < config.cacheTtlMs) return cached;
      if (this.completionPending.has(key)) return this.completionPending.get(key);
      const task = (async () => {
        try {
          const entries = namespace.submissionParser.parseCourse(await this.fetchStatusPage(url));
          return { entries: entries || {}, check: entries ? "verified" : "unavailable", checkedAt: Date.now() };
        } catch (_error) {
          return { entries: {}, check: "failed", checkedAt: Date.now() };
        }
      })().then((result) => {
        if (!this.destroyed) this.completionCache.set(key, result);
        return result;
      }).finally(() => this.completionPending.delete(key));
      this.completionPending.set(key, task);
      return task;
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
      return this.request("event", { eventId: Number(eventId) });
    }
  }

  namespace.PlatoDataSource = PlatoDataSource;
})(globalThis);
