import { ACCOUNT_CSS_PATH, ACCOUNT_JS_PATH } from "./assets";

// The browser half of the account lifecycle: server-rendered HTML with one
// stylesheet and one script, no framework and no build step. Each page carries
// its state in `body[data-*]`; the script reads it and calls same-origin
// /api/auth endpoints. Nothing here talks to a third party.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

interface Shell {
  title: string;
  page: string;
  /** Rendered into `body[data-*]`, read by the page script. */
  data?: Record<string, string | undefined>;
  main: string;
}

function shell({ title, page, data = {}, main }: Shell): string {
  const attributes = Object.entries({ page, ...data })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` data-${key}="${escapeHtml(value as string)}"`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · dohc</title>
<link rel="stylesheet" href="${ACCOUNT_CSS_PATH}">
</head>
<body${attributes}>
<main>
<p class="brand">dohc</p>
<p class="server">This account belongs to <span id="server-host">this server</span>.</p>
${main}
</main>
<script src="${ACCOUNT_JS_PATH}" defer></script>
</body>
</html>
`;
}

const STATUS = '<p class="status" id="status" role="status" aria-live="polite"></p>';

function field(id: string, label: string, attributes: string): string {
  return `<div class="field"><label for="${id}">${escapeHtml(label)}</label><input id="${id}" ${attributes}></div>`;
}

export function signInPage(options: { next?: string } = {}): string {
  const next = options.next;
  const signUpHref = next
    ? `/account/sign-up?next=${encodeURIComponent(next)}`
    : "/account/sign-up";
  return shell({
    title: "Sign in",
    page: "sign-in",
    data: { next },
    main: `<h1>Sign in to dohc</h1>
<form id="form">
${field("email", "Email", 'type="email" name="email" autocomplete="username" required autofocus')}
${field("password", "Password", 'type="password" name="password" autocomplete="current-password" required')}
<button type="submit">Sign in</button>
</form>
${STATUS}
<p class="links"><a href="${escapeHtml(signUpHref)}">Create an account</a><a href="/account/forgot-password">Forgot your password?</a></p>`,
  });
}

export function signUpPage(options: { next?: string } = {}): string {
  return shell({
    title: "Create an account",
    page: "sign-up",
    data: { next: options.next },
    main: `<h1>Create your dohc account</h1>
<form id="form">
${field("name", "Name", 'type="text" name="name" autocomplete="name" required autofocus')}
${field("email", "Email", 'type="email" name="email" autocomplete="username" required')}
${field("password", "Password", 'type="password" name="password" autocomplete="new-password" minlength="8" required')}
<button type="submit">Create account</button>
</form>
${STATUS}
<p class="links"><a href="${escapeHtml(options.next ? `/account/sign-in?next=${encodeURIComponent(options.next)}` : "/account/sign-in")}">Sign in instead</a><a href="${escapeHtml(`/account/verify-email?next=${encodeURIComponent(options.next ?? "/account")}`)}">Send a verification link</a></p>`,
  });
}

export function verifyEmailPage(options: { token?: string; email?: string; next?: string } = {}): string {
  const { token, email, next } = options;
  return shell({
    title: "Verify your email",
    page: "verify-email",
    data: { token, next },
    main: `<h1>Verify your email</h1>
<p>${token ? "dohc is checking your link." : "Open the link dohc sent to your email. It works for one hour."}</p>
<p id="verified" hidden><a href="${escapeHtml(next ?? "/account")}">${next?.startsWith("/device?") ? "Continue connecting your device" : "Go to your account"}</a></p>
<form id="form"${token ? " hidden" : ""}>
${field("email", "Email", `type="email" name="email" autocomplete="username" required value="${escapeHtml(email ?? "")}"`)}
<button type="submit">Send a new link</button>
</form>
${STATUS}
<p class="links"><a href="/account">Your account</a><a href="/account/sign-in">Sign in</a></p>`,
  });
}

export function forgotPasswordPage(): string {
  return shell({
    title: "Reset your password",
    page: "forgot-password",
    main: `<h1>Reset your password</h1>
<p>dohc sends a reset link to the address on your account. The link works for one hour.</p>
<form id="form">
${field("email", "Email", 'type="email" name="email" autocomplete="username" required autofocus')}
<button type="submit">Send the reset link</button>
</form>
${STATUS}
<p class="links"><a href="/account/sign-in">Back to sign in</a></p>`,
  });
}

export function resetPasswordPage(options: { token?: string } = {}): string {
  const token = options.token;
  if (!token) {
    return shell({
      title: "Reset your password",
      page: "reset-password-invalid",
      main: `<h1>This reset link is incomplete</h1>
<p>Open the link straight from the email, or ask dohc for a new one.</p>
<p class="links"><a href="/account/forgot-password">Send a new reset link</a><a href="/account/sign-in">Back to sign in</a></p>`,
    });
  }
  return shell({
    title: "Choose a new password",
    page: "reset-password",
    data: { token },
    main: `<h1>Choose a new password</h1>
<form id="form">
${field("password", "New password", 'type="password" name="password" autocomplete="new-password" minlength="8" required autofocus')}
${field("confirm", "Confirm new password", 'type="password" name="confirm" autocomplete="new-password" minlength="8" required')}
<button type="submit">Save password</button>
</form>
<p id="after" hidden><a href="/account/sign-in">Sign in with your new password</a></p>
${STATUS}`,
  });
}

export type DeviceState =
  | { kind: "prompt"; userCode?: string; notFound?: boolean }
  | { kind: "review"; userCode: string; email: string }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "handled"; status: string };

export function devicePage(state: DeviceState): string {
  if (state.kind === "review") {
    return shell({
      title: "Connect your device",
      page: "device",
      data: { "user-code": state.userCode },
      main: `<h1>Connect this device to dohc?</h1>
<p class="code">${escapeHtml(state.userCode)}</p>
<p>Connect the device showing this code as <span class="meta">${escapeHtml(state.email)}</span>. It will read and change your workspaces.</p>
<div class="actions" id="actions">
<button type="button" id="approve">Approve</button>
<button type="button" id="deny" class="secondary">Deny</button>
</div>
${STATUS}`,
    });
  }
  if (state.kind === "prompt") {
    return shell({
      title: "Connect your device",
      page: "device-prompt",
      main: `<h1>Enter the code from your device</h1>
${state.notFound ? "<p>dohc does not know that code. Check it on your device and enter it again.</p>" : "<p>dohc shows this code on the device you are signing in.</p>"}
<form method="get" action="/device">
${field("user_code", "Device code", `type="text" name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus value="${escapeHtml(state.userCode ?? "")}"`)}
<button type="submit">Continue</button>
</form>`,
    });
  }
  if (state.kind === "expired") {
    return shell({
      title: "Connect your device",
      page: "device-expired",
      main: `<h1>This code has expired</h1>
<p>Device codes last ten minutes. Start the sign-in again on your device to get a new one.</p>
<p class="links"><a href="/device">Enter another code</a></p>`,
    });
  }
  if (state.kind === "invalid") {
    return shell({
      title: "Connect your device",
      page: "device-invalid",
      main: `<h1>dohc does not know that code</h1>
<p>Check the code on your device, or start the sign-in again to get a new one.</p>
<p class="links"><a href="/device">Enter another code</a></p>`,
    });
  }
  const connected = state.status === "approved";
  return shell({
    title: "Connect your device",
    page: "device-handled",
    main: `<h1>${connected ? "This code is already used" : "dohc did not connect this device"}</h1>
<p>${connected ? "The device holding this code is connected. Return to dohc on that device." : "Someone refused this code. Start the sign-in again on your device to get a new one."}</p>
<p class="links"><a href="/device">Enter another code</a></p>`,
  });
}

export function accountPage(user: { name: string; email: string; emailVerified: boolean }): string {
  return shell({
    title: "Your account",
    page: "account",
    data: { email: user.email },
    main: `<h1>Your dohc account</h1>
<dl>
<dt>Name</dt><dd>${escapeHtml(user.name)}</dd>
<dt>Email</dt><dd>${escapeHtml(user.email)}${user.emailVerified ? "" : " (not verified)"}</dd>
</dl>
${
  user.emailVerified
    ? ""
    : `<p>Until you verify this address, other people cannot share work with you at it.</p>
<button type="button" id="resend" class="secondary">Send a verification link</button>`
}
${STATUS}
<p class="links"><a href="/account/forgot-password">Change your password</a><a href="/device">Connect a device</a></p>
<button type="button" id="sign-out" class="secondary">Sign out</button>`,
  });
}

export function notFoundPage(): string {
  return shell({
    title: "Page not found",
    page: "not-found",
    main: `<h1>dohc has no page here</h1>
<p class="links"><a href="/account/sign-in">Sign in</a><a href="/account">Your account</a></p>`,
  });
}
