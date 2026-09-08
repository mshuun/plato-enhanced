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

  function formatDeadline(timestamp, timezone) {
    const options = {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit"
    };
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

  class ActivityModal {
    constructor(options) {
      this.options = options;
      this.activity = null;
      this.manualCompleted = false;
      this.previousFocus = null;
      this.loadSequence = 0;
      this.boundKeydown = this.onKeydown.bind(this);
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
          if (!this.overlay.hidden) {
            this.manualButton.focus();
          }
        }
      });

      this.openLink = element("a", "plato-calendar-ext-button plato-calendar-ext-button-primary", "활동 페이지 열기");
      this.openLink.addEventListener("click", () => this.close());
      this.feedback = element("div", "plato-calendar-ext-modal-feedback");
      this.feedback.setAttribute("role", "status");
      this.feedback.setAttribute("aria-live", "polite");
      this.footer.append(this.manualButton, this.openLink);
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
      const status = namespace.calendarModel.classifyActivity(
        this.activity,
        this.manualCompleted,
        Math.floor(Date.now() / 1000),
        namespace.config.dueSoonHours
      );
      this.title.textContent = this.activity.title;
      this.body.replaceChildren();

      const list = element("dl", "plato-calendar-ext-detail-list");
      this.addField(list, "강좌", this.activity.courseName);
      this.addField(list, "활동 유형", this.activity.typeLabel);
      this.addField(list, "마감", formatDeadline(this.activity.deadline, this.options.timezone));
      this.addField(
        list,
        "마감 여부",
        Math.floor(Date.now() / 1000) > this.activity.deadline ? "마감 시각 경과" : "마감 전"
      );
      const accent = ["submitted", "completed", "manual"].includes(status.code) &&
        Number(this.activity.deadline) < Math.floor(Date.now() / 1000) ? "finished-past" : status.code;
      this.addField(list, "현재 상태", `${status.icon} ${status.label}`, `plato-calendar-ext-detail-status-${accent}`);
      this.addField(list, "PLATO 원본 상태", this.activity.sourceStatus && this.activity.sourceStatus.label);
      this.addField(list, "제출 여부", this.activity.submissionStatus || (this.activity.submissionCheck === "failed" ? "상태 조회 실패" : "제출 상태 미확인"));
      if (this.activity.submissionCheckedAt) {
        this.addField(list, "제출 상태 확인", formatDeadline(this.activity.submissionCheckedAt / 1000, this.options.timezone));
      }
      this.addField(list, "수동 상태", this.manualCompleted ? "사용자가 수동 완료로 표시함" : "설정하지 않음");
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
      this.manualButton.disabled = Boolean(this.saving) || !this.options.canSaveManual();
      this.manualButton.title = this.options.canSaveManual() ? "" : "PLATO 사용자 정보를 확인한 뒤 사용할 수 있습니다.";
      const safeUrl = parser.safePlatoUrl(this.activity.activityUrl);
      this.openLink.hidden = !safeUrl;
      if (safeUrl) {
        this.openLink.href = safeUrl;
        this.openLink.target = "_self";
      } else {
        this.openLink.removeAttribute("href");
      }
    }

    async open(activity, manualCompleted) {
      const sequence = ++this.loadSequence;
      this.activity = { ...activity };
      this.manualCompleted = Boolean(manualCompleted);
      this.saving = false;
      if (this.overlay.hidden) {
        this.previousFocus = document.activeElement;
      }
      this.feedback.textContent = "";
      this.render();
      this.loading.hidden = !activity.eventId && activity.typeCode !== "assign";
      this.overlay.hidden = false;
      this.overlay.setAttribute("aria-hidden", "false");
      this.background ||= [...document.body.children].filter((node) => node !== this.overlay)
        .map((node) => ({ node, inert: node.inert }));
      this.background.forEach(({ node }) => { node.inert = true; });
      document.body.classList.add("plato-calendar-ext-modal-open");
      document.addEventListener("keydown", this.boundKeydown, true);
      this.closeButton.focus();

      if (activity.eventId || activity.typeCode === "assign") {
        try {
          const detail = await this.options.loadDetail(this.activity);
          if (sequence === this.loadSequence && detail) {
            this.activity = detail;
            this.render();
            if (detail.detailFailed) this.feedback.textContent = "일정 상세 조회에 실패했습니다. 표시된 제출 상태는 별도 조회 결과입니다.";
          }
        } catch (_error) {
          if (sequence === this.loadSequence) this.feedback.textContent = "상세정보를 확인하지 못했습니다. 다시 열어 시도해 주세요.";
        } finally {
          if (sequence === this.loadSequence) {
            this.loading.hidden = true;
          }
        }
      }
    }

    close() {
      if (this.overlay.hidden) {
        return;
      }
      this.loadSequence += 1;
      this.overlay.hidden = true;
      this.overlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("plato-calendar-ext-modal-open");
      this.background?.forEach(({ node, inert }) => { node.inert = inert; });
      this.background = null;
      document.removeEventListener("keydown", this.boundKeydown, true);
      if (this.previousFocus?.isConnected && typeof this.previousFocus.focus === "function") {
        this.previousFocus.focus();
      } else {
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
      this.close();
      this.overlay.remove();
    }
  }

  namespace.ActivityModal = ActivityModal;
})(globalThis);
