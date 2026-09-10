(function initCalendarView(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const config = namespace.config;
  const model = namespace.calendarModel;

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function formatTime(timestamp, timezone) {
    const options = { hour: "2-digit", minute: "2-digit" };
    if (timezone) {
      options.timeZone = timezone;
    }
    try {
      return new Intl.DateTimeFormat("ko-KR", options).format(new Date(timestamp * 1000));
    } catch (_error) {
      delete options.timeZone;
      return new Intl.DateTimeFormat("ko-KR", options).format(new Date(timestamp * 1000));
    }
  }

  class CalendarView {
    constructor() {
      const [year, month] = model.dayKeyFromTimestamp(Date.now() / 1000, config.defaultTimezone).split("-").map(Number);
      this.year = year;
      this.month = month;
      this.activities = [];
      this.manualCompletions = {};
      this.userScope = "default";
      this.timezone = config.defaultTimezone;
      this.partial = false;
      this.checkingSubmissions = false;
      this.storageSequence = 0;
      this.loading = false;
      this.error = null;
      this.collapsed = false;
      this.loadSequence = 0;
      this.lastUpdatedAt = 0;
      this.lastRefreshAttemptAt = 0;
      this.destroyed = false;
      this.dataSource = new namespace.PlatoDataSource();
      this.boundOutsideClick = this.handleOutsideClick.bind(this);
      this.boundPopoverEscape = this.handlePopoverEscape.bind(this);
      this.modal = new namespace.ActivityModal({
        timezone: this.timezone,
        loadDetail: (activity) => this.loadActivityDetail(activity),
        restoreFocus: (id) => this.restoreActivityFocus(id),
        canSaveManual: () => this.userScope !== "default",
        onToggleManual: (activity, completed) => this.toggleManual(activity, completed)
      });
    }

    async mount(beforeNode) {
      this.root = element("section", "plato-calendar-ext-section csms-box csms-box-xlg");
      this.root.id = config.rootId;
      this.root.setAttribute("aria-labelledby", "plato-calendar-ext-heading");
      this.buildShell();
      beforeNode.parentNode.insertBefore(this.root, beforeNode);

      try {
        this.collapsed = await namespace.storage.getCollapsed();
      } catch (_error) {
        this.collapsed = false;
      }
      if (this.destroyed) {
        return;
      }
      try {
        const context = await this.dataSource.getContext();
        if (this.destroyed) return;
        this.timezone = this.validTimezone(context.timezone);
        this.modal.options.timezone = this.timezone;
        [this.year, this.month] = model.dayKeyFromTimestamp(Date.now() / 1000, this.timezone).split("-").map(Number);
      } catch (_error) { /* Use the PLATO site timezone fallback. */ }
      if (this.destroyed) return;
      this.unsubscribeStorage = namespace.storage.subscribe(() => this.reloadManual());
      this.onVisible = () => this.autoRefresh();
      document.addEventListener("visibilitychange", this.onVisible);
      this.tick = window.setInterval(() => {
        if (!document.hidden && !this.collapsed && !this.loading && this.modal.overlay.hidden) this.render();
        this.autoRefresh();
      }, 60000);
      this.applyCollapsedState();
      if (!this.collapsed) {
        await this.loadMonth();
      }
    }

    buildShell() {
      const header = element("header", "plato-calendar-ext-header csms-box-header");
      const titleWrap = element("div", "plato-calendar-ext-title-wrap title-badge");
      const title = element("h3", "plato-calendar-ext-title csms-title csms-title-xlg", "학습활동 달력");
      title.id = "plato-calendar-ext-heading";
      this.countBadge = element("span", "plato-calendar-ext-count badge", "0");
      titleWrap.append(title, this.countBadge);

      const headerActions = element("div", "plato-calendar-ext-header-actions");
      this.collapseButton = element("button", "plato-calendar-ext-ghost-button");
      this.collapseButton.type = "button";
      this.collapseButton.addEventListener("click", () => this.toggleCollapsed());
      headerActions.append(this.collapseButton);
      header.append(titleWrap, headerActions);

      this.content = element("div", "plato-calendar-ext-content csms-box-content");
      this.content.id = "plato-calendar-ext-content";

      const toolbar = element("div", "plato-calendar-ext-toolbar");
      const navigation = element("div", "plato-calendar-ext-navigation");
      this.previousButton = this.navigationButton("‹", "이전 달", () => this.moveMonth(-1));
      this.nextButton = this.navigationButton("›", "다음 달", () => this.moveMonth(1));
      this.monthTitle = element("h4", "plato-calendar-ext-month-title");
      this.monthTitle.setAttribute("aria-live", "polite");
      navigation.append(this.previousButton, this.monthTitle, this.nextButton);

      this.todayButton = element("button", "plato-calendar-ext-button plato-calendar-ext-button-secondary", "오늘");
      this.todayButton.type = "button";
      this.todayButton.addEventListener("click", () => this.goToday());
      this.refreshButton = element("button", "plato-calendar-ext-icon-button", "↻");
      this.refreshButton.type = "button";
      this.refreshButton.setAttribute("aria-label", "현재 달 일정 새로고침");
      this.refreshButton.addEventListener("click", () => this.loadMonth(true));
      const toolbarActions = element("div", "plato-calendar-ext-toolbar-actions");
      toolbarActions.append(this.todayButton, this.refreshButton);
      toolbar.append(navigation, toolbarActions);

      this.status = element("div", "plato-calendar-ext-load-status");
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      this.calendar = element("div", "plato-calendar-ext-calendar");
      this.content.append(toolbar, this.status, this.calendar);
      this.root.append(header, this.content);
    }

    navigationButton(text, label, handler) {
      const button = element("button", "plato-calendar-ext-icon-button", text);
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.addEventListener("click", handler);
      return button;
    }

    async toggleCollapsed() {
      this.collapsed = !this.collapsed;
      this.applyCollapsedState();
      try {
        await namespace.storage.setCollapsed(this.collapsed);
      } catch (_error) {
        // The current UI state still works if local persistence fails.
      }
      if (!this.collapsed && !this.loading) {
        if (!this.fetchedAt) await this.loadMonth();
        else await this.autoRefresh();
      }
    }

    applyCollapsedState() {
      this.content.hidden = this.collapsed;
      this.countBadge.hidden = this.collapsed;
      this.collapseButton.textContent = this.collapsed ? "펼치기" : "접기";
      this.collapseButton.setAttribute("aria-expanded", String(!this.collapsed));
      this.collapseButton.setAttribute("aria-controls", this.content.id);
      this.root.classList.toggle("plato-calendar-ext-collapsed", this.collapsed);
    }

    async moveMonth(delta) {
      const next = model.addMonths(this.year, this.month, delta);
      this.year = next.year;
      this.month = next.month;
      await this.loadMonth();
    }

    async goToday() {
      [this.year, this.month] = model.dayKeyFromTimestamp(Date.now() / 1000, this.timezone).split("-").map(Number);
      await this.loadMonth();
    }

    markUpdated(timestamp = Date.now()) {
      if (this.destroyed || !Number.isFinite(timestamp) || timestamp <= this.lastUpdatedAt) return;
      this.lastUpdatedAt = timestamp;
      this.scheduleAutoRefresh();
    }

    scheduleAutoRefresh() {
      window.clearTimeout(this.refreshTimer);
      if (this.destroyed) return;
      const remaining = config.cacheTtlMs - (Date.now() - Math.max(this.lastUpdatedAt, this.lastRefreshAttemptAt));
      if (remaining > 0) this.refreshTimer = window.setTimeout(() => this.autoRefresh(), remaining);
    }

    async autoRefresh() {
      if (this.destroyed || document.hidden || this.collapsed || this.loading ||
          this.checkingSubmissions || !this.modal.overlay.hidden) return;
      if (Date.now() - Math.max(this.lastUpdatedAt, this.lastRefreshAttemptAt) < config.cacheTtlMs) return;
      this.lastRefreshAttemptAt = Date.now();
      this.scheduleAutoRefresh();
      await this.loadMonth(true);
    }

    async loadMonth(forceRefresh) {
      if (this.destroyed) {
        return;
      }
      const sequence = ++this.loadSequence;
      this.checkingSubmissions = false;
      this.loading = true;
      this.error = null;
      this.render();
      try {
        const result = await this.dataSource.getMonth(this.year, this.month, Boolean(forceRefresh));
        if (this.destroyed || sequence !== this.loadSequence) {
          return;
        }
        if (this.userScope !== result.userScope) this.manualCompletions = {};
        this.activities = result.activities;
        this.userScope = result.userScope;
        this.timezone = this.validTimezone(result.timezone);
        this.partial = result.partial;
        this.fetchedAt = result.fetchedAt;
        this.markUpdated(result.fetchedAt);
        this.modal.options.timezone = this.timezone;
        try {
          await this.reloadManual(false);
        } catch (_error) {
          this.manualCompletions = {};
        }
      } catch (_error) {
        if (!this.destroyed && sequence === this.loadSequence) {
          this.lastRefreshAttemptAt = Date.now();
          this.scheduleAutoRefresh();
          this.activities = [];
          this.error = "PLATO에서 이 달의 일정을 불러오지 못했습니다.";
        }
      } finally {
        if (!this.destroyed && sequence === this.loadSequence) {
          this.loading = false;
          this.render();
          if (!this.error) this.refreshSubmissions(sequence, Boolean(forceRefresh));
        }
      }
    }

    render() {
      const focusedId = document.activeElement?.dataset?.activityId;
      this.closeDayPopover();
      this.monthTitle.textContent = `${this.year}년 ${this.month}월`;
      this.countBadge.textContent = this.loading ? "…" : String(this.activities.length);
      this.previousButton.disabled = this.loading;
      this.nextButton.disabled = this.loading;
      this.todayButton.disabled = this.loading;
      this.refreshButton.disabled = this.loading;
      this.calendar.replaceChildren();

      if (this.loading) {
        this.status.hidden = false;
        this.status.textContent = "일정을 불러오고 있습니다…";
      } else if (this.error) {
        this.status.hidden = false;
        this.status.replaceChildren(element("span", "", this.error));
        const retry = element("button", "plato-calendar-ext-inline-button", "다시 시도");
        retry.type = "button";
        retry.addEventListener("click", () => this.loadMonth(true));
        this.status.append(retry);
      } else {
        const notes = [];
        if (this.checkingSubmissions) notes.push("학습활동 상태를 확인하고 있습니다…");
        if (this.partial) notes.push("일부 할 일 상태를 확인하지 못했습니다.");
        if (this.fetchedAt) notes.push(`일정 갱신 ${formatTime(this.fetchedAt / 1000, this.timezone)}`);
        this.status.hidden = notes.length === 0;
        this.status.textContent = notes.join(" · ");
      }

      const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
      const weekdayRow = element("div", "plato-calendar-ext-weekdays");
      weekdayRow.setAttribute("role", "row");
      weekdays.forEach((weekday, index) => {
        const cell = element("div", "plato-calendar-ext-weekday", weekday);
        cell.setAttribute("role", "columnheader");
        if (index === 0) cell.classList.add("plato-calendar-ext-sunday");
        if (index === 6) cell.classList.add("plato-calendar-ext-saturday");
        weekdayRow.append(cell);
      });
      this.calendar.setAttribute("role", "table");
      this.calendar.setAttribute("aria-label", `${this.year}년 ${this.month}월 학습활동`);
      this.calendar.append(weekdayRow);

      const grid = element("div", "plato-calendar-ext-grid");
      grid.setAttribute("role", "rowgroup");
      grid.setAttribute("aria-label", `${this.year}년 ${this.month}월 학습활동`);
      const groups = model.groupActivitiesByDay(this.loading ? [] : this.activities, this.timezone);
      let row;
      model.getMonthGrid(this.year, this.month, this.timezone).forEach((day, index) => {
        if (index % 7 === 0) {
          row = element("div", "plato-calendar-ext-week");
          row.setAttribute("role", "row");
          grid.append(row);
        }
        row.append(this.renderDay(day, groups.get(day.key) || []));
      });
      this.calendar.append(grid);
      if (focusedId && this.modal.overlay.hidden) this.restoreActivityFocus(focusedId);
    }

    renderDay(day, activities) {
      const cell = element("div", "plato-calendar-ext-day");
      cell.setAttribute("role", "cell");
      cell.setAttribute("aria-label", day.key);
      cell.dataset.dayKey = day.key;
      cell.classList.toggle("plato-calendar-ext-other-month", !day.inCurrentMonth);
      cell.classList.toggle("plato-calendar-ext-today", day.isToday);
      if (day.column === 0) cell.classList.add("plato-calendar-ext-sunday");
      if (day.column === 6) cell.classList.add("plato-calendar-ext-saturday");

      const number = element("div", "plato-calendar-ext-day-number", String(day.day));
      if (day.isToday) {
        number.setAttribute("aria-label", `${day.day}일 오늘`);
        number.title = "오늘";
      }
      const list = element("div", "plato-calendar-ext-day-items");
      const visible = activities.slice(0, config.maxVisibleItemsPerDay);
      visible.forEach((activity) => list.append(this.activityButton(activity)));

      if (activities.length > visible.length) {
        const more = element(
          "button",
          "plato-calendar-ext-more-button",
          `+ ${activities.length - visible.length}개 더보기`
        );
        more.type = "button";
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          this.openDayPopover(cell, day, activities, more);
        });
        list.append(more);
      }
      cell.append(number, list);
      return cell;
    }

    activityButton(activity) {
      const status = model.classifyActivity(
        activity,
        this.manualCompletions[activity.id] === true,
        Math.floor(Date.now() / 1000),
        config.dueSoonHours
      );
      const button = element("button", `plato-calendar-ext-activity plato-calendar-ext-status-${status.code}`);
      if (["submitted", "completed", "manual"].includes(status.code) &&
          Number(activity.deadline) < Math.floor(Date.now() / 1000)) {
        button.classList.add("plato-calendar-ext-status-finished-past");
      }
      button.type = "button";
      button.dataset.activityId = activity.id;
      button.title = `${activity.title} · ${activity.courseName} · ${status.label}`;
      button.setAttribute("aria-label", `${formatTime(activity.deadline, this.timezone)} ${activity.title}, ${activity.courseName}, ${status.label}`);
      const time = element("span", "plato-calendar-ext-activity-time", formatTime(activity.deadline, this.timezone));
      const title = element("span", "plato-calendar-ext-activity-title", activity.title);
      const course = element("span", "plato-calendar-ext-activity-course", activity.courseName);
      const statusNode = element("span", "plato-calendar-ext-activity-status", `${status.icon} ${status.label}`);
      button.append(time, title, course, statusNode);
      button.addEventListener("click", () => {
        this.closeDayPopover();
        this.modal.open(activity, this.manualCompletions[activity.id] === true);
      });
      return button;
    }

    openDayPopover(cell, day, activities, trigger) {
      this.closeDayPopover();
      const popover = element("div", "plato-calendar-ext-day-popover");
      if (day.column >= 5) {
        popover.classList.add("plato-calendar-ext-day-popover-right");
      }
      popover.setAttribute("role", "region");
      popover.setAttribute("aria-label", `${day.date.getMonth() + 1}월 ${day.day}일 활동 전체 목록`);
      const header = element("div", "plato-calendar-ext-day-popover-header");
      header.append(element("strong", "", `${day.date.getMonth() + 1}월 ${day.day}일`));
      const close = element("button", "plato-calendar-ext-icon-button", "×");
      close.type = "button";
      close.setAttribute("aria-label", "날짜별 활동 목록 닫기");
      close.addEventListener("click", () => this.closeDayPopover(true));
      header.append(close);
      const list = element("div", "plato-calendar-ext-day-popover-list");
      activities.forEach((activity) => list.append(this.activityButton(activity)));
      popover.append(header, list);
      cell.append(popover);
      this.dayPopover = { node: popover, trigger };
      trigger.setAttribute("aria-expanded", "true");
      this.popoverTimer = window.setTimeout(() => {
        if (!this.dayPopover || this.destroyed) return;
        document.addEventListener("mousedown", this.boundOutsideClick, true);
        document.addEventListener("keydown", this.boundPopoverEscape, true);
      }, 0);
      close.focus();
    }

    handleOutsideClick(event) {
      if (this.dayPopover && !this.dayPopover.node.contains(event.target) && event.target !== this.dayPopover.trigger) {
        this.closeDayPopover();
      }
    }

    handlePopoverEscape(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeDayPopover(true);
      }
    }

    closeDayPopover(restoreFocus) {
      window.clearTimeout(this.popoverTimer);
      if (!this.dayPopover) {
        return;
      }
      const { node, trigger } = this.dayPopover;
      this.dayPopover = null;
      node.remove();
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", this.boundOutsideClick, true);
      document.removeEventListener("keydown", this.boundPopoverEscape, true);
      if (restoreFocus) {
        trigger.focus();
      }
    }

    validTimezone(value) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value || config.defaultTimezone });
        return value || config.defaultTimezone;
      } catch (_error) { return config.defaultTimezone; }
    }

    restoreActivityFocus(id) {
      const button = [...this.root.querySelectorAll("[data-activity-id]")].find((node) => node.dataset.activityId === id);
      (button || this.collapseButton).focus();
    }

    async reloadManual(render = true) {
      const sequence = ++this.storageSequence;
      const scope = this.userScope;
      try {
        const values = await namespace.storage.getManualCompletions(scope);
        if (this.destroyed || sequence !== this.storageSequence || scope !== this.userScope) return;
        if (render && JSON.stringify(values) !== JSON.stringify(this.manualCompletions)) this.markUpdated();
        this.manualCompletions = values;
        if (!this.modal.overlay.hidden && this.modal.activity) {
          this.modal.manualCompleted = values[this.modal.activity.id] === true;
          this.modal.render();
        }
        if (render) this.render();
      } catch (_error) { /* Preserve the last known local state on a read failure. */ }
    }

    updateActivity(activity, updatedAt = Date.now()) {
      if (this.destroyed) return;
      this.markUpdated(updatedAt);
      this.activities = this.activities.map((item) => item.id === activity.id ? activity : item)
        .sort((a, b) => a.deadline - b.deadline);
      this.dataSource.updateActivity(activity);
      if (!this.modal.overlay.hidden && this.modal.activity?.id === activity.id) {
        this.modal.activity = { ...activity };
        this.modal.render();
      }
      this.render();
    }

    applyCourseResult(courseId, report) {
      if (!report) return;
      this.markUpdated(report.checkedAt);
      for (const current of [...this.activities]) {
        if (String(current.courseId) !== String(courseId)) continue;
        const key = namespace.submissionParser.activityKey(current.activityUrl);
        const status = key && report.entries[key];
        if (status) this.updateActivity({ ...current, sourceStatus: status,
          completionCheck: "verified", completionCheckedAt: report.checkedAt }, report.checkedAt);
        else if (current.completionCheck !== "verified") this.updateActivity({ ...current, completionCheck: report.check === "failed" ? "failed" : "unavailable" }, report.checkedAt);
      }
    }

    async refreshSubmissions(sequence, forceRefresh) {
      const courses = [...new Set(this.activities.map((item) => item.courseId).filter((id) => namespace.submissionParser.reportUrl(id)))];
      const queue = [
        ...courses.map((courseId) => ({ kind: "course", courseId })),
        ...this.activities.filter((item) => namespace.submissionParser.assignmentUrl(item.activityUrl))
          .map((item) => ({ kind: "submission", item }))
      ];
      this.checkingSubmissions = queue.length > 0;
      this.render();
      const worker = async () => {
        while (queue.length && !this.destroyed && sequence === this.loadSequence) {
          const job = queue.shift();
          if (job.kind === "course") {
            const report = await this.dataSource.getCourseCompletions(job.courseId, forceRefresh);
            if (this.destroyed || sequence !== this.loadSequence) return;
            this.applyCourseResult(job.courseId, report);
          } else {
            const result = await this.dataSource.getSubmission(job.item, forceRefresh);
            if (this.destroyed || sequence !== this.loadSequence) return;
            const current = this.activities.find((activity) => activity.id === job.item.id);
            if (result && current) this.updateActivity({ ...current, ...result }, result.submissionCheckedAt);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (!this.destroyed && sequence === this.loadSequence) {
        this.checkingSubmissions = false;
        this.render();
      }
    }

    async loadActivityDetail(activity) {
      const sequence = this.loadSequence;
      let result = { ...activity };
      let detailFailed = false;
      try {
        const detail = await this.dataSource.getDetail(activity.eventId);
        const current = this.activities.find((item) => item.id === activity.id) || result;
        result = namespace.parser.mergeDetail(current, detail);
      } catch (_error) { detailFailed = true; }
      if (this.destroyed || sequence !== this.loadSequence) return result;
      const [submission, report] = await Promise.all([
        this.dataSource.getSubmission(result, true),
        this.dataSource.getCourseCompletions(result.courseId, true)
      ]);
      if (submission) Object.assign(result, submission);
      const key = namespace.submissionParser.activityKey(result.activityUrl);
      if (key && report?.entries[key]) Object.assign(result, { sourceStatus: report.entries[key],
        completionCheck: "verified", completionCheckedAt: report.checkedAt });
      result.detailFailed = detailFailed;
      if (!this.destroyed && sequence === this.loadSequence) {
        this.applyCourseResult(result.courseId, report);
        this.updateActivity(result);
      }
      return result;
    }

    async toggleManual(activity, completed) {
      const scope = this.userScope;
      await namespace.storage.setManualCompletion(scope, activity.id, completed);
      if (this.destroyed || scope !== this.userScope) return completed;
      await this.reloadManual();
      return completed;
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.loadSequence += 1;
      this.closeDayPopover();
      this.unsubscribeStorage?.();
      document.removeEventListener("visibilitychange", this.onVisible);
      window.clearInterval(this.tick);
      window.clearTimeout(this.refreshTimer);
      this.modal.destroy();
      this.dataSource.destroy();
      if (this.root) {
        this.root.remove();
      }
    }
  }

  namespace.CalendarView = CalendarView;
})(globalThis);
