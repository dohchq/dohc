import { APP_BACKEND_INPUT_BYTES, APP_BACKEND_UPLOAD_BYTES, APP_BACKEND_OPERATION_FILES, type AppBackendJson } from "@dohc/security-contract/app-backend";
import { FORM_CSS } from "./datasetFormStyles";

export interface DatasetFormField {
  fieldId: string;
  name: string;
  type: "text" | "number" | "checkbox" | "date" | "select" | "multi-select" | "url" | "attachment" | "relation";
  relation?: { operation: string; keyFieldId: string; labelFieldId: string; keyType: "text" | "number"; many: boolean };
  options?: string[];
  required: boolean;
  omitWhenEmpty: boolean;
  default?: AppBackendJson;
}
export interface DatasetFormFrontendInput { title: string; operation: string; fields: DatasetFormField[] }

export function generateDatasetFormFrontend(input: DatasetFormFrontendInput): { "frontend.js": string; "frontend.css": string } {
  const data = JSON.stringify({ ...input, inputBytes: APP_BACKEND_INPUT_BYTES, uploadBytes: APP_BACKEND_UPLOAD_BYTES, operationFiles: APP_BACKEND_OPERATION_FILES })
    .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return { "frontend.js": `import './frontend.css';\n(() => {\nconst definition = ${data};\n${SCRIPT}\n})();\n`, "frontend.css": FORM_CSS };
}

