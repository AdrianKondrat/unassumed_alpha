/**
 * UNASSUMED — the whole client. No framework, no build step, no dependencies.
 *
 * Everything here is an enhancement. The page is complete and correct before
 * this file runs: the marks are drawn, the teardown shows its finished state,
 * and both forms are real HTML forms that POST to /api/waitlist and get a
 * redirect back. If this script fails to load, nothing on the page breaks.
 */
(() => {
  "use strict";

  const reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Rhetorical marks ───────────────────────────────────────────────────
     Highlighter and strike-through animate in as you reach each section.
     Sections already on screen are simply left drawn, and if the browser has
     no IntersectionObserver nothing is ever hidden — the marks are the brand,
     so they must never depend on this running.
     ───────────────────────────────────────────────────────────────────── */
  function initReveal() {
    const targets = document.querySelectorAll("[data-reveal]");
    if (!targets.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );

    for (const target of targets) {
      if (target.getBoundingClientRect().top < innerHeight) continue;
      target.classList.add("will-reveal");
      observer.observe(target);
    }
  }

  /* ── The teardown ───────────────────────────────────────────────────────
     The frame pins for the length of the section and reads its own progress
     off getBoundingClientRect, writing a stage number onto the pinned element.
     All appearance lives in CSS keyed on [data-stage]; JS only sets the stage
     and the score digits.
     ───────────────────────────────────────────────────────────────────── */
  function initTeardown() {
    const section = document.querySelector("[data-teardown]");
    if (!section) return;
    const pin = section.querySelector("[data-pin]");
    const score = section.querySelector("[data-score]");
    if (!pin || !score) return;

    // Reduced motion turns the section into a static statement of its result.
    // The CSS unpins it; leaving [data-stage] unset shows the finished state.
    if (reducedMotion) return;

    let frame = 0;
    let lastStage = -1;
    let lastScore = -1;

    const apply = () => {
      frame = 0;
      const rect = section.getBoundingClientRect();
      const travel = rect.height - innerHeight;
      const p = travel <= 0 ? 1 : Math.min(1, Math.max(0, -rect.top / travel));

      const stage =
        p < 0.1 ? 0 : p < 0.26 ? 1 : p < 0.4 ? 2 : p < 0.54 ? 3 : p < 0.64 ? 4 : p < 0.86 ? 5 : 6;
      if (stage !== lastStage) {
        pin.dataset.stage = String(stage);
        lastStage = stage;
      }

      const climb = Math.min(1, Math.max(0, (p - 0.55) / 0.32));
      const value = Math.round(41 + 37 * climb);
      if (value !== lastScore) {
        score.textContent = String(value);
        lastScore = value;
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
  }

  /* ── Waitlist forms ─────────────────────────────────────────────────────
     Progressive enhancement over a working HTML form. We intercept the submit
     only to avoid a full page navigation; the endpoint, the field names and
     the validation are identical either way.
     ───────────────────────────────────────────────────────────────────── */

  // Matches the Worker's rule closely enough to catch typos before a round
  // trip. The server's answer is still the authority.
  const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@.,;<>"]+(\.[^\s@.,;<>"]+)*\.[A-Za-z]{2,}$/;

  function successMarkup(isDark) {
    const wrap = document.createElement("div");
    wrap.className = isDark ? "done done-dark" : "done";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("tabindex", "-1");

    const strong = document.createElement("strong");
    strong.textContent = "You’re in.";

    const p = document.createElement("p");
    p.textContent =
      "While you wait: which assumption about your customer are you least sure about? Reply to the confirmation email and we’ll rehearse it with you first.";

    wrap.append(strong, p);
    return wrap;
  }

  function initForm(form) {
    const field = form.querySelector(".field");
    const input = form.querySelector('input[name="email"]');
    const button = form.querySelector('button[type="submit"]');
    const errorNote = form.querySelector("[data-error]");
    if (!field || !input || !button || !errorNote) return;

    const isDark = field.classList.contains("field-dark");
    const buttonLabel = button.innerHTML;
    let inFlight = false;

    // The note carries role="alert" in the markup and starts empty, so a
    // screen reader announces the message the moment it is written. Toggling
    // the role at the same time as the text is unreliable across readers.
    if (!errorNote.id) errorNote.id = `${input.id}-error`;

    const showError = (message) => {
      errorNote.textContent = message;
      field.classList.add("field-err");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorNote.id);
    };

    const clearError = () => {
      errorNote.textContent = "";
      field.classList.remove("field-err");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    };

    input.addEventListener("input", () => {
      if (errorNote.textContent) clearError();
    });

    form.addEventListener("submit", async (event) => {
      const email = input.value.trim();

      if (!EMAIL_RE.test(email)) {
        // Only now do we take over from the browser; an invalid address never
        // reaches the network.
        event.preventDefault();
        showError("That address doesn’t look right. Check it and try again.");
        input.focus();
        return;
      }

      // From here the submission is valid, so intercept and send it in the
      // background rather than navigating away.
      event.preventDefault();
      if (inFlight) return;
      inFlight = true;
      clearError();

      button.setAttribute("aria-busy", "true");
      button.disabled = true;
      button.textContent = "Sending…";

      const restore = () => {
        inFlight = false;
        button.removeAttribute("aria-busy");
        button.disabled = false;
        button.innerHTML = buttonLabel;
      };

      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            email,
            source: form.dataset.source || "unknown",
            company: form.querySelector('input[name="company"]')?.value || "",
          }),
        });

        const result = await response.json().catch(() => ({}));

        if (response.ok && result.ok) {
          const done = successMarkup(isDark);
          form.replaceWith(done);
          // Move focus so a screen reader lands on the confirmation rather
          // than on the element after a form that no longer exists. The form
          // is gone, so there is deliberately nothing to restore.
          done.focus();
          return;
        }

        showError(
          result.message ||
            "Something broke on our side, not yours. Try again in a moment.",
        );
        input.focus();
        restore();
      } catch {
        showError(
          "We couldn’t reach the server. Check your connection and try again.",
        );
        input.focus();
        restore();
      }
    });
  }

  function init() {
    initReveal();
    initTeardown();
    document.querySelectorAll("[data-waitlist]").forEach(initForm);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
