import { createHash } from "node:crypto";

// The account pages ship as two static files and no build step: the stylesheet
// and one script that dispatches on `body[data-page]`. Both are served under a
// content hash so a browser can cache them forever and still pick up a change.

export const ACCOUNT_CSS = `:root {
  color-scheme: light dark;
  --bg: #faf9f5;
  --panel: #f3f1ea;
  --panel-2: #ebe8e0;
  --line: #e4e1d8;
  --ink: #1c1b18;
  --muted: #55524a;
  --subtle: #7f7b6e;
  --accent: #2d342e;
  --danger: #a6402c;
  --success: #38684e;
  --sans: "InterVariable", system-ui, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace;
  --serif: "Iowan Old Style", Charter, Georgia, "Times New Roman", serif;
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
  margin: 0 0 1.25rem;
  font-family: var(--serif);
  font-size: 15px;
  color: var(--subtle);
}

 .server { overflow-wrap: anywhere; font-size: 12px; }

h1 {
  margin: 0 0 0.5rem;
  font-size: 18px;
  font-weight: 600;
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

.actions { display: flex; gap: 0.5rem; }

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
  display: inline-block;
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: var(--panel-2);
  font-family: var(--mono);
  font-size: 20px;
  letter-spacing: 0.18em;
  word-break: break-all;
}

.meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  word-break: break-all;
}

dl { margin: 0 0 1rem; }
dt { font-size: 12px; color: var(--subtle); }
dd { margin: 0 0 0.75rem; font-family: var(--mono); word-break: break-all; }

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
}

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.001ms !important; }
}
`;

export const ACCOUNT_JS = `const page = document.body.dataset.page || "";
const byId = (id) => document.getElementById(id);
if (byId("server-host")) byId("server-host").textContent = location.host;

function setStatus(kind, text) {
  const status = byId("status");
  if (!status) return;
  status.className = "status " + kind;
  status.textContent = text;
}

function errorText(status, data) {
  const message = data && typeof data.message === "string" ? data.message.trim() : "";
  const code = data && typeof data.code === "string" ? data.code : "";
  if (message && (status < 500 || code)) return message;
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  return "The server could not complete this request. Try again.";
}

async function call(path, payload, method) {
  const verb = method || "POST";
  let response;
  try {
    response = await fetch(path, {
      method: verb,
      credentials: "same-origin",
      signal: AbortSignal.timeout(60000),
      redirect: "error",
      headers: verb === "POST" ? { "content-type": "application/json" } : { accept: "application/json" },
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

if (page === "sign-up") {
  const form = byId("form");
  onSubmit(form, "Creating your account\\u2026", async () => {
    await call("/api/auth/sign-up/email", {
      name: byId("name").value.trim(),
      email: byId("email").value.trim(),
      password: byId("password").value,
      callbackURL: samePath(document.body.dataset.next) || "/account",
    });
    location.assign("/account/verify-email?next=" + encodeURIComponent(samePath(document.body.dataset.next) || "/account"));
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
    setStatus("done", "If this address needs verification, dohc sent a new link to " + email + ".");
  });
}

if (page === "forgot-password") {
  const form = byId("form");
  onSubmit(form, "Sending the reset link\\u2026", async () => {
    const email = byId("email").value.trim();
    await call("/api/auth/request-password-reset", { email });
    form.hidden = true;
    setStatus("done", "If that account exists, dohc sent a reset link to " + email + ".");
  });
}

if (page === "reset-password") {
  const form = byId("form");
  onSubmit(form, "Saving your password\\u2026", async () => {
    const password = byId("password").value;
    if (password !== byId("confirm").value) throw new Error("The two passwords do not match.");
    await call("/api/auth/reset-password", { newPassword: password, token: document.body.dataset.token });
    form.hidden = true;
    setStatus("done", "Your password is saved.");
    byId("after").hidden = false;
  });
}

if (page === "device") {
  const userCode = document.body.dataset.userCode;
  const approve = byId("approve");
  const deny = byId("deny");
  const decide = async (path, working, done) => {
    approve.disabled = true;
    deny.disabled = true;
    setStatus("working", working);
    try {
      await call(path, { userCode });
      byId("actions").hidden = true;
      setStatus("done", done);
    } catch (error) {
      setStatus("error", error.message);
      approve.disabled = false;
      deny.disabled = false;
    }
  };
  approve.addEventListener("click", () =>
    decide("/api/auth/device/approve", "Connecting\\u2026", "Your desktop is connected. Return to dohc."),
  );
  deny.addEventListener("click", () =>
    decide("/api/auth/device/deny", "Refusing the code\\u2026", "dohc did not connect this device. You can close this page."),
  );
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
        setStatus("done", "dohc sent a verification link to your email.");
      } catch (error) {
        setStatus("error", error.message);
        event.target.disabled = false;
      }
    });
  }
}
`;

function hashed(name: string, extension: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("base64url").slice(0, 12);
  return `/account/assets/${name}.${digest}.${extension}`;
}

export const ACCOUNT_CSS_PATH = hashed("account", "css", ACCOUNT_CSS);
export const ACCOUNT_JS_PATH = hashed("account", "js", ACCOUNT_JS);