const SCRIPT = String.raw`
const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const main = element("main"), title = element("h1", definition.title);
title.id = "form-title";
main.setAttribute("aria-labelledby", title.id);
const intro = element("p", "Required fields are marked with *.");
intro.className = "intro";
const form = element("form"), fields = element("fieldset"), legend = element("legend", "Your response");
legend.className = "sr-only";
fields.append(legend);
const controls = definition.fields.map((field, index) => {
  const wrapper = element("div");
  wrapper.className = field.type === "checkbox" ? "field check-field" : "field";
  const id = "field-" + index;
  const label = element("label", field.name + (field.required ? " *" : ""));
  label.htmlFor = id;
  const choice = field.type === "select" || field.type === "multi-select" || field.type === "relation";
  const control = element(choice ? "select" : "input");
  control.id = id; control.name = id;
  // A required boolean must have a value; false is a valid value.
  control.required = field.required && field.type !== "checkbox";
  if (choice) {
    control.multiple = field.type === "multi-select" || field.relation?.many === true;
    if (!control.multiple) { const empty = element("option", "Choose an option"); empty.value = ""; control.append(empty); }
    for (const value of field.options || []) { const option = element("option", value); option.value = value; control.append(option); }
  } else {
    control.type = field.type === "attachment" ? "file" : field.type;
    if (field.type === "number") { control.step = "any"; control.min = String(-Number.MAX_SAFE_INTEGER); control.max = String(Number.MAX_SAFE_INTEGER); }
    if (field.type === "text" || field.type === "url") control.maxLength = 2000;
    if (field.type === "url") control.placeholder = "https://";
  }
  if (field.type === "checkbox") control.defaultChecked = field.default === true;
  else if (choice) {
    for (const option of control.options) option.defaultSelected = Array.isArray(field.default) ? field.default.includes(option.value) : option.value === field.default;
  } else if (field.type !== "attachment" && field.default !== undefined && field.default !== null) control.defaultValue = String(field.default);
  const error = element("p"); error.className = "field-error"; error.id = id + "-error"; error.hidden = true;
  control.setAttribute("aria-describedby", error.id);
  control.addEventListener("input", () => { control.setCustomValidity(""); control.removeAttribute("aria-invalid"); error.hidden = true; });
  if (field.type === "checkbox") wrapper.append(control, label, error);
  else wrapper.append(label, control, error);
  let search, searchButton, more;
  if (field.relation) {
    search = element("input"); search.type = "search"; search.maxLength = 200;
    search.setAttribute("aria-label", "Search " + field.name);
    searchButton = element("button", "Search"); searchButton.type = "button";
    more = element("button", "More choices"); more.type = "button"; more.hidden = true;
    wrapper.append(search, searchButton, more);
  }
  fields.append(wrapper);
  return { field, control, error, search, searchButton, more, cursor: null };
});
const submit = element("button", "Submit"); submit.type = "submit";
const status = element("p"); status.className = "status"; status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true"); status.tabIndex = -1;
const another = element("button", "Submit another response"); another.type = "button"; another.hidden = true;
form.append(fields, submit); main.append(title, intro, form, status, another);
fields.disabled = true; submit.disabled = true;
(document.getElementById("root") || document.body).append(main);

let port, pending, attempt, busy = false, received = false, ready = false;
const finish = result => {
  if (!pending) return;
  const item = pending; pending = undefined; clearTimeout(item.timer); item.resolve(result);
};
const send = () => {
  if (!port || !pending || pending.sent) return;
  pending.sent = true;
  try { port.postMessage(pending.message); } catch { finish({ uncertain: true }); }
};
const validAttempt = value => {
  if (!record(value) || !Object.hasOwn(value, "attempt")) return false;
  if (value.attempt === null) return true;
  const item = value.attempt;
  return record(item) && typeof item.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(item.token) &&
    typeof item.idempotencyKey === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item.idempotencyKey) && record(item.input);
};
const receiveChannel = event => {
  if (port || event.source !== window.parent || event.source === window) return;
  if (!record(event.data) || event.data.kind !== "dohc-app-channel" || event.data.version !== 1 || event.ports.length !== 1) return;
  window.removeEventListener("message", receiveChannel);
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (!pending || !record(data) || data.id !== pending.message.id) return;
    const value = data.value;
    if (data.ok === true && record(value)) {
      if (pending.message.op === "backend.attempt" && validAttempt(value)) { finish(value); return; }
      if (pending.message.op === "backend.upload" && record(value.file) && typeof value.file.fileId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.file.fileId)) {
        finish({ fileId: value.file.fileId }); return;
      }
      if (pending.message.op === "backend.invoke" && record(value.result) &&
          controls.some(item => item.field.relation?.operation === pending.message.operation)) {
        finish({ page: value.result }); return;
      }
      if (pending.message.op === "backend.invoke" && record(value.result) &&
          ((typeof value.result.id === "string" && value.result.id.length > 0) || Number.isSafeInteger(value.result.id)) &&
          Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.replayed === "boolean") {
        finish({ saved: true }); return;
      }
    }
    if (data.ok === false && [400, 404, 409, 413].includes(data.status)) {
      const message = data.status === 409 && record(data.error) && typeof data.error.message === "string" &&
        data.error.message.length > 0 && data.error.message.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(data.error.message)
        ? data.error.message : "Check your answers and try again.";
      finish({ refused: true, definitive: data.status === 409 && record(data.error) && typeof data.error.code === "string", message });
    } else finish({ uncertain: true });
  };
  port.start();
  request({ op: "backend.attempt", operation: definition.operation, request: { action: "get" } }).then(result => {
    if (!result || result.uncertain || result.refused) { status.textContent = "This form could not load its pending response. Reload to try again."; status.focus(); return; }
    if (result.attempt) {
      attempt = { values: record(result.attempt.input.values) ? result.attempt.input.values : {}, key: result.attempt.idempotencyKey,
        token: result.attempt.token, input: result.attempt.input, uncertain: true };
      for (const { field, control } of controls) {
        const value = attempt.values[field.fieldId];
        if (value === undefined || value === null) continue;
        if (field.type === "attachment") continue;
        if (field.type === "checkbox") control.checked = value === true;
        else if (field.relation) {
          for (const key of field.relation.many && Array.isArray(value) ? value : [value]) {
            const option = element("option", String(key)); option.value = String(key); option.selected = true; control.append(option);
          }
        }
        else if (field.type === "multi-select") { for (const option of control.options) option.selected = Array.isArray(value) && value.includes(option.value); }
        else if (field.type === "select") control.value = String(value);
        else control.value = String(value);
      }
      status.textContent = "A pending response is ready. Submit to try again.";
      submit.textContent = "Try again";
    }
    ready = true; fields.disabled = !!attempt; submit.disabled = false;
    if (!attempt) void loadRelations();
  });
};
window.addEventListener("message", receiveChannel);
const request = message => new Promise(resolve => {
  pending = { message: { id: crypto.randomUUID(), ...message }, resolve, sent: false,
    timer: setTimeout(() => finish({ uncertain: true }), 30000) };
  send();
});
const loadChoices = async (item, after = null) => {
  const relation = item.field.relation;
  const result = await request({ op: "backend.invoke", operation: relation.operation,
    idempotencyKey: "choices:" + crypto.randomUUID(),
    input: { limit: 50, ...(after ? { after } : {}), ...(item.search.value ? { search: item.search.value } : {}) } });
  const page = result.page;
  const scalar = value => relation.keyType === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === "string" && value.length > 0;
  if (!record(page) || Object.keys(page).some(key => !["rows", "nextCursor"].includes(key)) || !Array.isArray(page.rows) || page.rows.length > 50 ||
      !(page.nextCursor === null || record(page.nextCursor) && Object.keys(page.nextCursor).every(key => ["id", "value"].includes(key)) &&
        ["string", "number"].includes(typeof page.nextCursor.id) && ["string", "number"].includes(typeof page.nextCursor.value)) ||
      page.rows.some(row => !record(row) || Object.keys(row).some(key => !["id", "version", "values"].includes(key)) || !record(row.values) ||
        Object.keys(row.values).some(key => ![relation.keyFieldId, relation.labelFieldId].includes(key)) || !scalar(row.values[relation.keyFieldId]) ||
        !["string", "number"].includes(typeof row.values[relation.labelFieldId]))) {
    item.error.textContent = "Choices could not load. Search to try again."; item.error.hidden = false; return;
  }
  const selected = [...item.control.selectedOptions].filter(option => option.value);
  item.control.replaceChildren();
  if (!item.control.multiple) { const empty = element("option", "Choose an option"); empty.value = ""; item.control.append(empty); }
  for (const option of selected) item.control.append(option);
  for (const row of page.rows) {
    const key = String(row.values[relation.keyFieldId]);
    if ([...item.control.options].some(option => option.value === key)) continue;
    const option = element("option", String(row.values[relation.labelFieldId])); option.value = key; item.control.append(option);
  }
  item.cursor = page.nextCursor; item.more.hidden = item.cursor === null; item.error.hidden = true;
};
const loadRelations = async () => {
  const related = controls.filter(item => item.field.relation);
  if (!related.length) return;
  busy = true; fields.disabled = true; submit.disabled = true;
  for (const item of related) await loadChoices(item);
  busy = false; fields.disabled = false; submit.disabled = false;
};
for (const item of controls.filter(item => item.field.relation)) {
  const load = async more => {
    if (!ready || busy || attempt || received) return;
    busy = true; fields.disabled = true; submit.disabled = true;
    await loadChoices(item, more ? item.cursor : null);
    busy = false; fields.disabled = false; submit.disabled = false;
  };
  item.searchButton.addEventListener("click", () => void load(false));
  item.more.addEventListener("click", () => void load(true));
}
const readDraft = () => {
  const values = {}, uploads = []; let invalid;
  for (const { field, control, error } of controls) {
    let value = field.type === "checkbox" ? control.checked : field.type === "multi-select" ? [...control.selectedOptions].map(option => option.value)
      : field.type === "attachment" ? control.files[0] || null : control.value || null;
    if (field.relation) {
      const convert = value => field.relation.keyType === "number" ? Number(value) : value;
      value = field.relation.many ? [...control.selectedOptions].map(option => convert(option.value)) : control.value ? convert(control.value) : null;
    }
    let message = "";
    if (field.relation?.many && value.length > 100) message = "Choose 100 related records or fewer.";
    if (field.required && (value === null || (Array.isArray(value) && !value.length))) message = "Complete this required field.";
    if (field.type === "number" && value !== null) {
      value = Number(value);
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) message = "Enter a number within the allowed range.";
    }
    if (field.type === "number" && control.validity.badInput) message = "Enter a valid number.";
    if (field.type === "url" && value !== null) {
      try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || /\s/.test(value)) throw new Error(); }
      catch { message = "Enter a web address starting with https:// or http://."; }
    }
    if (typeof value === "string" && value.length > 2000) message = "Use 2000 characters or fewer.";
    if (field.type === "attachment" && value !== null) {
      if (value.size < 1 || value.size > definition.uploadBytes) message = "Choose a nonempty file up to 5 MB.";
      else uploads.push({ fieldId: field.fieldId, file: value });
    } else if (!(value === null && field.omitWhenEmpty)) values[field.fieldId] = value;
    if (message) {
      error.textContent = message; error.hidden = false; control.setCustomValidity(message);
      control.setAttribute("aria-invalid", "true"); invalid ||= control;
    }
  }
  if (invalid) { invalid.focus(); invalid.reportValidity(); return; }
  if (uploads.length > definition.operationFiles) {
    status.textContent = "Choose " + definition.operationFiles + " files or fewer for one response."; status.focus(); return;
  }
  const boundedValues = { ...values, ...Object.fromEntries(uploads.map(upload => [upload.fieldId, "x".repeat(128)])) };
  if (new TextEncoder().encode(JSON.stringify({ values: boundedValues })).byteLength > definition.inputBytes) {
    status.textContent = "Your response is too long. Shorten the answers and try again."; status.focus(); return;
  }
  return { values, uploads };
};
const readFile = file => new Promise(resolve => {
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result.slice(reader.result.indexOf(",") + 1) : null);
  reader.onerror = reader.onabort = () => resolve(null);
  try { reader.readAsDataURL(file); } catch { resolve(null); }
});
const saveAttempt = async () => {
  if (attempt.token) return { saved: true };
  const result = await request({ op: "backend.attempt", operation: definition.operation,
    request: { action: "save", idempotencyKey: attempt.key, input: { values: attempt.values } } });
  if (!result || result.uncertain || result.refused || !result.attempt) return result?.refused ? result : { uncertain: true };
  if (attempt.key !== result.attempt.idempotencyKey) attempt.uncertain = true;
  attempt.token = result.attempt.token; attempt.key = result.attempt.idempotencyKey;
  attempt.input = result.attempt.input;
  attempt.values = record(result.attempt.input.values) ? result.attempt.input.values : {};
  return { saved: true };
};
const clearAttempt = async () => {
  if (!attempt?.token) return true;
  const result = await request({ op: "backend.attempt", operation: definition.operation, request: { action: "clear", token: attempt.token } });
  return !!result && !result.uncertain && !result.refused && result.attempt === null;
};
form.addEventListener("submit", async event => {
  event.preventDefault(); if (busy || received || !ready) return;
  if (!attempt) {
    const draft = readDraft(); if (!draft) return;
    attempt = { ...draft, key: "submit:" + crypto.randomUUID(), uncertain: false };
  }
  busy = true; fields.disabled = true; submit.disabled = true; submit.textContent = "Submitting\u2026";
  status.textContent = "Sending your response. Keep this page open until it is confirmed.";
  while (attempt.uploads?.length) {
    const upload = attempt.uploads[0];
    if (!upload.bytesBase64) upload.bytesBase64 = await readFile(upload.file);
    const result = upload.bytesBase64 ? await request({ op: "backend.upload", idempotencyKey: attempt.key + ":file:" + upload.fieldId,
      name: upload.file.name, contentType: upload.file.type || "application/octet-stream", bytesBase64: upload.bytesBase64 }) : { refused: true };
    if (!result.fileId) {
      busy = false; submit.disabled = false; submit.textContent = "Try again";
      if (result.refused) { attempt = undefined; fields.disabled = false; submit.textContent = "Submit"; status.textContent = "The file was not accepted. Choose another file and try again."; }
      else status.textContent = "The file upload is unconfirmed. Try again with the same file. Keep this page open.";
      status.focus(); return;
    }
    attempt.values[upload.fieldId] = result.fileId; attempt.uploads.shift();
  }
  const saved = await saveAttempt();
  if (!saved.saved) {
    busy = false; submit.disabled = false; submit.textContent = "Try again";
    status.textContent = "The pending response is unconfirmed. Try again with the same response.";
    status.focus(); return;
  }
  const result = await request({ op: "backend.invoke", operation: definition.operation, idempotencyKey: attempt.key, input: attempt.input });
  busy = false; submit.disabled = false;
  if (result.saved) {
    received = true; form.hidden = true; intro.hidden = true; another.hidden = false;
    status.textContent = "Response received."; status.focus();
  } else if (result.definitive && !attempt.uncertain) {
    busy = true; submit.disabled = true;
    if (await clearAttempt()) { attempt = undefined; fields.disabled = false; submit.textContent = "Submit"; status.textContent = "Response not saved. " + result.message; }
    else { attempt.uncertain = true; submit.textContent = "Try again"; status.textContent = "Your response may have been saved. Try again to confirm the same response."; }
    busy = false; submit.disabled = false; status.focus();
  } else {
    attempt.uncertain = true; submit.textContent = "Try again";
    status.textContent = "Your response may have been saved. Try again to confirm the same response.";
    status.focus();
  }
});
another.addEventListener("click", async () => {
  if (busy) return;
  busy = true; another.disabled = true;
  if (!await clearAttempt()) { busy = false; another.disabled = false; status.textContent = "The pending response is still stored. Try again to clear it."; status.focus(); return; }
  form.reset(); fields.disabled = false; form.hidden = false; intro.hidden = false; another.hidden = true; received = false; attempt = undefined;
  status.textContent = ""; submit.textContent = "Submit"; another.disabled = false; busy = false; (controls[0]?.control || submit).focus();
  void loadRelations();
});
`;
