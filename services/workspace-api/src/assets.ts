import { createHash } from "node:crypto";
import { ACCOUNT_FONT_BASE64 } from "./accountFont";

function hashed(
  name: string,
  extension: string,
  content: string | Uint8Array<ArrayBuffer>,
): string {
  const digest = createHash("sha256").update(content).digest("base64url").slice(0, 12);
  return `/account/assets/${name}.${digest}.${extension}`;
}

export const ACCOUNT_FONT = new Uint8Array(Buffer.from(ACCOUNT_FONT_BASE64, "base64"));
export const ACCOUNT_FONT_PATH = hashed("inter-latin", "woff2", ACCOUNT_FONT);

export const ACCOUNT_CSS = `@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url("${ACCOUNT_FONT_PATH}") format("woff2-variations");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}

:root {
  color-scheme: light dark;
  --bg: #faf9f5;
  --panel: #f3f1ea;
  --panel-2: #ebe8e0;
  --line: #e4e1d8;
  --ink: #1c1b18;
  --muted: #55524a;
  --subtle: #7f7b6e;
  --accent: #2d342e;
  --danger: #a43e2a;
  --success: #38684e;
  --sans: "Inter Variable", system-ui, "Segoe UI", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131211;
    --panel: #1b1d1a;
    --panel-2: #181715;
    --line: #2a2925;
    --ink: #f6f4ee;
    --muted: #a9a599;
    --subtle: #7d7a6e;
    --accent: #d7d0c0;
    --danger: #e08065;
    --success: #82c29b;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

main {
  width: 100%;
  max-width: 26rem;
  padding: 1.75rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1.25rem;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.brand-mark {
  display: block;
  flex: none;
  color: var(--ink);
}

 .server { overflow-wrap: anywhere; font-size: 12px; }

h1 {
  margin: 0 0 0.5rem;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
}

p { margin: 0 0 1rem; color: var(--muted); }

.field { margin-bottom: 0.875rem; }

label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 12px;
  color: var(--muted);
}

input {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 13px;
}

input:focus { border-color: var(--ink); }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

button {
  width: 100%;
  padding: 0.5625rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--accent);
  color: var(--bg);
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 100ms ease-out;
}

button:hover { opacity: 0.9; }
button:disabled { opacity: 0.5; cursor: default; }

button.secondary {
  border-color: var(--line);
  background: transparent;
  color: var(--muted);
}

button.secondary:hover { background: var(--panel-2); color: var(--ink); }

.password-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.password-wrap input {
  padding-right: 3.5rem;
}

.password-toggle {
  position: absolute;
  right: 0.25rem;
  width: auto;
  padding: 0.25rem 0.5rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}

.password-toggle:hover {
  background: var(--panel-2);
  color: var(--ink);
  opacity: 1;
}

.actions { display: flex; gap: 0.5rem; }

#verified a,
#after a,
.button-link {
  display: inline-flex;
  width: 100%;
  justify-content: center;
  align-items: center;
  padding: 0.5625rem 0.75rem;
  border-radius: 8px;
  background: var(--accent);
  color: var(--bg);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: opacity 100ms ease-out;
}

#verified a:hover,
#after a:hover,
.button-link:hover {
  color: var(--bg);
  opacity: 0.9;
}

.status {
  margin-top: 0.875rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted);
}

.status:empty { display: none; }

.status.error {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  color: var(--danger);
}

.status.done {
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
  color: var(--success);
}

.code {
  display: block;
  margin-bottom: 1rem;
  padding: 1rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-align: center;
  word-break: break-all;
}

.device-done .code {
  opacity: 0.6;
}

.device-done .status.done {
  padding: 0.75rem 0.875rem;
  background: color-mix(in srgb, var(--success) 8%, transparent);
  font-size: 13px;
  font-weight: 500;
}

.meta {
  color: var(--ink);
  word-break: break-all;
}

.server-address {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  padding: 0.375rem 0.375rem 0.375rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}

.server-address span {
  flex: 1;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 13px;
  word-break: break-all;
  user-select: all;
}

.server-address button { width: auto; padding: 0.3125rem 0.625rem; }

/* The phone app also opens dohc: links, and phones sign in by scanning. */
.open-dohc { display: none !important; }
@media (hover: hover) and (pointer: fine) {
  .open-dohc { display: inline-flex !important; margin-bottom: 1.25rem; }
}

dl { margin: 0 0 1rem; }
dt { font-size: 12px; color: var(--subtle); }
dd { margin: 0 0 0.75rem; word-break: break-all; }

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.25rem;
  font-size: 12px;
}

a { color: var(--muted); text-underline-offset: 2px; }
a:hover { color: var(--ink); }

[hidden] { display: none !important; }

@media (max-width: 30rem) {
  main { padding: 1.25rem; border: none; background: var(--bg); }
  input { font-size: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.001ms !important; }
}
`;

