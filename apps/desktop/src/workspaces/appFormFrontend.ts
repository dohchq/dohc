export interface AppFormFrontendInput {
  title: string;
  fields: { name: string; type: "text" | "number" | "checkbox" | "date" | "select" | "url"; options?: string[] }[];
}

/** Only explicitly public fields belong in this source-backed submission form. */
export function generateAppFormFrontend(input: AppFormFrontendInput): { "frontend.js": string; "frontend.css": string } {
  const data = JSON.stringify(input).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return { "frontend.js": `import './frontend.css';\n(() => {\nconst definition = ${data};\n${FORM_SCRIPT}\n})();\n`, "frontend.css": FORM_CSS };
}

const FORM_SCRIPT = String.raw`
const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const main = element("main");
const title = element("h1", definition.title);
title.id = "form-title";
main.setAttribute("aria-labelledby", title.id);
const intro = element("p", "All fields are optional.");
intro.className = "intro";
const form = element("form");
const fields = element("fieldset");
const legend = element("legend", "Your response");
legend.className = "sr-only";
fields.append(legend);
const controls = definition.fields.map((field, index) => {
  const wrapper = element("div");
  wrapper.className = field.type === "checkbox" ? "field check-field" : "field";
  const id = "field-" + index;
  const label = element("label", field.name);
  label.htmlFor = id;
  const control = element(field.type === "select" ? "select" : "input");
  control.id = id;
  control.name = id;
  if (field.type === "select") {
    const empty = element("option", "Choose an option");
    empty.value = "";
    control.append(empty);
    for (const value of field.options || []) {
      const option = element("option", value);
      option.value = value;
      control.append(option);
    }
  } else {
    control.type = field.type;
    if (field.type === "number") {
      control.step = "any";
      control.min = String(-Number.MAX_SAFE_INTEGER);
      control.max = String(Number.MAX_SAFE_INTEGER);
    } else if (field.type === "text" || field.type === "url") {
      control.maxLength = 2000;
    }
    if (field.type === "url") control.placeholder = "https://";
  }
  const error = element("p");
  error.className = "field-error";
  error.id = id + "-error";
  error.hidden = true;
  control.setAttribute("aria-describedby", error.id);
  control.addEventListener("input", () => {
    control.setCustomValidity("");
    control.removeAttribute("aria-invalid");
    error.hidden = true;
  });
  if (field.type === "checkbox") wrapper.append(control, label, error);
  else wrapper.append(label, control, error);
  fields.append(wrapper);
  return { field, control, error };
});
const submit = element("button", "Submit");
submit.type = "submit";
const status = element("p");
status.className = "status";
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");
status.setAttribute("aria-atomic", "true");
status.tabIndex = -1;
const another = element("button", "Submit another response");
another.type = "button";
another.hidden = true;
form.append(fields, submit);
main.append(title, intro, form, status, another);
(document.getElementById("root") || document.body).append(main);

let port, pending, attempt, busy = false, received = false, uncertain = false;
const finish = result => {
  if (!pending) return;
  const item = pending;
  pending = undefined;
  clearTimeout(item.timer);
  item.resolve(result);
};
const send = () => {
  if (!port || !pending || pending.sent) return;
  pending.sent = true;
  try { port.postMessage(pending.message); }
  catch { finish({ uncertain: true }); }
};
const receiveChannel = event => {
  if (port || event.source !== window.parent || event.source === window) return;
  if (!record(event.data) || event.data.kind !== "dohc-app-channel" || event.data.version !== 1 || event.ports.length !== 1) return;
  window.removeEventListener("message", receiveChannel);
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (!pending || !record(data) || data.id !== pending.message.id) return;
    const value = data.value;
    if (data.ok === true && record(value) && record(value.result) &&
        typeof value.result.id === "string" && value.result.id.length > 0 &&
        Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.replayed === "boolean") {
      finish({ saved: true });
    } else if (data.ok === false && [400, 404, 409, 413].includes(data.status)) {
      const message = data.status === 409 && record(data.error) && typeof data.error.message === "string" &&
        data.error.message.length > 0 && data.error.message.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(data.error.message) ? data.error.message : "Check your answers and try again.";
      finish({ refused: true, message });
    } else finish({ uncertain: true });
  };
  port.start();
  send();
};
window.addEventListener("message", receiveChannel);
const invoke = () => new Promise(resolve => {
  pending = {
    message: { id: crypto.randomUUID(), op: "backend.invoke", operation: "submit",
      idempotencyKey: attempt.key, input: attempt.input },
    resolve, sent: false, timer: setTimeout(() => finish({ uncertain: true }), 30000),
  };
  send();
});
const readDraft = () => {
  const entries = [];
  let invalid;
  for (const { field, control, error } of controls) {
    let value = field.type === "checkbox" ? control.checked : control.value || null;
    let message = "";
    if (field.type === "number" && value !== null) {
      value = Number(value);
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) message = "Enter a number within the allowed range.";
    }
    if (field.type === "url" && value !== null) {
      try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || /\s/.test(value)) message = "Enter a web address starting with https:// or http://.";
      } catch { message = "Enter a web address starting with https:// or http://."; }
    }
    if (typeof value === "string" && value.length > 2000) message = "Use 2000 characters or fewer.";
    if (message) {
      error.textContent = message;
      error.hidden = false;
      control.setCustomValidity(message);
      control.setAttribute("aria-invalid", "true");
      invalid ||= control;
    }
    entries.push([field.name, value]);
  }
  if (invalid) { invalid.focus(); invalid.reportValidity(); return; }
  return Object.fromEntries(entries);
};
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || received) return;
  if (!attempt) {
    const input = readDraft();
    if (!input) return;
    attempt = { key: "submit:" + crypto.randomUUID(), input };
  }
  busy = true;
  fields.disabled = true;
  submit.disabled = true;
  submit.textContent = "Submitting…";
  status.textContent = "Sending your response. Keep this page open until it is confirmed.";
  const result = await invoke();
  busy = false;
  submit.disabled = false;
  if (result.saved) {
    attempt = undefined;
    uncertain = false;
    received = true;
    form.hidden = true;
    intro.hidden = true;
    status.textContent = "Response received.";
    another.hidden = false;
    status.focus();
  } else if (result.refused && !uncertain) {
    attempt = undefined;
    fields.disabled = false;
    submit.textContent = "Submit";
    status.textContent = "Response not saved. " + result.message;
    status.focus();
  } else {
    uncertain = true;
    submit.textContent = "Try again";
    status.textContent = "Your response may have been saved. Try again to confirm the same response. Keep this page open; reloading loses this retry.";
    status.focus();
  }
});
another.addEventListener("click", () => {
  form.reset();
  fields.disabled = false;
  form.hidden = false;
  intro.hidden = false;
  another.hidden = true;
  received = false;
  status.textContent = "";
  submit.textContent = "Submit";
  (controls[0]?.control || submit).focus();
});
window.addEventListener("beforeunload", event => {
  if (attempt) { event.preventDefault(); event.returnValue = ""; }
});
`;

