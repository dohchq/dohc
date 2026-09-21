import "./frontend.css";
import { downloadBlob, readRecoveryFile, recoveryText } from "./recovery.ts";
import {
  BackendError, backendStatus, createFundraiserClient, createRegistrationAttempt, decodeBase64, defaultAppContext, mutationKey,
  RECEIPT_MAX_BYTES, RECEIPT_TYPES, receiptUploadFromFile, submitRegistration,
  type AppContext, type BackendStatus, type FundraiserClient, type RegistrationAttempt, type RegistrationDraft,
} from "./client.ts";
import type {
  AttendeeRow, FileReply, ManualEntryInput, OnlinePaymentMethod, PaymentMethod, PaymentTotal, PublicSession, RegisterInput, RegisterResult,
  RegistrationRow, RegistrationStatus, RegistrationSummary, Role, RosterInput, SessionId, SetStatusInput, StatusResult,
} from "./ui-types.ts";

// ---------- shared vocabulary ----------
export const EXAMPLE_NOTICE = "Example event — use test details and a sample receipt. Do not send money.";
const SESSION_IDS: readonly SessionId[] = ["s1", "s2"];
const DEFAULT_SESSION_NAME: Record<SessionId, string> = { s1: "Session 1", s2: "Session 2" };
const STATUS_LABEL: Record<RegistrationStatus, string> = {
  pending_verification: "Pending verification", verified: "Verified", rejected: "Rejected", pay_at_venue: "Pay at venue",
};
const STATUS_NOTE: Record<RegistrationStatus, string> = {
  pending_verification: "The organizer has not verified this payment yet.",
  verified: "Payment verified. See you on the court.",
  rejected: "The organizer could not verify this payment. Contact the organizer.",
  pay_at_venue: "Slots reserved. Pay at the venue before the session.",
};
const STATUS_DONE: Record<RegistrationStatus, string> = {
  pending_verification: "Moved back to pending verification.", verified: "Payment verified.",
  rejected: "Registration rejected. Its player slots are released.", pay_at_venue: "Slots reserved. Payment is due at the venue.",
};
const METHOD_LABEL: Record<PaymentMethod, string> = { gcash: "GCash", bdo: "BDO", unionbank: "UnionBank", bpi: "BPI", cash: "Cash" };
const ONLINE_METHODS: readonly OnlinePaymentMethod[] = ["gcash", "bdo", "unionbank", "bpi"];
const ALL_METHODS: readonly PaymentMethod[] = [...ONLINE_METHODS, "cash"];
const SOURCE_LABEL = { website: "Website", reclub: "ReClub", manual: "Manual" } as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GENERIC_MESSAGE: Record<BackendStatus, string> = {
  400: "The backend refused these details. Check each field, then try again.",
  404: "The backend could not find this. Ask the organizer for a current link.",
  409: "The backend refused this change because the data changed first. Reload, then try again.",
  413: "This request is too large for the backend.",
  429: "Too many requests. Wait a moment, then try again.",
  503: "dohc could not reach the backend. Check your connection, then try again.",
};
const php = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
const money = (value: number) => php.format(value);
const formatMs = (ms: number) => Number.isFinite(ms) ? dateFormat.format(new Date(ms)) : "Unknown time";
const formatStart = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : dateFormat.format(date); };
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const nameKey = (value: string) => value.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase();

export function normalizeMobile(value: string): string | null {
  if (value.length > 24 || !/^[\d+()\s-]+$/.test(value)) return null;
  let digits = value.replace(/[()\s-]/g, "");
  if (/^09\d{9}$/.test(digits)) digits = "+63" + digits.slice(1);
  return /^\+639\d{9}$/.test(digits) ? digits : null;
}
export function fullName(value: string): string | null {
  if (value.length > 150 || /[\r\n]/.test(value)) return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  const words = cleaned.split(" ");
  return words.length >= 2 && words.every(word => /\p{L}/u.test(word)) ? cleaned : null;
}
export function receiptProblem(file: File): string | null {
  if (!RECEIPT_TYPES.includes(file.type)) return "Choose a JPG, PNG or PDF receipt.";
  if (file.size === 0) return "This receipt file is empty. Choose another file.";
  if (file.size > RECEIPT_MAX_BYTES) return "This receipt is larger than 5 MB. Choose a smaller file.";
  return null;
}
function describe(error: unknown, overrides: Partial<Record<BackendStatus, string>> = {}): string {
  if (error instanceof BackendError && error.status === 409 && error.refusal) return error.refusal.message;
  const status = backendStatus(error);
  return status === null ? "The app hit an unexpected error. Reload the page, then try again." : overrides[status] ?? GENERIC_MESSAGE[status];
}
const uncertain = (error: unknown) => error instanceof BackendError && error.uncertain;

