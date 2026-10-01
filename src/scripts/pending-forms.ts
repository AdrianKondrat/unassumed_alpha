// Progressive enhancement for slow server actions (AI calls). A form marked `data-pending` has its submit
// button disabled after the first submit, and an optional `[data-pending-status]` element is revealed. This
// only limits accidental double-posts; the server-side lease/constraints stay authoritative.

function reset(form: HTMLFormElement) {
  const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
  const status = form.querySelector<HTMLElement>("[data-pending-status]");
  if (button) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
  if (status) status.hidden = true;
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-pending]")) {
  form.addEventListener("submit", () => {
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
    const status = form.querySelector<HTMLElement>("[data-pending-status]");
    // Deferred so the browser has already collected the form data before the button is disabled.
    setTimeout(() => {
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      }
      if (status) status.hidden = false;
    }, 0);
  });
}

// Back/forward cache: a restored page must not stay stuck in the pending state.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    for (const form of document.querySelectorAll<HTMLFormElement>("form[data-pending]")) reset(form);
  }
});
