(function initCalendarModel(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const formats = {
    day: { locale: "sv-SE", options: { year: "numeric", month: "2-digit", day: "2-digit" } },
    time: { locale: "ko-KR", options: { hour: "2-digit", minute: "2-digit" } },
    deadline: { locale: "ko-KR", options: { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" } }
  };
  const formatters = {};

  // Keep one formatter per display style, replacing it when the timezone changes.
  function formatter(kind, timezone) {
    const zone = timezone || undefined;
    if (!zone) return new Intl.DateTimeFormat(formats[kind].locale, formats[kind].options);
    if (!formatters[kind] || formatters[kind].zone !== zone) {
      const { locale, options } = formats[kind];
      let value;
      try { value = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); }
      catch (_) { value = null; }
      formatters[kind] = { zone, value };
    }
    return formatters[kind].value || (kind === "day" ? null : new Intl.DateTimeFormat(formats[kind].locale, formats[kind].options));
  }

  function formatTime(timestamp, timezone) {
    return formatter("time", timezone).format(new Date(timestamp * 1000));
  }

  function formatDeadline(timestamp, timezone) {
    return formatter("deadline", timezone).format(new Date(timestamp * 1000));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dayKeyFromDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function dayKeyFromTimestamp(timestamp, timezone) {
    if (timezone) {
      try {
        const dateFormatter = formatter("day", timezone);
        if (dateFormatter) return dateFormatter.format(new Date(Number(timestamp) * 1000));
      } catch (_error) {
        // Fall back to the browser timezone.
      }
    }
    return dayKeyFromDate(new Date(Number(timestamp) * 1000));
  }

  function getMonthGrid(year, month, timezone) {
    const first = new Date(year, month - 1, 1);
    const gridStart = new Date(year, month - 1, 1 - first.getDay());
    const today = dayKeyFromTimestamp(Date.now() / 1000, timezone);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
      const key = dayKeyFromDate(date);
      return {
        date,
        key,
        day: date.getDate(),
        inCurrentMonth: date.getMonth() === month - 1,
        isToday: key === today,
        column: index % 7
      };
    });
  }

  function groupActivitiesByDay(activities, timezone) {
    return activities.reduce((groups, activity) => {
      const key = dayKeyFromTimestamp(activity.deadline, timezone);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(activity);
      return groups;
    }, new Map());
  }

  function classifyActivity(activity, manualCompleted, nowTimestamp, dueSoonHours) {
    if (activity.provider === "nespa") {
      if (activity.submissionCheck !== "verified") return { code: "unknown", label: "제출 상태 확인 필요", icon: "?" };
      if (activity.submissionStatus === "제출됨") return { code: "submitted", label: "제출됨", icon: "✓" };
      const remaining = Number(activity.deadline) - Number(nowTimestamp);
      if (remaining < 0) return { code: "overdue", label: "미제출 · 마감됨", icon: "!" };
      if (remaining <= dueSoonHours * 3600) return { code: "due-soon", label: "미제출 · 마감 임박", icon: "⏳" };
      return { code: "incomplete", label: "미제출", icon: "○" };
    }
    if (manualCompleted) {
      return { code: "manual", label: "수동 완료", icon: "✓" };
    }
    if (activity.submissionStatus === "제출 완료") {
      return { code: "submitted", label: "제출 완료", icon: "✓" };
    }
    // Submission and activity completion are different signals. A draft or a
    // reopened submission still needs action even when PLATO marks it complete.
    const secondsRemaining = Number(activity.deadline) - Number(nowTimestamp);
    if (["미제출", "초안 저장", "재제출 필요"].includes(activity.submissionStatus)) {
      const label = activity.submissionStatus;
      if (secondsRemaining < 0) return { code: "overdue", label: `${label} · 마감됨`, icon: "!" };
      if (secondsRemaining <= dueSoonHours * 3600) return { code: "due-soon", label: `${label} · 마감 임박`, icon: "⏳" };
      return { code: "incomplete", label, icon: "○" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "completed") {
      return { code: "completed", label: "완료", icon: "✓" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "overdue") {
      return { code: "overdue", label: "기한 초과", icon: "!" };
    }

    if (secondsRemaining >= 0 && secondsRemaining <= dueSoonHours * 60 * 60) {
      return { code: "due-soon", label: "마감 임박", icon: "⏳" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "incomplete") {
      return { code: "incomplete", label: "미완료", icon: "○" };
    }
    return { code: "unknown", label: activity.submissionCheck === "failed" || activity.completionCheck === "failed"
      ? "상태 조회 실패" : (activity.typeCode === "assign" ? "제출 상태 미확인" : "완료 상태 미확인"), icon: "?" };
  }

  function addMonths(year, month, delta) {
    const date = new Date(year, month - 1 + delta, 1);
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }

  namespace.calendarModel = Object.freeze({
    addMonths,
    classifyActivity,
    dayKeyFromTimestamp,
    formatTime,
    formatDeadline,
    getMonthGrid,
    groupActivitiesByDay
  });
})(globalThis);