// ---------- DOM helpers ----------
type Child = Node | string | null | undefined | false;
type Handler = (event: Event) => void;
type Attrs = Record<string, string | number | boolean | Handler | undefined>;
let counter = 0;
const uid = (prefix: string) => `${prefix}-${++counter}`;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(key, value);
    else if (key === "class") node.className = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  node.append(...children.filter((child): child is Node | string => !!child));
  return node;
}
const button = (label: string, attrs: Attrs = {}) => el("button", { type: "button", ...attrs }, label);
function field(label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLElement {
  input.id ||= uid("field");
  const help = hint ? el("p", { class: "hint", id: `${input.id}-hint` }, hint) : null;
  if (help) input.setAttribute("aria-describedby", help.id);
  return el("div", { class: "field" }, el("label", { for: input.id }, label), input, help);
}
function select<T extends string>(options: ReadonlyArray<readonly [T, string]>, value: T): HTMLSelectElement & { value: T } {
  const node = el("select", {}, ...options.map(([key, label]) => el("option", { value: key }, label)));
  node.value = value;
  return node as HTMLSelectElement & { value: T };
}
function radios<T extends string>(name: string, options: ReadonlyArray<readonly [T, string]>, value: T | null, onChange: (value: T) => void): { element: HTMLElement; inputs: HTMLInputElement[]; value(): T | null } {
  const inputs = options.map(([key, label]) => {
    const input = el("input", { type: "radio", name, value: key, change: () => onChange(key) });
    input.checked = key === value;
    return input;
  });
  return {
    element: el("div", { class: "choices" }, ...inputs.map((input, index) => el("label", { class: "check" }, input, options[index]![1]))),
    inputs, value: () => (inputs.find(input => input.checked)?.value as T | undefined) ?? null,
  };
}
const pill = (status: RegistrationStatus) => el("span", { class: `pill pill-${status}` }, STATUS_LABEL[status]);
const notice = (text: string, kind: "error" | "info" | "success", ...actions: Child[]) =>
  el("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, el("p", {}, text), actions.some(Boolean) ? el("div", { class: "actions" }, ...actions) : null);
/** Replaces children while keeping focus on the control with the same focus key. */
function rerender(container: HTMLElement, ...children: Child[]): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined;
  container.replaceChildren(...children.filter((child): child is Node | string => !!child));
  if (key) [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find(node => node.dataset.focusKey === key)?.focus();
}
function copyControl(text: string, source: HTMLElement): HTMLElement {
  const status = el("span", { class: "hint", "aria-live": "polite" });
  const copy = button("Copy", { class: "secondary small", click: () => {
    const selectText = () => {
      const range = document.createRange(); range.selectNodeContents(source);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      status.textContent = "Copy is unavailable here. The text is selected. Press Ctrl+C or Cmd+C.";
    };
    if (!navigator.clipboard?.writeText) { selectText(); return; }
    navigator.clipboard.writeText(text).then(() => { status.textContent = "Copied"; }, selectText);
  } });
  return el("span", { class: "copy" }, copy, status);
}
const sessionCounts = (summary: RegistrationSummary, name: (id: SessionId) => string) =>
  summary.sessions.map(item => `${name(item.sessionId)}: ${plural(item.players, "player")}, ${plural(item.spectators, "spectator")}`).join(" · ");
const ORGANIZER_MESSAGES: Partial<Record<BackendStatus, string>> = {
  404: "Organizer access is unavailable. Open the app as the workspace owner or an organizer helper in dohc.",
};

interface View { element: HTMLElement; show(): void }
interface StatusView extends View { setToken(token: string): void }

// ---------- registration ----------
function createRosterGroup(role: Role, max: number, onChange: () => void) {
  const title = role === "player" ? "Players" : "Spectators";
  const list = el("div", { class: "names" });
  const count = el("span", { class: "count", "aria-live": "polite" });
  const price = el("span", { class: "hint" });
  const addButton = button(`Add ${role}`, { class: "secondary small", click: () => addRow(true) });
  const element = el("div", { class: "roster-group" }, el("div", { class: "roster-head" }, el("strong", {}, title), price, count), list, addButton);
  const inputs = () => [...list.querySelectorAll("input")];
  const renumber = () => {
    const rows = [...list.children];
    rows.forEach((row, index) => {
      row.querySelector("input")?.setAttribute("aria-label", `${title.slice(0, -1)} ${index + 1} name`);
      row.querySelector("button")?.setAttribute("aria-label", `Remove ${role} ${index + 1}`);
    });
    count.textContent = plural(rows.length, role);
    addButton.disabled = rows.length >= max;
  };
  function addRow(focus: boolean, value = ""): void {
    if (list.children.length >= max) return;
    const input = el("input", { type: "text", maxlength: "150", autocomplete: "off", placeholder: "First and last name" });
    input.value = value;
    const row = el("div", { class: "name-row" }, input, button("Remove", { class: "link", click: () => {
      const next = row.nextElementSibling?.querySelector("input") ?? row.previousElementSibling?.querySelector("input") ?? addButton;
      row.remove(); renumber(); onChange(); next.focus();
    } }));
    list.append(row); renumber(); onChange();
    if (focus) input.focus();
  }
  renumber();
  return { element, addRow, inputs, names: () => inputs().map(input => input.value), clear: () => { list.replaceChildren(); renumber(); }, setPrice: (text: string) => { price.textContent = text; } };
}

function createSessionBlock(id: SessionId, onChange: () => void) {
  const checkbox = el("input", { type: "checkbox", value: id });
  const title = el("span", { class: "session-name" }, DEFAULT_SESSION_NAME[id]);
  const meta = el("p", { class: "hint" }, "Capacity loads with the event details.");
  const players = createRosterGroup("player", 36, onChange), spectators = createRosterGroup("spectator", 100, onChange);
  const roster = el("div", { class: "roster", hidden: true }, players.element, spectators.element);
  checkbox.addEventListener("change", () => {
    roster.hidden = !checkbox.checked;
    if (checkbox.checked && !players.names().length && !spectators.names().length) players.addRow(false);
    onChange();
  });
  return {
    id, checkbox, players, spectators,
    element: el("div", { class: "session-block" }, el("label", { class: "check session-check" }, checkbox, title), meta, roster),
    update(session: PublicSession) {
      title.textContent = session.name;
      meta.textContent = `${formatStart(session.startsAt)} · ${session.available} of ${session.capacity} player slots open`;
      players.setPrice(`${money(session.playerPrice)} each`); spectators.setPrice(`${money(session.spectatorPrice)} each`);
    },
    reset() { checkbox.checked = false; roster.hidden = true; players.clear(); spectators.clear(); },
    restore(input: RosterInput) {
      checkbox.checked = true; roster.hidden = false; players.clear(); spectators.clear();
      for (const name of input.players) players.addRow(false, name);
      for (const name of input.spectators) spectators.addRow(false, name);
    },
  };
}

function createRegisterView(client: FundraiserClient, context: AppContext, hooks: { remember(token: string): void; openStatus(): void }): View {
  let sessions: PublicSession[] | null = null, loadSeq = 0, busy = false;
  let attempt: RegistrationAttempt | null = null;
  const sessionName = (id: SessionId) => sessions?.find(item => item.id === id)?.name ?? DEFAULT_SESSION_NAME[id];
  const heading = el("h2", { tabindex: "-1" }, "Register");
  const messages = el("div", { class: "messages" });
  const nameInput = el("input", { type: "text", autocomplete: "name", maxlength: "150", placeholder: "First and last name" });
  const mobileInput = el("input", { type: "tel", inputmode: "tel", autocomplete: "tel", maxlength: "24", placeholder: "0917 123 4567" });
  const sessionsMessage = el("div", { class: "messages" });
  const refreshButton = button("Refresh capacity", { class: "secondary small", click: () => void loadSessions() });
  const blocks = SESSION_IDS.map(id => createSessionBlock(id, updateTotal));
  const breakdown = el("tbody");
  const totalCell = el("strong", { "aria-live": "polite" });
  const receiptBlock = el("div", { class: "receipt-block", hidden: true });
  const fileInput = el("input", { type: "file", accept: RECEIPT_TYPES.join(",") });
  const fileStatus = el("p", { class: "hint", "aria-live": "polite" });
  const methods = radios("payment", ONLINE_METHODS.map(method => [method, METHOD_LABEL[method]] as const), null, () => { receiptBlock.hidden = false; });
  const submitButton = el("button", { type: "submit", class: "primary" }, "Send registration");
  const fieldset = el("fieldset", {},
    el("section", { class: "group" }, el("h3", {}, "Contact"),
      field("Your first and last name", nameInput), field("Mobile number", mobileInput, "Philippine mobile, for example 0917 123 4567.")),
    el("section", { class: "group" }, el("div", { class: "group-head" }, el("h3", {}, "Sessions"), refreshButton),
      el("p", { class: "hint" }, "Choose one or both sessions. Add the name of every player and spectator."), sessionsMessage, ...blocks.map(block => block.element)),
    el("section", { class: "group" }, el("h3", {}, "Estimated total"),
      el("table", { class: "totals" }, el("caption", { class: "sr-only" }, "Fee breakdown"), breakdown, el("tfoot", {}, el("tr", {}, el("th", { scope: "row" }, "Total"), el("td", { class: "num" }, totalCell)))),
      el("p", { class: "hint" }, "Estimate from the current prices. The backend confirms the final amount.")),
    el("section", { class: "group" }, el("h3", {}, "Payment"), el("p", { class: "banner-inline" }, EXAMPLE_NOTICE),
      el("div", { class: "field" }, el("span", { class: "label", id: "payment-label" }, "Payment method"), methods.element),
      receiptBlock),
  );
  methods.element.setAttribute("role", "radiogroup"); methods.element.setAttribute("aria-labelledby", "payment-label");
  receiptBlock.append(field("Receipt", fileInput, "JPG, PNG or PDF, up to 5 MB. Any sample image works for this example."), fileStatus,
    el("p", { class: "hint" }, "Your registration stays pending until the organizer verifies the receipt."));
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileStatus.textContent = file ? receiptProblem(file) ?? `Selected ${file.name}` : "";
  });
  const form = el("form", { novalidate: true, submit: (event: Event) => { event.preventDefault(); void send(); } },
    fieldset, messages, el("p", {class: "hint"}, "Sending downloads a private recovery file with names and your receipt. Keep it until registration is confirmed."),
    el("div", { class: "actions" }, submitButton));
  const confirmation = el("section", { class: "confirmation", hidden: true });
  const recoveryInput = el("input", {type: "file", accept: "application/json,.json"});
  const recoveryMessage = el("p", {class: "hint", "aria-live": "polite"});
  const recovery = el("details", {class: "group"}, el("summary", {}, "Resume an unfinished registration"),
    el("p", {class: "hint"}, "Open your saved recovery file. It contains your group's personal details and private retry secret. Keep it private."),
    field("Recovery file", recoveryInput), recoveryMessage);
  recoveryInput.addEventListener("change", () => {
    const file = recoveryInput.files?.[0]; if (!file || busy || attempt) return;
    void readRecoveryFile(file).then(retained => {
      if (busy || attempt) return;
      restoreDraft(retained); context.pendingAttemptChanged?.(retained);
      recoveryMessage.textContent = "Recovered the original request. Choose Retry same registration to check or finish it.";
    }).catch(error => { recoveryMessage.textContent = error instanceof Error ? error.message : "The recovery file could not be read."; });
  });
  const element = el("section", { class: "view", hidden: true }, heading,
    el("p", {}, "Register players and spectators for the synthetic pickleball fundraiser. Sessions have 36 player slots each."), form, confirmation, recovery);

  async function loadSessions(): Promise<void> {
    const seq = ++loadSeq;
    refreshButton.disabled = true; sessionsMessage.replaceChildren();
    try {
      const list = await client.listPublicSessions();
      if (seq !== loadSeq) return;
      sessions = list;
      for (const block of blocks) { const session = list.find(item => item.id === block.id); if (session) block.update(session); }
      updateTotal();
    } catch (error) {
      if (seq === loadSeq) sessionsMessage.replaceChildren(notice(describe(error, { 404: "The event details are unavailable. Ask the organizer for a current link." }), "error"));
    } finally { if (seq === loadSeq) refreshButton.disabled = false; }
  }
  function updateTotal(): void {
    breakdown.replaceChildren();
    if (!sessions) { totalCell.textContent = "Loads with capacity"; return; }
    let total = 0;
    for (const block of blocks) {
      const session = sessions.find(item => item.id === block.id);
      if (!block.checkbox.checked || !session) continue;
      const players = block.players.names().length, spectators = block.spectators.names().length;
      breakdown.append(
        el("tr", {}, el("td", {}, `${session.name} players (${players} × ${money(session.playerPrice)})`), el("td", { class: "num" }, money(players * session.playerPrice))),
        el("tr", {}, el("td", {}, `${session.name} spectators (${spectators} × ${money(session.spectatorPrice)})`), el("td", { class: "num" }, money(spectators * session.spectatorPrice))),
      );
      total += players * session.playerPrice + spectators * session.spectatorPrice;
    }
    totalCell.textContent = money(total);
  }
  type Checked = { input: RegistrationDraft; file: File } | { problem: string; focus: HTMLElement };
  function validate(): Checked {
    const name = fullName(nameInput.value);
    if (!name) return { problem: "Enter your first and last name.", focus: nameInput };
    const mobile = normalizeMobile(mobileInput.value);
    if (!mobile) return { problem: "Enter a Philippine mobile number, such as 0917 123 4567.", focus: mobileInput };
    const rosters: RosterInput[] = [];
    for (const block of blocks) {
      if (!block.checkbox.checked) continue;
      const seen = new Set<string>();
      const roster: RosterInput = { sessionId: block.id, players: [], spectators: [] };
      for (const [role, group] of [["players", block.players], ["spectators", block.spectators]] as const) {
        for (const input of group.inputs()) {
          const person = fullName(input.value);
          if (!person) return { problem: `Enter a first and last name for each ${role.slice(0, -1)} in ${sessionName(block.id)}.`, focus: input };
          if (seen.has(nameKey(person))) return { problem: `${person} is listed twice in ${sessionName(block.id)}.`, focus: input };
          seen.add(nameKey(person)); roster[role].push(person);
        }
      }
      if (!roster.players.length && !roster.spectators.length) return { problem: `Add a player or spectator to ${sessionName(block.id)}, or clear its checkbox.`, focus: block.checkbox };
      rosters.push(roster);
    }
    if (!rosters.length) return { problem: "Choose at least one session.", focus: blocks[0]!.checkbox };
    const paymentMethod = methods.value();
    if (!paymentMethod) return { problem: "Choose a payment method.", focus: methods.inputs[0]! };
    const file = fileInput.files?.[0];
    if (!file) return { problem: "Upload a sample receipt.", focus: fileInput };
    const problem = receiptProblem(file);
    if (problem) return { problem, focus: fileInput };
    return { input: { fullName: name, mobile, sessions: rosters, paymentMethod }, file };
  }
  function setBusy(next: boolean, label = "Send registration"): void {
    busy = next;
    fieldset.disabled = busy || attempt !== null;
    submitButton.disabled = busy || attempt !== null;
    submitButton.textContent = label;
    form.setAttribute("aria-busy", String(busy));
    recoveryInput.disabled = busy || attempt !== null;
  }
  async function send(): Promise<void> {
    if (busy) return;
    let current = attempt;
    if (!current) {
      const checked = validate();
      if ("problem" in checked) { messages.replaceChildren(notice(checked.problem, "error")); checked.focus.focus(); return; }
      messages.replaceChildren();
      setBusy(true, "Preparing receipt…");
      try { current = await createRegistrationAttempt(checked.input, await receiptUploadFromFile(checked.file)); }
      catch { setBusy(false); messages.replaceChildren(notice("The receipt file could not be read. Choose it again.", "error")); return; }
      attempt = current;
      try { saveAttempt(current); }
      catch {
        setBusy(false);
        context.pendingAttemptChanged?.(current);
        showPending("The recovery download could not start. Copy the recovery data into a JSON file before retrying.");
        return;
      }
    }
    setBusy(true, "Sending…");
    try {
      const reply = await submitRegistration(client, current);
      attempt = null;
      context.pendingAttemptChanged?.(null);
      setBusy(false);
      showConfirmation(reply.result, reply.replayed);
    } catch (error) {
      if (uncertain(error)) { setBusy(false); context.pendingAttemptChanged?.(current); showPending(describe(error)); }
      else {
        attempt = null; setBusy(false);
        context.pendingAttemptChanged?.(null);
        messages.replaceChildren(notice(describe(error, {
          400: "The backend refused these details. Check the names, mobile number and receipt, then send again.",
          409: "The backend could not accept this registration: a session may be full or a name may be repeated. Refresh capacity, then send again.",
          413: "The receipt is too large for the backend. Choose a smaller file.",
        }), "error"));
      }
    }
  }
  function showPending(text: string): void {
    const retry = button("Retry same registration", { class: "primary", click: () => void send() });
    messages.replaceChildren(notice(`${text} Your details are kept. Retry sends the same registration and cannot create a duplicate.`, "error",
      retry, button("Save recovery file", {class: "secondary", click: () => {
        if (attempt) { try { saveAttempt(attempt); } catch { showPending("The recovery download could not start. Copy the recovery data below into a JSON file."); } }
      }}), button("Discard pending registration", { class: "secondary", click: confirmDiscard })),
      el("p", {class: "hint"}, "Before closing this page, save a recovery file. It includes names, the receipt and a private retry secret."), recoveryFallback());
    retry.focus();
  }
  function saveAttempt(current: RegistrationAttempt): void {
    downloadBlob(new Blob([recoveryText(current)], {type: "application/json"}), "fundraiser-recovery.json");
  }
  function recoveryFallback(): HTMLElement {
    const text = el("textarea", {readonly: true, rows: "4", class: "mono", "aria-label": "Private recovery data"});
    const details = el("details", {}, el("summary", {}, "Copy recovery data if the download is missing"),
      el("p", {class: "hint"}, "Copy this entire text into a file named fundraiser-recovery.json. Keep the file private."), text,
      button("Select recovery data", {class: "secondary", click: () => { text.focus(); text.select(); }}));
    details.addEventListener("toggle", () => { if (details.open && attempt && !text.value) text.value = recoveryText(attempt); });
    return details;
  }
  function confirmDiscard(): void {
    const keep = button("Keep pending registration", { class: "secondary", click: () => showPending("The registration outcome is still unknown.") });
    messages.replaceChildren(notice("Discard this pending registration? It may already be saved. Check with the organizer before registering the same group again.", "info",
      button("Discard", { class: "danger", click: () => {
        attempt = null; context.pendingAttemptChanged?.(null);
        setBusy(false); messages.replaceChildren(); submitButton.focus();
      } }), keep));
    keep.focus();
  }
  /** Rebuilds the draft from a retained attempt and keeps it frozen until Retry settles it. */
  function restoreDraft(retained: RegistrationAttempt): void {
    nameInput.value = retained.input.fullName; mobileInput.value = retained.input.mobile;
    for (const block of blocks) {
      const roster = retained.input.sessions.find(item => item.sessionId === block.id);
      if (roster) block.restore(roster); else block.reset();
    }
    for (const input of methods.inputs) input.checked = input.value === retained.input.paymentMethod;
    receiptBlock.hidden = false; fileStatus.textContent = `Receipt kept from the earlier attempt: ${retained.receipt.name}`;
    attempt = retained; updateTotal(); setBusy(false);
    showPending("This registration was sent before, and its outcome is still unknown.");
  }
  if (context.pendingAttempt) restoreDraft(context.pendingAttempt);
  function showConfirmation(result: RegisterResult, replayed: boolean): void {
    const tokenOutput = el("output", { class: "mono token" }, result.statusToken);
    const title = el("h3", { tabindex: "-1" }, "Registration received");
    rerender(confirmation, title,
      el("p", {}, STATUS_NOTE[result.status]),
      replayed ? notice("This registration was already saved. Nothing was sent twice.", "info") : null,
      el("dl", { class: "facts" },
        el("div", {}, el("dt", {}, "Reference"), el("dd", { class: "mono" }, result.id)),
        el("div", {}, el("dt", {}, "Status"), el("dd", {}, pill(result.status))),
        el("div", {}, el("dt", {}, "Total"), el("dd", {}, money(result.total))),
        el("div", {}, el("dt", {}, "Sessions"), el("dd", {}, sessionCounts(result, sessionName)))),
      el("section", { class: "group token-group" }, el("h4", {}, "Private status token"),
        el("p", {}, "Keep this token. It is the only way to check this registration, and this page does not save it."),
        el("div", { class: "token-row" }, tokenOutput, copyControl(result.statusToken, tokenOutput)),
        button("Save status token", {class: "secondary", click: () => downloadBlob(new Blob([result.statusToken + "\n"], {type: "text/plain"}), "fundraiser-status.txt")})),
      el("div", { class: "actions" },
        button("Check status", { class: "primary", click: hooks.openStatus }),
        button("Register another group", { class: "secondary", click: reset })));
    form.hidden = true; confirmation.hidden = false; recovery.hidden = true;
    hooks.remember(result.statusToken);
    context.rememberStatusToken?.(result.statusToken);
    title.focus();
  }
  function reset(): void {
    for (const block of blocks) block.reset();
    for (const input of methods.inputs) input.checked = false;
    receiptBlock.hidden = true; fileInput.value = ""; fileStatus.textContent = "";
    messages.replaceChildren(); updateTotal();
    confirmation.hidden = true; form.hidden = false; recovery.hidden = false; heading.focus();
  }
  return { element, show() { element.hidden = false; heading.focus(); if (!sessions) void loadSessions(); } };
}

