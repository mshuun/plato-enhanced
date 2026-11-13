(function initNespaDataSource(global) {
  "use strict";

  const ns = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const TTL = ns.config?.cacheTtlMs || 10 * 60 * 1000;
  const CATALOG_TTL = 7 * 24 * 60 * 60 * 1000;
  const CATALOG_PREFIX = "platoEnhanced.nespa.catalog.v1.";
  const canceled = () => Object.assign(new Error("NESPA_REQUEST_CANCELED"), { canceled: true });
  const privateCanceled = () => Object.assign(new Error("NESPA_PRIVATE_CHECK_OBSOLETE"), { privateCanceled: true });
  const clone = value => JSON.parse(JSON.stringify(value));
  const unknownDetail = (authRequired = false, checkedAt = Date.now()) => ({ submissionStatus: "확인 필요", submissionCheck: "failed",
    submissionCheckedAt: checkedAt, score: null, attempts: null, detailAuthRequired: authRequired, detailPartial: false,
    sourceStatus: { code: "unknown", label: "제출 상태 확인 필요", source: "NESPA" } });

  class NespaDataSource {
    constructor() {
      this.generation = 0;
      this.privateEpoch = 0;
      this.destroyed = false;
      this.cache = null;
      this.pending = null;
      this.details = new Map();
      this.detailPending = new Map();
      this.detailActive = 0;
      this.detailWaiters = [];
      this.requests = new Set();
      this.privateListeners = new Set();
      this.unsubscribeSettings = ns.nespaSettings.subscribe(() => this.invalidate());
    }

    invalidate() {
      this.generation += 1;
      this.pending = null;
      this.clearPrivateState();
      for (const request of [...this.requests]) request.cancel();
    }

    subscribePrivateInvalidation(listener) {
      this.privateListeners.add(listener);
      return () => this.privateListeners.delete(listener);
    }

    clearPrivateState(reason) {
      this.privateEpoch += 1;
      this.cache = null;
      this.details.clear();
      // Old in-flight checks may finish, but new reads must not join them.
      this.detailPending.clear();
      for (const waiter of this.detailWaiters.splice(0)) waiter.reject(privateCanceled());
      if (reason) for (const listener of this.privateListeners) {
        try { listener(reason); } catch (_) { /* A view cannot prevent private cache invalidation. */ }
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.invalidate();
      this.privateListeners.clear();
      this.unsubscribeSettings?.();
    }

    assertCurrent(generation) {
      if (this.destroyed || generation !== this.generation) throw canceled();
    }

    request(resource, problemId, generation) {
      this.assertCurrent(generation);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.requests.delete(request);
          if (error) reject(error); else resolve(result);
        };
        const request = { cancel: () => finish(canceled()) };
        const timer = setTimeout(() => finish(null, { ok: false, error: "error", message: "NESPA 응답 시간이 초과되었습니다." }), 60000);
        this.requests.add(request);
        try {
          chrome.runtime.sendMessage({ type: "PE_NESPA_FETCH", resource, ...(problemId == null ? {} : { problemId }) }, result => {
            const failed = chrome.runtime.lastError;
            if (this.destroyed || generation !== this.generation) { finish(canceled()); return; }
            finish(null, failed || !result ? { ok: false, error: "error", message: "NESPA 연결을 확인하지 못했습니다." } : result);
          });
        } catch (_) { finish(null, { ok: false, error: "error", message: "NESPA 연결을 확인하지 못했습니다." }); }
      });
    }

    async detailRequest(problemId, generation, privateEpoch, readResult) {
      this.assertCurrent(generation);
      if (privateEpoch !== this.privateEpoch) throw privateCanceled();
      if (this.detailActive >= 3) {
        await new Promise((resolve, reject) => this.detailWaiters.push({ generation, privateEpoch, resolve, reject }));
      } else this.detailActive += 1;
      try {
        this.assertCurrent(generation);
        if (privateEpoch !== this.privateEpoch) throw privateCanceled();
        // Inspect authentication before handing this slot to a queued check.
        return readResult(await this.request("detail", problemId, generation));
      } finally {
        this.detailActive -= 1;
        while (this.detailWaiters.length && this.detailActive < 3) {
          const waiter = this.detailWaiters.shift();
          if (this.destroyed || waiter.generation !== this.generation) { waiter.reject(canceled()); continue; }
          if (waiter.privateEpoch !== this.privateEpoch) { waiter.reject(privateCanceled()); continue; }
          this.detailActive += 1;
          waiter.resolve();
        }
      }
    }

    catalogKey(settings) {
      const course = ns.nespaParser.courseInfo(settings);
      return course ? `${CATALOG_PREFIX}${course.id}.${course.year}` : null;
    }

    async saveCatalog(settings, activities, fetchedAt, generation) {
      const key = this.catalogKey(settings);
      if (!key) return;
      // Persist only common assignment metadata. Never save attempts, scores or submission state.
      const value = { version: 1, courseUrl: settings.courseUrl, courseYear: settings.courseYear, fetchedAt,
        assignments: activities.map(item => ({ problemId: item.problemId, title: item.title, deadline: item.deadline,
          startTime: item.startTime, problemUrl: item.problemUrl, sampleUrl: item.sampleUrl,
          assignmentInfo: ns.nespaParser.normalizeAssignmentInfo(item.assignmentInfo) })) };
      this.assertCurrent(generation);
      await new Promise(resolve => {
        try { chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); }); }
        catch (_) { resolve(); }
      });
      this.assertCurrent(generation);
    }

    async readCatalog(settings, generation) {
      const key = this.catalogKey(settings);
      if (!key) return [];
      const stored = await new Promise(resolve => {
        try { chrome.storage.local.get([key], result => resolve(chrome.runtime.lastError ? null : result?.[key])); }
        catch (_) { resolve(null); }
      });
      this.assertCurrent(generation);
      if (!stored || stored.version !== 1 || stored.courseUrl !== settings.courseUrl || stored.courseYear !== settings.courseYear ||
          !Number.isFinite(stored.fetchedAt) || stored.fetchedAt > Date.now() ||
          Date.now() - stored.fetchedAt > CATALOG_TTL || !Array.isArray(stored.assignments)) return [];
      return stored.assignments.slice(0, 2000).map(item => ns.nespaParser.activityFromCatalog(item, settings)).filter(Boolean)
        .map(item => ({ ...item, catalogCached: true }));
    }

    async getActivities({ forceRefresh = false } = {}) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await this.loadActivities(forceRefresh); }
        catch (error) {
          if (error.canceled && !this.destroyed && attempt === 0) continue;
          return { activities: [], fetchedAt: 0, state: this.destroyed ? "disabled" : "error",
            message: error.canceled ? "NESPA 강좌 설정이 변경되었습니다." : "NESPA 과제 정보를 불러오지 못했습니다." };
        }
      }
    }

    async loadActivities(forceRefresh) {
      const generation = this.generation;
      const settings = await ns.nespaSettings.get();
      this.assertCurrent(generation);
      if (!settings.enabled) return { activities: [], fetchedAt: 0, state: "disabled", message: "" };
      if (!ns.nespaParser.courseInfo(settings)) return { activities: [], fetchedAt: 0, state: "error", message: "NESPA 강좌 설정을 확인해 주세요." };
      if (this.pending?.generation === generation) return clone(await this.pending.promise);
      const age = Date.now() - this.cache?.fetchedAt;
      if (!forceRefresh && this.cache && age >= 0 && age < TTL) return clone(this.cache);
      this.cache = null;
      if (forceRefresh) this.details.clear();
      const task = this.fetchActivities(settings, generation, forceRefresh);
      this.pending = { generation, promise: task };
      try { return clone(await task); }
      finally { if (this.pending?.promise === task) this.pending = null; }
    }

    async fetchActivities(settings, generation, forceRefresh) {
      const response = await this.request("assignments", null, generation);
      this.assertCurrent(generation);
      let parsed;
      if (response.ok && typeof response.html === "string") parsed = ns.nespaParser.parseAssignments(response.html, settings);
      // A table containing only errors is not a usable empty list. Keep the last
      // common schedule visible, with no restored personal submission fields.
      if (!response.ok || !parsed?.valid || (parsed.partial && !parsed.activities.length)) {
        const state = response.error === "disabled" ? "disabled" : response.error === "auth-required" || parsed?.error === "auth-required" ? "auth-required" : "error";
        this.clearPrivateState(state);
        const activities = state === "disabled" ? [] : await this.readCatalog(settings, generation);
        return { activities, fetchedAt: 0, state,
          message: (response.message || (state === "auth-required" ? "NESPA에서 직접 로그인한 뒤 PLATO 달력을 새로고침해 주세요." : "NESPA 과제 목록을 확인하지 못했습니다.")) +
            (activities.length ? " 저장된 과제 일정만 표시하며 제출 상태는 확인 필요입니다." : "") };
      }
      const fetchedAt = Date.now();
      if (!parsed.partial) await this.saveCatalog(settings, parsed.activities, fetchedAt, generation);
      const activities = parsed.activities.map(item => ({ ...item }));
      let next = 0;
      let failed = 0;
      let needsAuth = false;
      const privateEpoch = this.privateEpoch;
      const worker = async () => {
        while (next < activities.length && !needsAuth && privateEpoch === this.privateEpoch) {
          this.assertCurrent(generation);
          const index = next++;
          let result;
          try { result = await this.fetchDetail(activities[index], generation, forceRefresh); }
          catch (error) {
            if (!error.privateCanceled) throw error;
            needsAuth = true;
            return;
          }
          activities[index] = result;
          if (result.submissionCheck !== "verified" || result.detailPartial) failed += 1;
          if (result.detailAuthRequired) needsAuth = true;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      this.assertCurrent(generation);
      needsAuth ||= privateEpoch !== this.privateEpoch;
      if (needsAuth) {
        for (let index = 0; index < activities.length; index += 1) activities[index] = {
          ...activities[index], submissionStatus: "확인 필요", submissionCheck: "failed", score: null, attempts: null,
          detailAuthRequired: true, detailPartial: false, sourceStatus: { code: "unknown", label: "제출 상태 확인 필요", source: "NESPA" }
        };
      }
      const result = { activities, fetchedAt,
        state: needsAuth ? "auth-required" : failed || parsed.partial ? "partial" : "ok",
        message: needsAuth ? "NESPA 로그인이 만료되어 일부 제출 상태를 확인하지 못했습니다." :
          failed || parsed.partial ? "일부 NESPA 과제 또는 제출 상태를 확인하지 못했습니다." : "" };
      // Failed private checks are retried on the next explicit request rather than cached for ten minutes.
      if (result.state === "ok") this.cache = clone(result);
      return result;
    }

    async fetchDetail(activity, generation, forceRefresh) {
      const privateEpoch = this.privateEpoch;
      const key = `${activity.courseId}:${activity.problemId}`;
      if (this.detailPending.has(key)) return { ...activity, ...await this.detailPending.get(key) };
      const cached = this.details.get(key);
      const age = Date.now() - cached?.submissionCheckedAt;
      if (!forceRefresh && cached && age >= 0 && age < TTL) return { ...activity, ...clone(cached) };
      const task = this.detailRequest(activity.problemId, generation, privateEpoch, response => {
        this.assertCurrent(generation);
        if (privateEpoch !== this.privateEpoch) throw privateCanceled();
        const parsed = response.ok && typeof response.html === "string" ? ns.nespaParser.parseSubmissionDetail(response.html) : null;
        const submissionCheckedAt = Date.now();
        if (!parsed?.valid) {
          const authRequired = response.error === "auth-required" || parsed?.error === "auth-required";
          if (authRequired) this.clearPrivateState("auth-required"); else this.details.delete(key);
          return unknownDetail(authRequired, submissionCheckedAt);
        }
        const result = { submissionStatus: parsed.status === "submitted" ? "제출됨" : "미제출", submissionCheck: "verified",
          submissionCheckedAt, score: parsed.score, attempts: parsed.attempts, detailAuthRequired: false, detailPartial: Boolean(parsed.partial),
          sourceStatus: { code: parsed.status === "submitted" ? "completed" : "incomplete",
            label: parsed.status === "submitted" ? "NESPA 제출 이력 있음" : "NESPA 제출 이력 없음", source: "NESPA 본인 제출 내역" } };
        if (result.detailPartial) this.details.delete(key);
        else this.details.set(key, result);
        return result;
      });
      this.detailPending.set(key, task);
      try { return { ...activity, ...await task }; }
      finally { if (this.detailPending.get(key) === task) this.detailPending.delete(key); }
    }

    async getDetail(activity, forceRefresh = true) {
      const generation = this.generation;
      try {
        const settings = await ns.nespaSettings.get();
        this.assertCurrent(generation);
        const course = ns.nespaParser.courseInfo(settings);
        if (!settings.enabled || !course || activity?.provider !== "nespa" || activity.courseId !== course.id || !/^\d{1,40}$/.test(activity.problemId)) throw canceled();
        const privateEpoch = this.privateEpoch;
        const result = await this.fetchDetail(activity, generation, forceRefresh);
        this.assertCurrent(generation);
        if (privateEpoch !== this.privateEpoch && !result.detailAuthRequired) throw privateCanceled();
        if (result.submissionCheck !== "verified" || result.detailPartial) {
          this.cache = null;
        } else if (this.cache) {
          this.cache.activities = this.cache.activities.map(item => item.id === result.id ? clone(result) : item);
        }
        return result;
      } catch (_) {
        return { ...activity, ...unknownDetail(false, null) };
      }
    }
  }

  ns.NespaDataSource = NespaDataSource;
})(globalThis);