export const ACCOUNT_JS = `const page = document.body.dataset.page || "";
const closed = document.body.dataset.signUp === "closed";
const byId = (id) => document.getElementById(id);
if (byId("server-host")) byId("server-host").textContent = location.host;

for (const input of document.querySelectorAll('input[type="password"]')) {
  const wrap = document.createElement("div");
  wrap.className = "password-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "password-toggle";
  toggle.textContent = "Show";
  toggle.setAttribute("aria-label", "Show password");
  toggle.addEventListener("click", () => {
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    toggle.textContent = showing ? "Hide" : "Show";
    toggle.setAttribute("aria-label", showing ? "Hide password" : "Show password");
  });
  wrap.appendChild(toggle);
}

function setStatus(kind, text) {
  const status = byId("status");
  if (!status) return;
  status.className = "status " + kind;
  status.textContent = text;
}

function errorText(status, data) {
  const message = data && typeof data.message === "string" ? data.message.trim() : "";
  const code = data && typeof data.code === "string" ? data.code : "";
  // Only a closed server refuses an unverified sign-in.
  if (code === "EMAIL_NOT_VERIFIED") return "Choose a password from an emailed link before you sign in. Use Forgot your password? to get a link.";
  if (message && (status < 500 || code)) return message;
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  return "The server could not complete this request. Try again.";
}

async function call(path, payload, method, extraHeaders) {
  const verb = method || "POST";
  let response;
  try {
    response = await fetch(path, {
      method: verb,
      credentials: "same-origin",
      signal: AbortSignal.timeout(60000),
      redirect: "error",
      headers: { ...(verb === "POST" ? { "content-type": "application/json" } : { accept: "application/json" }), ...(extraHeaders || {}) },
      body: verb === "POST" ? JSON.stringify(payload || {}) : undefined,
    });
  } catch {
    throw new Error("dohc could not reach the server. Check your connection and try again.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(errorText(response.status, data));
  return data || {};
}

function onSubmit(form, working, run) {
  const button = form.querySelector("button[type=submit]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    setStatus("working", working);
    try {
      await run();
    } catch (error) {
      setStatus("error", error.message);
      button.disabled = false;
    }
  });
}

function samePath(value) {
  return typeof value === "string" && /^\\/(?![/\\\\])/.test(value) ? value : null;
}

if (page === "sign-in") {
  const form = byId("form");
  onSubmit(form, "Signing in\\u2026", async () => {
    await call("/api/auth/sign-in/email", {
      email: byId("email").value.trim(),
      password: byId("password").value,
      rememberMe: true,
    });
    location.assign(samePath(document.body.dataset.next) || "/account");
  });
}

// A closed server replaces the sign-up password and name when the person opens
// the emailed link, so its form has neither field. Better Auth still requires a
// password; this value is never shown or kept.
function unusedPassword() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The /join page keeps a workspace invite link's token in this tab while the
// person creates an account. A closed server admits them only with it.
function joinInviteHeader() {
  const next = samePath(document.body.dataset.next);
  if (!next || !/^\\/join(?:[?#]|$)/.test(next)) return {};
  let token = null;
  try {
    token = sessionStorage.getItem("dohc.join.token");
  } catch {
    token = null;
  }
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? { "x-dohc-invite-link": token } : {};
}

if (page === "sign-up") {
  const form = byId("form");
  onSubmit(form, "Creating your account\\u2026", async () => {
    await call("/api/auth/sign-up/email", {
      name: byId("name") ? byId("name").value.trim() : "",
      email: byId("email").value.trim(),
      password: byId("password") ? byId("password").value : unusedPassword(),
      callbackURL: samePath(document.body.dataset.next) || "/account",
    }, "POST", joinInviteHeader());
    location.assign("/account/verify-email?next=" + encodeURIComponent(samePath(document.body.dataset.next) || "/account") + "&sent=1");
  });
}

if (page === "verify-email") {
  const token = document.body.dataset.token;
  const form = byId("form");
  if (token) {
    form.hidden = true;
    setStatus("working", "Verifying your email\\u2026");
    call("/api/auth/verify-email?token=" + encodeURIComponent(token), null, "GET").then(
      () => {
        setStatus("done", "Your email is verified.");
        byId("verified").hidden = false;
      },
      (error) => {
        setStatus("error", error.message + " Send a new link.");
        form.hidden = false;
      },
    );
  }
  onSubmit(form, "Sending a new link\\u2026", async () => {
    const email = byId("email").value.trim();
    await call("/api/auth/send-verification-email", { email, callbackURL: samePath(document.body.dataset.next) || "/account" });
    form.hidden = true;
    setStatus("done", "Check " + email + (closed ? " for a link to choose your password." : " for a verification link.") + " If it does not arrive, contact the server owner.");
  });
}

if (page === "forgot-password") {
  const form = byId("form");
  onSubmit(form, "Sending the reset link\\u2026", async () => {
    const email = byId("email").value.trim();
    await call("/api/auth/request-password-reset", { email });
    form.hidden = true;
    setStatus("done", "Check " + email + " for a reset link. If it does not arrive, contact the server owner.");
  });
}

if (page === "reset-password") {
  const form = byId("form");
  onSubmit(form, "Saving your password\\u2026", async () => {
    const password = byId("password").value;
    if (password !== byId("confirm").value) throw new Error("The two passwords do not match.");
    const name = byId("name");
    await call("/api/auth/reset-password", { newPassword: password, token: document.body.dataset.token, ...(name ? { name: name.value.trim() } : {}) });
    form.hidden = true;
    setStatus("done", "Your password is saved.");
    byId("after").hidden = false;
  });
}

if (page === "device") {
  const userCode = document.body.dataset.userCode;
  const approve = byId("approve");
  const deny = byId("deny");
  const decide = async (path, working, done, heading) => {
    approve.disabled = true;
    deny.disabled = true;
    setStatus("working", working);
    try {
      await call(path, { userCode });
      byId("actions").hidden = true;
      const main = document.querySelector("main");
      if (main) main.classList.add("device-done");
      const h1 = document.querySelector("h1");
      if (h1 && heading) h1.textContent = heading;
      setStatus("done", done);
    } catch (error) {
      setStatus("error", error.message);
      approve.disabled = false;
      deny.disabled = false;
    }
  };
  approve.addEventListener("click", () =>
    decide(
      "/api/auth/device/approve",
      "Connecting\\u2026",
      document.body.dataset.deviceKind === "phone"
        ? "Your phone is connected. Return to dohc on your phone."
        : "Your computer is connected. Return to dohc.",
      document.body.dataset.deviceKind === "phone" ? "Phone connected" : "Computer connected",
    ),
  );
  deny.addEventListener("click", () =>
    decide(
      "/api/auth/device/deny",
      "Refusing the code\\u2026",
      "dohc did not connect this device. You can close this page.",
      "Device not connected",
    ),
  );
}

if (page === "device-prompt") {
  const copy = byId("copy-server");
  const address = byId("server-address");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(address.textContent);
      setStatus("done", "Copied the server address.");
    } catch {
      // No clipboard outside a secure page: select it for the person to copy.
      getSelection().selectAllChildren(address);
      setStatus("working", "Selected the address. Copy it with your keyboard.");
    }
  });
}

if (page === "device-phone") {
  byId("sign-out-sign-in").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      await call("/api/auth/sign-out", {});
      location.assign(document.body.dataset.next);
    } catch (error) {
      setStatus("error", error.message);
      event.target.disabled = false;
    }
  });
}

if (page === "account") {
  byId("sign-out").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      await call("/api/auth/sign-out", {});
      location.assign("/account/sign-in");
    } catch (error) {
      setStatus("error", error.message);
      event.target.disabled = false;
    }
  });
  const resend = byId("resend");
  if (resend) {
    resend.addEventListener("click", async (event) => {
      event.target.disabled = true;
      setStatus("working", "Sending the link\\u2026");
      try {
        await call("/api/auth/send-verification-email", { email: document.body.dataset.email });
        setStatus("done", closed ? "dohc sent a link to your email. Open it to choose a new password." : "dohc sent a verification link to your email.");
      } catch (error) {
        setStatus("error", error.message);
        event.target.disabled = false;
      }
    });
  }
}
`;

export const ACCOUNT_CSS_PATH = hashed("account", "css", ACCOUNT_CSS);
export const ACCOUNT_JS_PATH = hashed("account", "js", ACCOUNT_JS);