// ---------- private status ----------
function createStatusView(client: FundraiserClient, context: AppContext): StatusView {
  let seq = 0;
  const heading = el("h2", { tabindex: "-1" }, "My registration");
  const tokenInput = el("input", { type: "text", class: "mono", autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "Paste your private status token" });
  tokenInput.value = context.initialStatusToken ?? "";
  const checkButton = el("button", { type: "submit", class: "primary" }, "Check status");
  const messages = el("div", { class: "messages" });
  const result = el("div", { class: "status-result", "aria-live": "polite" });
  const form = el("form", { novalidate: true, submit: (event: Event) => { event.preventDefault(); void check(); } },
    field("Private status token", tokenInput, "The 43-character token from your confirmation. Anyone with it can see this registration."),
    el("div", { class: "actions" }, checkButton));
  const element = el("section", { class: "view", hidden: true }, heading, form, messages, result);
  async function check(): Promise<void> {
    const token = tokenInput.value.trim();
    if (!TOKEN_PATTERN.test(token)) { messages.replaceChildren(notice("Enter the 43-character token from your confirmation.", "error")); tokenInput.focus(); return; }
    const current = ++seq;
    checkButton.disabled = true; form.setAttribute("aria-busy", "true"); messages.replaceChildren(); result.replaceChildren();
    try {
      const status = await client.lookupStatus(token);
      if (current === seq) render(status);
    } catch (error) {
      if (current === seq) messages.replaceChildren(notice(describe(error, { 404: "No registration matches this token. Check the token, then try again." }), "error"));
    } finally { if (current === seq) { checkButton.disabled = false; form.setAttribute("aria-busy", "false"); } }
  }
  function render(status: StatusResult): void {
    const people = (sessionId: SessionId, role: Role) => status.attendees.filter(person => person.sessionId === sessionId && person.role === role);
    result.replaceChildren(el("article", { class: "card" },
      el("div", { class: "card-head" }, el("strong", {}, `Submitted ${formatMs(status.createdAtMs)}`), pill(status.status)),
      el("p", {}, STATUS_NOTE[status.status]),
      el("dl", { class: "facts" },
        el("div", {}, el("dt", {}, "Reference"), el("dd", { class: "mono" }, status.id)),
        el("div", {}, el("dt", {}, "Total"), el("dd", {}, money(status.total)))),
      ...status.sessions.map(item => el("section", { class: "session-summary" },
        el("h3", {}, `${DEFAULT_SESSION_NAME[item.sessionId]}: ${plural(item.players, "player")}, ${plural(item.spectators, "spectator")}`),
        ...(["player", "spectator"] as const).map(role => {
          const names = people(item.sessionId, role);
          return names.length ? el("p", {}, el("strong", {}, role === "player" ? "Players: " : "Spectators: "), names.map(person => person.name).join(", ")) : null;
        })))));
  }
  return { element, show() { element.hidden = false; heading.focus(); }, setToken(token) { tokenInput.value = token; messages.replaceChildren(); result.replaceChildren(); } };
}

