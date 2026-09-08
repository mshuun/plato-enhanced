(function initCalendarModel(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dayKeyFromDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function dayKeyFromTimestamp(timestamp, timezone) {
    if (timezone) {
      try {
        return new Intl.DateTimeFormat("sv-SE", {
          timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
        }).format(new Date(Number(timestamp) * 1000));
      } catch (_error) {
        // Fall back to the browser timezone.
      }
    }
    return dayKeyFromDate(new Date(Number(timestamp) * 1000));
  }

  function getMonthGrid(year, month, timezone) {
    const first = new Date(year, month - 1, 1);
    const gridStart = new Date(year, month - 1, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
      return {
        date,
        key: dayKeyFromDate(date),
        day: date.getDate(),
        inCurrentMonth: date.getMonth() === month - 1,
        isToday: dayKeyFromDate(date) === dayKeyFromTimestamp(Date.now() / 1000, timezone),
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
    if (manualCompleted) {
      return { code: "manual", label: "수동 완료", icon: "✓" };
    }
    if (activity.submissionStatus === "제출 완료") {
      return { code: "submitted", label: "제출 완료", icon: "✓" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "completed") {
      return { code: "completed", label: "완료", icon: "✓" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "overdue") {
      return { code: "overdue", label: "기한 초과", icon: "!" };
    }

    const secondsRemaining = Number(activity.deadline) - Number(nowTimestamp);
    if (secondsRemaining >= 0 && secondsRemaining <= dueSoonHours * 60 * 60) {
      return { code: "due-soon", label: "마감 임박", icon: "⏳" };
    }
    if (activity.sourceStatus && activity.sourceStatus.code === "incomplete") {
      return { code: "incomplete", label: "미완료", icon: "○" };
    }
    if (["초안 저장", "재제출 필요"].includes(activity.submissionStatus)) {
      return { code: "incomplete", label: activity.submissionStatus, icon: "○" };
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
    dayKeyFromDate,
    dayKeyFromTimestamp,
    getMonthGrid,
    groupActivitiesByDay
  });
})(globalThis);
