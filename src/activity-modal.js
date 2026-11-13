(function initActivityModal(global) {
  "use strict";

  const namespace = global.PlatoCalendarExt || (global.PlatoCalendarExt = {});
  const parser = namespace.parser;

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

  const formatDeadline = namespace.calendarModel.formatDeadline;

  class ActivityModal {
    constructor(options) {
      this.options = options;
      this.activity = null;
      this.manualCompleted = false;
      this.previousFocus = null;
      this.loadSequence = 0;
      this.destroyed = false;
      this.detailLoading = false;
      this.lastDetailAttemptAt = 0;
      this.boundKeydown = this.onKeydown.bind(this);
      this.boundVisible = () => this.autoRefreshDetail();
      this.create();
    }

    create() {
      this.overlay = element("div", "plato-calendar-ext-modal-overlay");
      this.overlay.hidden = true;
      this.overlay.setAttribute("aria-hidden", "true");

      this.dialog = element("section", "plato-calendar-ext-modal");
      this.dialog.setAttribute("role", "dialog");
      this.dialog.setAttribute("aria-modal", "true");
      this.dialog.setAttribute("aria-labelledby", "plato-calendar-ext-modal-title");
      this.dialog.setAttribute("tabindex", "-1");

      const header = element("header", "plato-calendar-ext-modal-header");
      this.title = element("h2", "plato-calendar-ext-modal-title");
      this.title.id = "plato-calendar-ext-modal-title";
      this.closeButton = element("button", "plato-calendar-ext-icon-button", "×");
      this.closeButton.type = "button";
      this.closeButton.setAttribute("aria-label", "상세정보 창 닫기");
      this.closeButton.addEventListener("click", () => this.close());
      header.append(this.title, this.closeButton);

      this.body = element("div", "plato-calendar-ext-modal-body");
      this.loading = element("div", "plato-calendar-ext-detail-loading", "상세정보를 확인하고 있습니다…");
      this.loading.hidden = true;

      this.footer = element("footer", "plato-calendar-ext-modal-footer");
      this.manualButton = element("button", "plato-calendar-ext-button plato-calendar-ext-button-secondary");
      this.manualButton.type = "button";
      this.manualButton.addEventListener("click", async () => {
        if (!this.activity) {
          return;
        }
        const activity = this.activity;
        const sequence = this.loadSequence;
        this.saving = true;
        this.manualButton.disabled = true;
        this.refreshButton.disabled = true;
        this.feedback.textContent = "";
        try {
          const completed = await this.options.onToggleManual(activity, !this.manualCompleted);
          if (sequence === this.loadSequence && this.activity && this.activity.id === activity.id) {
            this.manualCompleted = completed;
            this.render();
          }
        } catch (_error) {
          if (sequence === this.loadSequence) {
            this.feedback.textContent = "수동 완료 상태를 저장하지 못했습니다. 다시 시도해 주세요.";
          }
        } finally {
          if (sequence !== this.loadSequence) return;
          this.saving = false;
          this.manualButton.disabled = !this.options.canSaveManual();
          this.refreshButton.disabled = this.detailLoading;
          this.scheduleDetailRefresh();
          if (!this.overlay.hidden && [document.body, document.documentElement, this.manualButton].includes(document.activeElement)) {
            this.manualButton.focus();
          }
        }
      });

      this.openLink = element("a", "plato-calendar-ext-button plato-calendar-ext-button-primary", "활동 페이지 열기");
      this.openLink.addEventListener("click", () => this.close());
      this.refreshButton = element("button", "plato-calendar-ext-button plato-calendar-ext-button-secondary", "상태 새로고침");
      this.refreshButton.type = "button";
      this.refreshButton.setAttribute("aria-label", "활동 상세 및 제출 상태 새로고침");
      this.refreshButton.addEventListener("click", () => this.refreshDetail());
      this.feedback = element("div", "plato-calendar-ext-modal-feedback");
      this.feedback.setAttribute("role", "status");
      this.feedback.setAttribute("aria-live", "polite");
      this.footer.append(this.manualButton, this.refreshButton, this.openLink);
      this.dialog.append(header, this.body, this.loading, this.feedback, this.footer);
      this.overlay.append(this.dialog);
      this.overlay.addEventListener("mousedown", (event) => {
        if (event.target === this.overlay) {
          this.close();
        }
      });
      document.body.append(this.overlay);
    }

    addField(list, label, value, extraClass) {
      const row = element("div", `plato-calendar-ext-detail-row${extraClass ? ` ${extraClass}` : ""}`);
      const term = element("dt", "plato-calendar-ext-detail-label", label);
      const description = element("dd", "plato-calendar-ext-detail-value", value || "확인 불가");
      row.append(term, description);
      list.append(row);
    }

    render() {
      if (!this.activity) {
        return;
      }
      const focusedUrl = this.extraLinks?.contains(document.activeElement) ? document.activeElement.href : null;
      const status = namespace.calendarModel.classifyActivity(
        this.activity,
        this.manualCompleted,
        Math.floor(Date.now() / 1000),
        namespace.config.dueSoonHours
      );
      this.title.textContent = this.activity.title;
      const isNespa = this.activity.provider === "nespa";
      this.body.replaceChildren();

      const list = element("dl", "plato-calendar-ext-detail-list");
      this.addField(list, "강좌", this.activity.courseName);
      this.addField(list, "활동 유형", this.activity.typeLabel);
      if (isNespa) {
        this.addField(list, "시작일", Number.isFinite(this.activity.startTime)
          ? formatDeadline(this.activity.startTime, this.options.timezone) : "확인 불가");
      }
      this.addField(list, "마감", formatDeadline(this.activity.deadline, this.options.timezone));
      if (isNespa) {
        for (const [key, label] of [["maxSize", "파일 크기 제한"], ["tokenSize", "토큰 제한"],
          ["timeout", "실행시간 제한"], ["maxTry", "최대 제출 횟수"], ["evaluation", "평가 방식"]]) {
          const raw = this.activity.assignmentInfo?.[key];
          const value = typeof raw === "string" ? raw : (Number.isFinite(raw) ? String(raw) : "");
          // NESPA supplies the value and unit; do not infer units or unlimited values.
          this.addField(list, label, value.trim() ? value : "정보 없음");
        }
      }
      this.addField(
        list,
        "마감 여부",
        Math.floor(Date.now() / 1000) > this.activity.deadline ? "마감 시각 경과" : "마감 전"
      );
      const accent = ["submitted", "completed", "manual"].includes(status.code) &&
        Number(this.activity.deadline) < Math.floor(Date.now() / 1000) ? "finished-past" : status.code;
      this.addField(list, "현재 상태", `${status.icon} ${status.label}`, `plato-calendar-ext-detail-status-${accent}`);
      this.addField(list, isNespa ? "출처" : "PLATO 원본 상태", isNespa ? "NESPA" : this.activity.sourceStatus && this.activity.sourceStatus.label);
      this.addField(list, "제출 여부", this.activity.submissionStatus || (this.activity.submissionCheck === "failed" ? "상태 조회 실패" : "제출 상태 미확인"));
      if (this.activity.submissionCheckedAt) {
        this.addField(list, "제출 상태 확인", formatDeadline(this.activity.submissionCheckedAt / 1000, this.options.timezone));
      }
      if (!isNespa) this.addField(list, "수동 상태", this.manualCompleted ? "사용자가 수동 완료로 표시함" : "설정하지 않음");
      if (isNespa) {
        const attempts = this.activity.attempts;
        this.addField(list, "확인된 제출 횟수", this.activity.submissionCheck === "verified" && Number.isSafeInteger(attempts) && attempts >= 0
          ? `${attempts}회` : "확인 불가");
      }
      if (isNespa && this.activity.score !== null && this.activity.score !== undefined) this.addField(list, "최고 채점점수", String(this.activity.score));
      this.body.append(list);

      if (this.activity.description) {
        const descriptionSection = element("section", "plato-calendar-ext-description");
        descriptionSection.append(
          element("h3", "plato-calendar-ext-description-title", "설명"),
          element("p", "plato-calendar-ext-description-text", this.activity.description)
        );
        this.body.append(descriptionSection);
      }

      this.manualButton.textContent = this.manualCompleted ? "수동 완료 취소" : "수동 완료";
      this.manualButton.hidden = isNespa;
      this.manualButton.disabled = Boolean(this.saving) || !this.options.canSaveManual();
      this.manualButton.title = this.options.canSaveManual() ? "" : "PLATO 사용자 정보를 확인한 뒤 사용할 수 있습니다.";
      this.refreshButton.hidden = !this.canRefreshDetail();
      this.refreshButton.disabled = Boolean(this.saving || this.detailLoading);
      this.extraLinks?.remove();
      if (isNespa) {
        this.extraLinks = element("div", "plato-calendar-ext-nespa-links");
        for (const [label, value] of [["문제 PDF", this.activity.problemUrl], ["샘플 데이터", this.activity.sampleUrl], ["제출하기", this.activity.submissionUrl]]) {
          const url = namespace.nespaParser.safeUrl(value);
          if (!url) continue;
          const link = element("a", "plato-calendar-ext-button plato-calendar-ext-button-secondary", label);
          link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
          this.extraLinks.append(link);
        }
        this.footer.prepend(this.extraLinks);
      }
      const safeUrl = isNespa ? namespace.nespaParser.safeUrl(this.activity.detailUrl || this.activity.activityUrl) : parser.safePlatoUrl(this.activity.activityUrl);
      this.openLink.textContent = isNespa ? "제출내역 열기" : "활동 페이지 열기";
      this.openLink.hidden = !safeUrl;
      if (safeUrl) {
        this.openLink.href = safeUrl;
        this.openLink.target = isNespa ? "_blank" : "_self";
        this.openLink.rel = "noopener noreferrer";
      } else {
        this.openLink.removeAttribute("href");
      }
      if (focusedUrl && !this.overlay.hidden) {
        const replacement = [...(this.extraLinks?.querySelectorAll("a[href]") || [])].find(link => link.href === focusedUrl);
        (replacement || this.refreshButton).focus();
      }
    }

    async open(activity, manualCompleted) {
      if (this.destroyed) return;
      this.loadSequence += 1;
      window.clearTimeout(this.detailRefreshTimer);
      this.detailLoading = false;
      this.lastDetailAttemptAt = 0;
      this.activity = { ...activity };
      this.manualCompleted = Boolean(manualCompleted);
      this.saving = false;
      if (this.overlay.hidden) {
        this.previousFocus = document.activeElement;
      }
      this.feedback.textContent = "";
      this.render();
      this.loading.hidden = true;
      this.overlay.hidden = false;
      this.overlay.setAttribute("aria-hidden", "false");
      this.background ||= [...document.body.children].filter((node) => node !== this.overlay)
        .map((node) => ({ node, inert: node.inert }));
      this.background.forEach(({ node }) => { node.inert = true; });
      document.body.classList.add("plato-calendar-ext-modal-open");
      document.addEventListener("keydown", this.boundKeydown, true);
      document.addEventListener("visibilitychange", this.boundVisible);
      this.closeButton.focus();
      await this.refreshDetail();
    }

    canRefreshDetail() {
      return Boolean(this.activity && (this.activity.eventId || this.activity.typeCode === "assign" ||
        namespace.submissionParser.reportUrl(this.activity.courseId)));
    }

    scheduleDetailRefresh() {
      window.clearTimeout(this.detailRefreshTimer);
      if (this.destroyed || this.overlay.hidden || !this.canRefreshDetail() || this.detailLoading || this.saving) return;
      const interval = namespace.config.cacheTtlMs || 10 * 60 * 1000;
      const age = Date.now() - this.lastDetailAttemptAt;
      const remaining = age < 0 ? 0 : Math.max(0, interval - age);
      this.detailRefreshTimer = window.setTimeout(() => this.autoRefreshDetail(), remaining);
    }

    async autoRefreshDetail() {
      if (this.destroyed || this.overlay.hidden || document.hidden || this.detailLoading || this.saving || !this.canRefreshDetail()) return;
      const age = Date.now() - this.lastDetailAttemptAt;
      if (age >= 0 && age < (namespace.config.cacheTtlMs || 10 * 60 * 1000)) {
        this.scheduleDetailRefresh();
        return;
      }
      await this.refreshDetail();
    }

    async refreshDetail() {
      if (this.destroyed || this.overlay.hidden || this.detailLoading || this.saving || !this.canRefreshDetail()) return;
      const sequence = this.loadSequence;
      const activityId = this.activity.id;
      const focusedNode = this.dialog.contains(document.activeElement) ? document.activeElement : null;
      const focusedUrl = focusedNode?.tagName === "A" ? focusedNode.href : null;
      this.detailLoading = true;
      this.lastDetailAttemptAt = Date.now();
      window.clearTimeout(this.detailRefreshTimer);
      this.refreshButton.disabled = true;
      this.loading.hidden = false;
      this.feedback.textContent = "";
      try {
        const detail = await this.options.loadDetail(this.activity);
        if (!this.destroyed && !this.overlay.hidden && sequence === this.loadSequence && this.activity?.id === activityId && detail) {
          this.activity = detail;
          this.render();
          if (detail.detailFailed) this.feedback.textContent = "일정 상세 조회에 실패했습니다. 표시된 제출 상태는 별도 조회 결과입니다.";
          else if (detail.provider === "nespa" && detail.detailPartial) this.feedback.textContent = "일부 제출 내역이나 점수를 확인하지 못했습니다. 표시된 제출 여부는 확인된 내역 기준입니다. 상태 새로고침으로 다시 확인해 주세요.";
        }
      } catch (_error) {
        if (!this.destroyed && !this.overlay.hidden && sequence === this.loadSequence) this.feedback.textContent = "상세정보를 확인하지 못했습니다. 상태 새로고침으로 다시 시도해 주세요.";
      } finally {
        if (!this.destroyed && sequence === this.loadSequence) {
          this.detailLoading = false;
          this.loading.hidden = true;
          this.refreshButton.disabled = Boolean(this.saving);
          if (!this.overlay.hidden && document.activeElement === document.body && focusedNode) {
            const target = focusedNode.isConnected ? focusedNode : [...this.dialog.querySelectorAll("a[href]")].find(link => link.href === focusedUrl);
            target?.focus();
          }
          this.scheduleDetailRefresh();
        }
      }
    }

    close() {
      window.clearTimeout(this.detailRefreshTimer);
      document.removeEventListener("visibilitychange", this.boundVisible);
      if (this.overlay.hidden) {
        return;
      }
      this.loadSequence += 1;
      this.detailLoading = false;
      this.overlay.hidden = true;
      this.overlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("plato-calendar-ext-modal-open");
      this.background?.forEach(({ node, inert }) => { node.inert = inert; });
      this.background = null;
      document.removeEventListener("keydown", this.boundKeydown, true);
      const restorable = this.previousFocus && this.previousFocus !== document.body && this.previousFocus !== document.documentElement &&
        this.previousFocus.isConnected && !this.previousFocus.closest?.('[hidden], [inert]') && typeof this.previousFocus.focus === "function";
      if (restorable) {
        this.previousFocus.focus();
      }
      if (!restorable || document.activeElement !== this.previousFocus) {
        this.options.restoreFocus?.(this.activity?.id);
      }
    }

    onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = [...this.dialog.querySelectorAll(
        'a[href]:not([hidden]), button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) {
        event.preventDefault();
        this.dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!focusable.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.close();
      this.overlay.remove();
    }
  }

  namespace.ActivityModal = ActivityModal;
})(globalThis);