// ---------- organizer ----------
type Filter = RegistrationStatus | "all";
const FILTERS: ReadonlyArray<readonly [Filter, string]> = [
  ["pending_verification", "Pending verification"], ["verified", "Verified"], ["pay_at_venue", "Pay at venue"], ["rejected", "Rejected"], ["all", "All"],
];

function createOrganizerView(client: FundraiserClient): View {
  let state: "idle" | "checking" | "unavailable" | "ready" = "idle", generation = 0;
  const heading = el("h2", { tabindex: "-1" }, "Organizer");
  const body = el("div");
  const element = el("section", { class: "view", hidden: true }, heading, body);
  async function check(): Promise<void> {
    const current = ++generation;
    state = "checking";
    body.replaceChildren(el("p", { class: "hint", role: "status" }, "Checking organizer access…"));
    try {
      const totals = await client.totals();
      if (current !== generation) return;
      state = "ready"; renderDashboard(totals);
    } catch (error) {
      if (current !== generation) return;
      state = "unavailable";
      const status = backendStatus(error);
      const text = status === 429 || status === 503 ? describe(error)
        : "Organizer access is unavailable for this link. Open the app as the workspace owner or an organizer helper in dohc.";
      body.replaceChildren(notice(text, "error", button("Try again", { class: "secondary", click: () => void check() })));
    }
  }

  function renderDashboard(initialTotals: PaymentTotal[]): void {
    let totals = initialTotals, sessions: PublicSession[] | null = null;
    let filter: Filter = "pending_verification", search = "", rows: RegistrationRow[] = [], nextOffset: number | null = null, listSeq = 0;
    let attendeeSession: SessionId | "" = "", attendeeStatus: RegistrationStatus | "" = "", attendees: AttendeeRow[] = [], attendeeNext: number | null = null, attendeeSeq = 0, attendeesLoaded = false;
    const sessionName = (id: SessionId) => sessions?.find(item => item.id === id)?.name ?? DEFAULT_SESSION_NAME[id];

    // totals
    const totalsBody = el("tbody"), totalsFoot = el("tfoot"), totalsMessage = el("div", { class: "messages" });
    function renderTotals(): void {
      const columns = ["verified", "pending", "dueAtVenue", "rejected", "total"] as const;
      const sum = (column: typeof columns[number]) => totals.reduce((acc, row) => acc + row[column], 0);
      totalsBody.replaceChildren(...totals.map(row => el("tr", {}, el("th", { scope: "row" }, METHOD_LABEL[row.paymentMethod] ?? row.paymentMethod),
        ...columns.map(column => el("td", { class: "num" }, money(row[column]))))));
      totalsFoot.replaceChildren(el("tr", {}, el("th", { scope: "row" }, "All methods"), ...columns.map(column => el("td", { class: "num" }, money(sum(column))))));
      if (!totals.length) totalsBody.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "hint" }, "No registrations yet.")));
    }
    async function refreshTotals(): Promise<void> {
      const current = generation;
      try { const next = await client.totals(); if (current === generation) { totals = next; renderTotals(); totalsMessage.replaceChildren(); } }
      catch (error) { if (current === generation) totalsMessage.replaceChildren(notice(`Totals did not refresh. ${describe(error, ORGANIZER_MESSAGES)}`, "error")); }
    }
    renderTotals();

    // registrations
    const listMessage = el("div", { class: "messages" }), listBody = el("tbody"), listFoot = el("div", { class: "list-foot" }), listTable = el("table", { class: "rows", hidden: true });
    const filterSelect = select(FILTERS, filter);
    const searchInput = el("input", { type: "search", maxlength: "150", placeholder: "Name or mobile", "aria-label": "Search registrations" });
    const loadMore = button("Load more", { class: "secondary", click: () => { if (nextOffset !== null) void loadList(nextOffset); } });
    filterSelect.addEventListener("change", () => { filter = filterSelect.value; void loadList(0); });
    const searchForm = el("form", { class: "search", submit: (event: Event) => { event.preventDefault(); search = searchInput.value.trim(); void loadList(0); } },
      searchInput, button("Search", { type: "submit", class: "secondary" }),
      button("Clear", { class: "link", click: () => { searchInput.value = ""; if (search) { search = ""; void loadList(0); } } }));
    listTable.append(el("thead", {}, el("tr", {}, ...["Name", "Mobile", "Sessions", "Source", "Amount", "Paid via", "Submitted", "Status"].map(label => el("th", { scope: "col" }, label)))), listBody);
    async function loadList(offset: number): Promise<void> {
      const seq = ++listSeq, current = generation;
      listMessage.replaceChildren(); loadMore.disabled = true;
      if (offset === 0) { listFoot.replaceChildren(el("span", { class: "hint", role: "status" }, "Loading registrations…")); }
      try {
        const page = await client.listRegistrations({ status: filter, search, offset, limit: 50 });
        if (seq !== listSeq || current !== generation) return;
        rows = offset === 0 ? page.records : [...rows, ...page.records.filter(row => !rows.some(existing => existing.id === row.id))];
        nextOffset = page.nextOffset;
        renderList();
      } catch (error) {
        if (seq !== listSeq || current !== generation) return;
        listMessage.replaceChildren(notice(describe(error, ORGANIZER_MESSAGES), "error", button("Try again", { class: "secondary", click: () => void loadList(offset) })));
        if (offset === 0) { rows = []; nextOffset = null; renderList(); }
      } finally { if (seq === listSeq) loadMore.disabled = false; }
    }
    function renderList(): void {
      rerender(listBody, ...rows.map(row => el("tr", {},
        el("td", { "data-label": "Name" }, button(row.fullName, { class: "link row-open", "data-focus-key": row.id, click: () => openDetail(row) })),
        el("td", { "data-label": "Mobile" }, row.mobile || "Not provided"),
        el("td", { "data-label": "Sessions" }, row.sessions.map(item => `${DEFAULT_SESSION_NAME[item.sessionId]}: ${item.players}P, ${item.spectators}S`).join(" · ")),
        el("td", { "data-label": "Source" }, SOURCE_LABEL[row.source]),
        el("td", { "data-label": "Amount", class: "num" }, money(row.total)),
        el("td", { "data-label": "Paid via" }, row.status === "pay_at_venue" ? "Due at venue" : METHOD_LABEL[row.paymentMethod]),
        el("td", { "data-label": "Submitted" }, formatMs(row.createdAtMs)),
        el("td", { "data-label": "Status" }, pill(row.status)))));
      listTable.hidden = rows.length === 0;
      const empty = search ? `No registrations match "${search}".` : filter === "all" ? "No registrations yet." : `No registrations with status ${STATUS_LABEL[filter].toLowerCase()}. Choose All to see every registration.`;
      rerender(listFoot, rows.length ? el("span", { class: "hint" }, `${rows.length} shown${nextOffset === null ? "" : ", more available"}`) : el("p", { class: "hint" }, empty),
        nextOffset === null ? null : loadMore);
    }
    function replaceRow(updated: RegistrationRow): void {
      const keep = filter === "all" || updated.status === filter;
      rows = keep ? rows.map(row => row.id === updated.id ? updated : row) : rows.filter(row => row.id !== updated.id);
      renderList();
    }

    // detail
    const detail = el("dialog", { class: "detail", "aria-label": "Registration details" });
    let active: RegistrationRow | null = null, detailBusy = false, pendingChange: { key: string; input: SetStatusInput } | null = null;
    let detailNotice: { kind: "error" | "info" | "success"; text: string; retry?: boolean; reload?: boolean } | null = null, confirmReject = false;
    let receiptState: { kind: "idle" } | { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; reply: FileReply } = { kind: "idle" }, receiptSeq = 0;
    detail.addEventListener("cancel", event => { if (detailBusy) event.preventDefault(); });
    detail.addEventListener("close", () => { active = null; receiptSeq++; });
    function openDetail(row: RegistrationRow): void {
      active = row; pendingChange = null; detailNotice = null; confirmReject = false; receiptState = { kind: "idle" }; receiptSeq++;
      renderDetail();
      if (detail.open) return;
      try { detail.showModal(); } catch { detail.setAttribute("open", ""); }
    }
    function closeDetail(): void {
      if (detailBusy) return;
      try { detail.close(); } catch { detail.removeAttribute("open"); active = null; }
    }
    function renderDetail(): void {
      const row = active;
      if (!row) return;
      const title = el("h3", { tabindex: "-1" }, row.fullName);
      const facts = el("dl", { class: "facts" },
        el("div", {}, el("dt", {}, "Amount"), el("dd", {}, money(row.total))),
        el("div", {}, el("dt", {}, row.status === "pay_at_venue" ? "Payment" : "Paid via"), el("dd", {}, row.status === "pay_at_venue" ? "Due at venue, unpaid" : METHOD_LABEL[row.paymentMethod])),
        el("div", {}, el("dt", {}, "Mobile"), el("dd", {}, row.mobile || "Not provided")),
        el("div", {}, el("dt", {}, "Source"), el("dd", {}, SOURCE_LABEL[row.source])),
        el("div", {}, el("dt", {}, "Submitted"), el("dd", {}, formatMs(row.createdAtMs))),
        el("div", {}, el("dt", {}, "Sessions"), el("dd", {}, sessionCounts(row, sessionName))),
        el("div", { class: "wide" }, el("dt", {}, "Reference"), el("dd", { class: "mono" }, row.id)));
      const noticeNode = detailNotice ? notice(detailNotice.text, detailNotice.kind,
        detailNotice.retry ? button("Retry same change", { class: "primary", click: () => void applyChange() }) : null,
        detailNotice.reload ? button("Reload registration", { class: "secondary", click: () => void reloadActive() }) : null) : null;
      rerender(detail,
        el("div", { class: "card-head" }, title, el("div", { class: "head-actions" }, pill(row.status), button("Close", { class: "secondary small", click: closeDetail, "data-focus-key": "close" }))),
        filter !== "all" && row.status !== filter ? el("p", { class: "hint" }, `No longer in the ${STATUS_LABEL[filter].toLowerCase()} list.`) : null,
        facts,
        el("section", { class: "group" }, el("h4", {}, "Receipt"), receiptNode(row)),
        el("section", { class: "group" }, el("h4", {}, "Status"), noticeNode, el("div", { class: "actions" }, ...actionNodes(row))));
      if (!document.activeElement || !detail.contains(document.activeElement)) title.focus();
    }
    function receiptNode(row: RegistrationRow): HTMLElement {
      if (!row.hasReceipt) return el("p", { class: "hint" }, "No receipt. An organizer added this registration.");
      switch (receiptState.kind) {
        case "idle": return el("div", {}, button("Show receipt", { class: "secondary", "data-focus-key": "receipt", click: () => void loadReceipt(row) }));
        case "loading": return el("p", { class: "hint", role: "status" }, "Loading receipt…");
        case "error": return notice(receiptState.text, "error", button("Try again", { class: "secondary", "data-focus-key": "receipt", click: () => void loadReceipt(row) }));
        case "ready": {
          const reply = receiptState.reply, { file } = reply;
          const meta = el("p", { class: "hint" }, `${file.name} · ${Math.max(1, Math.round(file.byteLength / 1024))} KB`);
          if (file.contentType === "image/jpeg" || file.contentType === "image/png") {
            return el("div", {}, el("img", { class: "receipt-image", src: `data:${file.contentType};base64,${reply.bytesBase64}`, alt: `Payment receipt from ${row.fullName}` }), meta);
          }
          const saveStatus = el("p", { class: "hint", "aria-live": "polite" });
          return el("div", {}, el("p", {}, file.contentType === "application/pdf" ? "Download this PDF to view the receipt." : "Download this file to view the receipt."), meta,
            button("Save receipt", { class: "secondary", "data-focus-key": "receipt", click: () => void saveReceipt(reply, saveStatus) }), saveStatus);
        }
      }
    }
    async function loadReceipt(row: RegistrationRow): Promise<void> {
      const seq = ++receiptSeq;
      receiptState = { kind: "loading" }; renderDetail();
      try {
        const reply = await client.receipt(row.id);
        if (seq !== receiptSeq || active?.id !== row.id) return;
        receiptState = { kind: "ready", reply };
      } catch (error) {
        if (seq !== receiptSeq || active?.id !== row.id) return;
        receiptState = { kind: "error", text: describe(error, { 404: "This registration has no receipt on file." }) };
      }
      renderDetail();
    }
    async function saveReceipt(reply: FileReply, status: HTMLElement): Promise<void> {
      const file = new File([decodeBase64(reply.bytesBase64)], reply.file.name, { type: reply.file.contentType });
      try { downloadBlob(file, reply.file.name); status.textContent = "Receipt download started."; }
      catch { status.textContent = "The receipt download could not start. Try again."; }
    }
    function actionNodes(row: RegistrationRow): Child[] {
      const disabled = detailBusy;
      const act = (label: string, status: RegistrationStatus, paymentMethod?: PaymentMethod, cls = "secondary") =>
        button(detailBusy && pendingChange?.input.status === status ? "Saving…" : label, { class: cls, disabled, "data-focus-key": `act-${status}`, click: () => void changeStatus(status, paymentMethod) });
      if (confirmReject) {
        return [el("p", {}, "Reject this registration? Its player slots are released, and its status shows rejected. Restoring it later needs free slots."),
          act("Reject registration", "rejected", undefined, "danger"),
          button("Cancel", { class: "secondary", disabled, click: () => { confirmReject = false; renderDetail(); } })];
      }
      const reject = button("Reject", { class: "danger", disabled, "data-focus-key": "reject", click: () => { confirmReject = true; renderDetail(); } });
      switch (row.status) {
        case "pending_verification": return [act("Verify payment", "verified", undefined, "primary"), reject, act("Pay at venue instead", "pay_at_venue", "cash")];
        case "pay_at_venue": {
          const collected = select(ALL_METHODS.map(method => [method, METHOD_LABEL[method]] as const), "cash");
          collected.disabled = disabled; collected.setAttribute("data-focus-key", "collected");
          return [field("Collected via", collected, `Collect ${money(row.total)} first, then record how it was paid.`),
            act("Mark paid", "verified", undefined, "primary"), reject, row.hasReceipt ? act("Back to pending", "pending_verification") : null];
        }
        case "verified": return [act("Back to pending", "pending_verification"), act("Back to pay at venue", "pay_at_venue", "cash"), reject];
        case "rejected": return [act("Restore to pending", "pending_verification", undefined, "primary"), act("Restore as pay at venue", "pay_at_venue", "cash")];
      }
    }
    async function changeStatus(status: RegistrationStatus, paymentMethod?: PaymentMethod): Promise<void> {
      const row = active;
      if (!row || detailBusy) return;
      const collected = detail.querySelector<HTMLSelectElement>("select[data-focus-key='collected']");
      const method = status === "verified" && row.status === "pay_at_venue" ? (collected?.value as PaymentMethod | undefined) ?? "cash" : paymentMethod;
      pendingChange = { key: mutationKey("status"), input: { id: row.id, status, expectedVersion: row.version, ...(method ? { paymentMethod: method } : {}) } };
      await applyChange();
    }
    async function applyChange(): Promise<void> {
      const change = pendingChange, row = active;
      if (!change || !row || detailBusy || row.id !== change.input.id) return;
      detailBusy = true; detailNotice = null; confirmReject = false; renderDetail();
      try {
        const summary = await client.setStatus(change.input, change.key);
        if (active?.id !== row.id) return;
        pendingChange = null;
        const updated: RegistrationRow = { ...row, ...summary, paymentMethod: change.input.paymentMethod ?? row.paymentMethod };
        active = updated; replaceRow(updated);
        detailNotice = { kind: "success", text: STATUS_DONE[summary.status] };
        void refreshTotals();
      } catch (error) {
        if (active?.id !== row.id) return;
        if (uncertain(error)) detailNotice = { kind: "error", text: `${describe(error)} Retry sends the same change once.`, retry: true };
        else {
          pendingChange = null;
          const status = backendStatus(error);
          detailNotice = status === 409
            ? { kind: "error", text: describe(error, {409: "The registration changed or a session has no free player slots. Reload it, then try again."}), reload: true }
            : { kind: "error", text: describe(error, { ...ORGANIZER_MESSAGES, 400: "The backend refused this change. Choose the payment method used, then try again." }) };
        }
      } finally { detailBusy = false; if (active?.id === row.id) renderDetail(); }
    }
    async function reloadActive(): Promise<void> {
      const row = active;
      if (!row || detailBusy) return;
      detailBusy = true; detailNotice = null; renderDetail();
      try {
        const page = await client.listRegistrations({ status: "all", search: row.fullName, limit: 50 });
        if (active?.id !== row.id) return;
        const fresh = page.records.find(item => item.id === row.id);
        if (!fresh) { detailNotice = { kind: "error", text: "This registration was not found. Refresh the list." }; return; }
        active = fresh; replaceRow(fresh); detailNotice = { kind: "info", text: "Reloaded." };
      } catch (error) {
        if (active?.id === row.id) detailNotice = { kind: "error", text: describe(error, ORGANIZER_MESSAGES), reload: true };
      } finally { detailBusy = false; if (active?.id === row.id) renderDetail(); }
    }

    // attendees
    const attendeeMessage = el("div", { class: "messages" }), attendeeBody = el("tbody"), attendeeFoot = el("div", { class: "list-foot" }), attendeeTable = el("table", { class: "rows", hidden: true });
    const attendeeSessionSelect = select([["", "Both sessions"], ["s1", DEFAULT_SESSION_NAME.s1], ["s2", DEFAULT_SESSION_NAME.s2]] as const, "");
    const attendeeStatusSelect = select([["", "Every status except rejected"], ["pending_verification", STATUS_LABEL.pending_verification], ["verified", STATUS_LABEL.verified], ["pay_at_venue", STATUS_LABEL.pay_at_venue]] as const, "");
    const attendeeMore = button("Load more", { class: "secondary", click: () => { if (attendeeNext !== null) void loadAttendees(attendeeNext); } });
    attendeeSessionSelect.addEventListener("change", () => { attendeeSession = attendeeSessionSelect.value; void loadAttendees(0); });
    attendeeStatusSelect.addEventListener("change", () => { attendeeStatus = attendeeStatusSelect.value; void loadAttendees(0); });
    attendeeTable.append(el("thead", {}, el("tr", {}, ...["Name", "Role", "Session", "Registered by", "Mobile", "Status"].map(label => el("th", { scope: "col" }, label)))), attendeeBody);
    async function loadAttendees(offset: number): Promise<void> {
      const seq = ++attendeeSeq, current = generation;
      attendeesLoaded = true; attendeeMessage.replaceChildren(); attendeeMore.disabled = true;
      if (offset === 0) attendeeFoot.replaceChildren(el("span", { class: "hint", role: "status" }, "Loading attendees…"));
      try {
        const page = await client.attendees({ ...(attendeeSession ? { sessionId: attendeeSession } : {}), ...(attendeeStatus ? { status: attendeeStatus } : {}), offset, limit: 100 });
        if (seq !== attendeeSeq || current !== generation) return;
        attendees = offset === 0 ? page.records : [...attendees, ...page.records.filter(row => !attendees.some(existing => existing.id === row.id))];
        attendeeNext = page.nextOffset;
        renderAttendees();
      } catch (error) {
        if (seq !== attendeeSeq || current !== generation) return;
        attendeeMessage.replaceChildren(notice(describe(error, ORGANIZER_MESSAGES), "error", button("Try again", { class: "secondary", click: () => void loadAttendees(offset) })));
        if (offset === 0) { attendees = []; attendeeNext = null; renderAttendees(); }
      } finally { if (seq === attendeeSeq) attendeeMore.disabled = false; }
    }
    function renderAttendees(): void {
      rerender(attendeeBody, ...attendees.map(person => el("tr", {},
        el("td", { "data-label": "Name" }, person.name),
        el("td", { "data-label": "Role" }, person.role === "player" ? "Player" : "Spectator"),
        el("td", { "data-label": "Session" }, sessionName(person.sessionId)),
        el("td", { "data-label": "Registered by" }, person.contactName),
        el("td", { "data-label": "Mobile" }, person.mobile || "Not provided"),
        el("td", { "data-label": "Status" }, pill(person.status)))));
      attendeeTable.hidden = attendees.length === 0;
      const players = attendees.filter(person => person.role === "player").length;
      rerender(attendeeFoot, attendees.length
        ? el("span", { class: "hint" }, `${plural(players, "player")}, ${plural(attendees.length - players, "spectator")} shown${attendeeNext === null ? "" : ", more available"}`)
        : el("p", { class: "hint" }, "No attendees match these filters."), attendeeNext === null ? null : attendeeMore);
    }

    // manual entry
    let entryAttempt: { key: string; input: ManualEntryInput } | null = null, entryBusy = false;
    const entryName = el("input", { type: "text", autocomplete: "off", maxlength: "150", placeholder: "First and last name" });
    const entryMobile = el("input", { type: "tel", inputmode: "tel", autocomplete: "off", maxlength: "24", placeholder: "0917 123 4567" });
    const entrySession = select([["s1", DEFAULT_SESSION_NAME.s1], ["s2", DEFAULT_SESSION_NAME.s2], ["both", "Both sessions"]] as const, "s1");
    const entryStatus = select([["pay_at_venue", STATUS_LABEL.pay_at_venue], ["pending_verification", STATUS_LABEL.pending_verification], ["verified", STATUS_LABEL.verified]] as const, "pay_at_venue");
    const entryMethod = select(ALL_METHODS.map(method => [method, METHOD_LABEL[method]] as const), "cash");
    const entryMethodField = field("Payment method", entryMethod);
    const entryRole = radios("entry-role", [["player", "Player"], ["spectator", "Spectator"]] as const, "player", updateEntryTotal);
    const entrySource = radios("entry-source", [["reclub", "ReClub"], ["manual", "Manual"]] as const, "reclub", () => {});
    const entryTotal = el("strong", { "aria-live": "polite" });
    const entryMessages = el("div", { class: "messages" });
    const entrySubmit = el("button", { type: "submit", class: "primary" }, "Save entry");
    const entryFieldset = el("fieldset", {},
      field("Full name", entryName), field("Mobile number (optional)", entryMobile),
      el("div", { class: "field" }, el("span", { class: "label", id: "entry-role-label" }, "Role"), entryRole.element),
      el("div", { class: "field" }, el("span", { class: "label", id: "entry-source-label" }, "Source"), entrySource.element),
      field("Session", entrySession), field("Payment status", entryStatus), entryMethodField,
      el("p", { class: "entry-total" }, el("span", {}, "Total "), entryTotal));
    entryRole.element.setAttribute("role", "radiogroup"); entryRole.element.setAttribute("aria-labelledby", "entry-role-label");
    entrySource.element.setAttribute("role", "radiogroup"); entrySource.element.setAttribute("aria-labelledby", "entry-source-label");
    entrySession.addEventListener("change", updateEntryTotal);
    entryStatus.addEventListener("change", () => { entryMethodField.hidden = entryStatus.value === "pay_at_venue"; if (entryMethodField.hidden) entryMethod.value = "cash"; });
    entryMethodField.hidden = true;
    const entryForm = el("form", { novalidate: true, submit: (event: Event) => { event.preventDefault(); void saveEntry(); } },
      el("p", { class: "hint" }, "Add a walk-in or ReClub registration without a receipt. Pay-at-venue entries use cash."),
      entryFieldset, entryMessages, el("div", { class: "actions" }, entrySubmit));
    function updateEntryTotal(): void {
      const session = sessions?.find(item => item.id === (entrySession.value === "both" ? "s1" : entrySession.value));
      if (!session) { entryTotal.textContent = "Loads with event details"; return; }
      const each = entryRole.value() === "spectator" ? session.spectatorPrice : session.playerPrice;
      entryTotal.textContent = money(each * (entrySession.value === "both" ? 2 : 1));
    }
    function setEntryBusy(next: boolean): void {
      entryBusy = next;
      entryFieldset.disabled = entryBusy || entryAttempt !== null;
      entrySubmit.disabled = entryBusy || entryAttempt !== null;
      entrySubmit.textContent = entryBusy ? "Saving…" : "Save entry";
      entryForm.setAttribute("aria-busy", String(entryBusy));
    }
    async function saveEntry(): Promise<void> {
      if (entryBusy) return;
      let current = entryAttempt;
      if (!current) {
        const name = fullName(entryName.value);
        if (!name) { entryMessages.replaceChildren(notice("Enter a first and last name.", "error")); entryName.focus(); return; }
        const mobile = entryMobile.value.trim() ? normalizeMobile(entryMobile.value.trim()) : "";
        if (mobile === null) { entryMessages.replaceChildren(notice("Enter a Philippine mobile number, or leave it empty.", "error")); entryMobile.focus(); return; }
        const role = entryRole.value(), source = entrySource.value(), status = entryStatus.value;
        if (!role || !source) return;
        current = { key: mutationKey("manual"), input: { fullName: name, ...(mobile ? { mobile } : {}), session: entrySession.value, role, source, status, paymentMethod: status === "pay_at_venue" ? "cash" : entryMethod.value } };
        entryAttempt = current;
      }
      setEntryBusy(true); entryMessages.replaceChildren();
      try {
        const reply = await client.manualEntry(current.input, current.key);
        entryAttempt = null; setEntryBusy(false);
        entryName.value = ""; entryMobile.value = "";
        entryMessages.replaceChildren(notice(`${reply.replayed ? "Already saved: " : "Added "}${current.input.fullName} as ${STATUS_LABEL[reply.result.status].toLowerCase()}.`, "success",
          button("View registrations", { class: "secondary", click: () => showTab("registrations") })));
        filter = reply.result.status; filterSelect.value = filter; search = ""; searchInput.value = "";
        void loadList(0); void refreshTotals(); attendeesLoaded = false;
        entryName.focus();
      } catch (error) {
        setEntryBusy(false);
        if (uncertain(error)) {
          const retry = button("Retry same entry", { class: "primary", click: () => void saveEntry() });
          entryMessages.replaceChildren(notice(`${describe(error)} Retry sends the same entry and cannot create a duplicate.`, "error", retry,
            button("Discard pending entry", { class: "secondary", click: () => { entryAttempt = null; setEntryBusy(false); entryMessages.replaceChildren(notice("Pending entry discarded. It may already be saved; check the list before adding it again.", "info")); } })));
          retry.focus();
        } else {
          entryAttempt = null; setEntryBusy(false);
          entryMessages.replaceChildren(notice(describe(error, {
            ...ORGANIZER_MESSAGES,
            400: "The backend refused this entry. Check the name, mobile number and payment method, then save again.",
            409: "The backend refused this entry: a session has no free player slots.",
          }), "error"));
        }
      }
    }

    // tabs and shell
    type Tab = "registrations" | "attendees" | "entry";
    const panels: Record<Tab, HTMLElement> = {
      registrations: el("div", { role: "tabpanel", id: "panel-registrations", "aria-labelledby": "tab-registrations" },
        el("div", { class: "toolbar" }, field("Status", filterSelect), searchForm), listMessage, listTable, listFoot),
      attendees: el("div", { role: "tabpanel", id: "panel-attendees", "aria-labelledby": "tab-attendees", hidden: true },
        el("p", { class: "hint" }, "Rejected registrations are excluded."),
        el("div", { class: "toolbar" }, field("Session", attendeeSessionSelect), field("Status", attendeeStatusSelect)), attendeeMessage, attendeeTable, attendeeFoot),
      entry: el("div", { role: "tabpanel", id: "panel-entry", "aria-labelledby": "tab-entry", hidden: true }, entryForm),
    };
    const tabButtons = (Object.keys(panels) as Tab[]).map(tab => button({ registrations: "Registrations", attendees: "Attendees", entry: "Add entry" }[tab],
      { role: "tab", id: `tab-${tab}`, "aria-controls": `panel-${tab}`, "aria-selected": tab === "registrations" ? "true" : "false", click: () => showTab(tab) }));
    let currentTab: Tab = "registrations";
    function showTab(tab: Tab): void {
      currentTab = tab;
      for (const [key, panel] of Object.entries(panels) as [Tab, HTMLElement][]) panel.hidden = key !== tab;
      for (const node of tabButtons) node.setAttribute("aria-selected", String(node.id === `tab-${tab}`));
      if (tab === "attendees" && !attendeesLoaded) void loadAttendees(0);
      if (tab === "entry" && !sessions) void loadSessionsForEntry();
    }
    async function loadSessionsForEntry(): Promise<void> {
      const current = generation;
      try { const list = await client.listPublicSessions(); if (current === generation) { sessions = list; updateEntryTotal(); } }
      catch { /* The total shows as unavailable until the next attempt; the backend still computes the real amount. */ }
    }
    const refreshAll = button("Refresh", { class: "secondary", click: () => {
      void refreshTotals();
      if (currentTab === "attendees") void loadAttendees(0); else void loadList(0);
    } });
    body.replaceChildren(
      el("section", { class: "group" }, el("div", { class: "group-head" }, el("h3", {}, "Payment totals"), refreshAll), totalsMessage,
        el("div", { class: "scroll", tabindex: "0" }, el("table", { class: "totals-table" }, el("caption", { class: "sr-only" }, "Payment totals by method"),
          el("thead", {}, el("tr", {}, ...["Method", "Verified", "Pending", "Due at venue", "Rejected", "All"].map(label => el("th", { scope: "col" }, label)))), totalsBody, totalsFoot))),
      el("div", { role: "tablist", "aria-label": "Organizer sections", class: "tabs" }, ...tabButtons),
      panels.registrations, panels.attendees, panels.entry, detail);
    updateEntryTotal();
    void loadList(0);
  }
  return { element, show() { element.hidden = false; heading.focus(); if (state === "idle") void check(); } };
}

