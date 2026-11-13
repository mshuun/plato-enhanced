(function initCombinedSource(global) {
  "use strict";
  const ns = global.PlatoCalendarExt;

  // Keep each provider's failure and authentication state independent.
  class CombinedDataSource {
    constructor() {
      this.plato = new ns.PlatoDataSource();
      this.nespa = new ns.NespaDataSource();
      this.destroyed = false;
    }
    getContext() { return this.plato.getContext(); }
    async getMonth(year, month, forceRefresh) {
      const [plato, nespa] = await Promise.allSettled([
        this.plato.getMonth(year, month, forceRefresh),
        this.nespa.getActivities({ forceRefresh })
      ]);
      if (this.destroyed) throw new Error("DATA_SOURCE_DESTROYED");
      const p = plato.status === "fulfilled" ? plato.value : null;
      const n = nespa.status === "fulfilled" ? nespa.value : { activities: [], state: "error", message: "NESPA 과제를 불러오지 못했습니다." };
      const timezone = p?.timezone || ns.config.defaultTimezone;
      const days = new Set(ns.calendarModel.getMonthGrid(year, month, timezone).map(day => day.key));
      const unique = new Map();
      for (const activity of [...(p?.activities || []).map(item => ({ ...item, provider: "plato" })), ...(n.activities || [])]) {
        if (!Number.isFinite(activity.deadline) || !days.has(ns.calendarModel.dayKeyFromTimestamp(activity.deadline, timezone))) continue;
        unique.set(activity.id, activity);
      }
      const notes = [];
      if (!p) notes.push("PLATO 일정을 불러오지 못했습니다.");
      if (n.state !== "disabled") {
        if (n.message) notes.push(n.message);
        else if (n.state === "ok") notes.push("NESPA 연동됨");
        else notes.push("NESPA 상태 확인 필요");
      }
      return {
        activities: [...unique.values()].sort((a, b) => a.deadline - b.deadline || a.id.localeCompare(b.id)),
        userScope: p?.userScope || "default", timezone, fetchedAt: Date.now(),
        partial: Boolean(p?.partial) || !p || !["ok", "disabled"].includes(n.state),
        providerNotes: notes, providerState: { plato: p ? "ok" : "error", nespa: n.state }
      };
    }
    getSubmission(activity, force) {
      return activity.provider === "nespa" ? Promise.resolve(null) : this.plato.getSubmission(activity, force);
    }
    getCourseCompletions(id, force) { return this.plato.getCourseCompletions(id, force); }
    getDetail(id) { return this.plato.getDetail(id); }
    getNespaDetail(activity) { return this.nespa.getDetail(activity, true); }
    subscribeNespaInvalidation(listener) { return this.nespa.subscribePrivateInvalidation(listener); }
    updateActivities(activities) { this.plato.updateActivities(activities.filter(activity => activity.provider !== "nespa")); }
    invalidateNespa() { this.nespa.invalidate(); }
    destroy() { this.destroyed = true; this.plato.destroy(); this.nespa.destroy(); }
  }
  ns.CombinedDataSource = CombinedDataSource;
})(globalThis);