export const FORM_CSS = `
:root { color-scheme: light dark; --bg: #faf9f5; --panel: #f3f1ea; --ink: #1c1b18; --muted: #55524a; --line: #e4e1d8; --accent: #2d342e; --danger: #a6402c; }
@media (prefers-color-scheme: dark) { :root { --bg: #131211; --panel: #1b1d1a; --ink: #f6f4ee; --muted: #a9a599; --line: #2a2925; --accent: #d7d0c0; --danger: #e08065; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { width: min(100%, 580px); margin: 0 auto; padding: 48px 24px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: -.025em; overflow-wrap: anywhere; }
.intro { color: var(--muted); margin: 0 0 32px; font-size: 14px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.field { margin: 0 0 24px; }
label { display: block; margin-bottom: 8px; font-weight: 500; overflow-wrap: anywhere; }
input, select { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: inherit; }
input::placeholder { color: var(--muted); }
.check-field { display: grid; grid-template-columns: 24px 1fr; column-gap: 12px; align-items: start; }
.check-field input { width: 20px; min-height: 20px; height: 20px; margin: 2px 0 0; accent-color: var(--accent); }
.check-field label { margin: 0; }
.check-field .field-error { grid-column: 2; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
:disabled { opacity: .65; cursor: not-allowed; }
button { min-height: 44px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--bg); padding: 10px 20px; font: inherit; font-weight: 500; cursor: pointer; }
button:hover:not(:disabled) { opacity: .9; }
button:active:not(:disabled) { opacity: .8; }
.status { color: var(--muted); margin: 20px 0; overflow-wrap: anywhere; }
.status:empty { margin: 0; }
.field-error { color: var(--danger); font-size: 14px; margin: 8px 0 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 400px) { main { padding: 32px 20px; } button { width: 100%; } }
`;