// ---------- shell ----------
export function mountFundraiser(root: HTMLElement, client: FundraiserClient, context: AppContext = defaultAppContext): void {
  const status = createStatusView(client, context);
  const register = createRegisterView(client, context, { remember: token => status.setToken(token), openStatus: () => open("status") });
  const organizer = createOrganizerView(client);
  const views = { register, status, organizer } as const;
  type Name = keyof typeof views;
  const links = (Object.keys(views) as Name[]).map(name => button({ register: "Register", status: "My registration", organizer: "Organizer" }[name], { class: "nav-link", click: () => open(name) }));
  function open(name: Name): void {
    for (const [key, view] of Object.entries(views) as [Name, View][]) view.element.hidden = key !== name;
    links.forEach((link, index) => { if ((Object.keys(views) as Name[])[index] === name) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
    views[name].show();
  }
  root.replaceChildren(
    el("div", { class: "banner", role: "note" }, EXAMPLE_NOTICE),
    el("header", { class: "app-head" }, el("h1", {}, "Pickleball fundraiser"), el("nav", { "aria-label": "Sections" }, ...links)),
    el("main", {}, register.element, status.element, organizer.element));
  open(context.initialStatusToken ? "status" : "register");
}

const rootElement = document.getElementById("root");
if (rootElement) {
  const client = createFundraiserClient();
  mountFundraiser(rootElement, client, defaultAppContext);
  window.addEventListener("pagehide", () => client.close(), { once: true });
}
