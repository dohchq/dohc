import type { EmailMessage } from "./smtp";

// The HTML layout every email dohc sends to people shares: a white card on
// warm paper, the "dohc" wordmark above it, and a small footer. Email clients
// need table layout and inline styles; the classes exist only so the dark-mode
// query can override inline colors. No images: nothing loads from a server
// when someone opens the email.
//
// Every string a caller passes is escaped here. Markup comes only from this
// module's own builders, so a sharer's name or an item name cannot add HTML.

const MARKUP = Symbol("markup");
export interface Markup {
  readonly [MARKUP]: string;
}
export type Inline = string | Markup;

const markup = (html: string): Markup => ({ [MARKUP]: html });

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const html = (parts: Inline | readonly Inline[]): string =>
  (Array.isArray(parts) ? parts : [parts])
    .map((part: Inline) => (typeof part === "string" ? escapeHtml(part) : part[MARKUP]))
    .join("");

// Only web links become buttons or links.
export function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";
const INK = "#151515";
const MUTED = "#5f5c56"; // 6.2:1 on paper
const SUBTLE = "#6f6b63"; // only on white: 5.3:1
const ACCENT = "#2d342e";
const PAPER = "#f7f6f1";
const LINE = "#e4e1d8";
const TINT = "#e3e9e4";

const DARK = `@media (prefers-color-scheme:dark){
  .bg{background:#100f0e!important}
  .card{background:#191c1a!important;border-color:#2c302d!important}
  .ink,.ink a{color:#f4f1ea!important}
  .muted,.muted a{color:#b3aea3!important}
  .rule{border-color:#2c302d!important}
  .well{background:#111312!important;border-color:#2c302d!important}
  .avatar{background:#26302a!important;color:#d7e3da!important}
  .btn-td{background:#f4f1ea!important}
  .btn-a{color:#151515!important}
}`;

/** Bold text, as the app's own labels appear. */
export const strong = (text: string): Markup =>
  markup(`<b class="ink" style="color:${INK};font-weight:600;">${escapeHtml(text)}</b>`);

/** An address or host as plain text. It breaks only when it cannot fit a phone's width. */
export const literal = (text: string): Markup =>
  markup(`<span style="word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(text)}</span>`);

export const mailto = (address: string, color = MUTED): Markup =>
  markup(
    `<a class="muted" href="mailto:${escapeHtml(address)}" style="color:${color};text-decoration:none;">${escapeHtml(address)}</a>`,
  );

const p = (cls: string, style: string, content: Inline | readonly Inline[]) =>
  `<p class="${cls}" style="margin:0;font-family:${FONT};${style}">${html(content)}</p>`;

const spacer = (px: number) =>
  `<div style="height:${px}px;line-height:${px}px;font-size:1px;">&nbsp;</div>`;

export const heading = (text: string, first = false): Markup =>
  markup(
    `<h1 class="h1 ink" style="margin:${first ? 0 : 22}px 0 ${first ? 8 : 18}px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${INK};letter-spacing:-0.3px;">${escapeHtml(text)}</h1>`,
  );

export const body = (content: Inline | readonly Inline[]): Markup =>
  markup(
    p("muted", `font-size:15px;line-height:24px;color:${MUTED};padding-bottom:24px;`, content),
  );

export const note = (
  content: Inline | readonly Inline[],
  gap: "above" | "below" = "above",
): Markup =>
  markup(
    p(
      "muted",
      `font-size:13px;line-height:20px;color:${SUBTLE};${gap === "above" ? "padding-top:24px;" : ""}`,
      content,
    ),
  );

export const subheading = (text: string): Markup =>
  markup(
    p(
      "ink",
      `font-size:14px;line-height:22px;font-weight:600;color:${INK};padding-bottom:6px;`,
      text,
    ),
  );

export const steps = (content: Inline | readonly Inline[]): Markup =>
  markup(
    p("muted", `font-size:14px;line-height:22px;color:${MUTED};padding-bottom:12px;`, content),
  );

export function button(url: string, label: string): Markup {
  const href = webUrl(url);
  if (!href) throw new Error("An email button needs a web link.");
  return markup(`
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="btn-td" align="center" bgcolor="${ACCENT}" style="border-radius:8px;background:${ACCENT};border:1px solid #3e4740;mso-padding-alt:13px 24px;">
    <a class="btn-a" href="${escapeHtml(href)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`);
}

export const gap = (px: number): Markup => markup(spacer(px));

export const rule = (): Markup =>
  markup(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td style="padding:28px 0 0;font-size:1px;line-height:1px;">&nbsp;</td></tr><tr>
  <td class="rule" style="border-top:1px solid ${LINE};padding:24px 0 0;font-size:1px;line-height:1px;">&nbsp;</td>
</tr></table>`);

// Up to two letters from the name, or the address when there is no name.
function initials(name: string | null, address: string): string {
  const first = (word: string) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? "";
  const words = (name ?? "").split(/\s+/u).filter((word) => first(word));
  const letters =
    words.length > 0
      ? first(words[0]!) + (words.length > 1 ? first(words[words.length - 1]!) : "")
      : first(address);
  return letters.toLocaleUpperCase() || "?";
}

/** The person an email comes from: initials, their name, and their address. */
export function sender(name: string | null, address: string): Markup {
  const lines = name
    ? `<div class="ink" style="font-size:15px;line-height:20px;font-weight:600;color:${INK};word-break:break-word;">${escapeHtml(name)}</div>
          <div class="muted" style="font-size:13px;line-height:18px;color:${SUBTLE};">${html(mailto(address, SUBTLE))}</div>`
    : `<div class="ink" style="font-size:15px;line-height:20px;font-weight:600;color:${INK};">${html(mailto(address, INK))}</div>`;
  return markup(`
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
  <td style="padding-right:12px;vertical-align:middle;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="avatar" width="40" height="40" align="center" valign="middle" bgcolor="${TINT}" style="width:40px;height:40px;border-radius:20px;background:${TINT};font-family:${FONT};font-size:14px;font-weight:700;color:${ACCENT};">${escapeHtml(initials(name, address))}</td>
    </tr></table>
  </td>
  <td style="vertical-align:middle;font-family:${FONT};">${lines}</td>
</tr></table>`);
}

/** The shared item: its name and, when known, what the reader can do with it. */
export const item = (name: string, detail: string | null): Markup =>
  markup(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="well" bgcolor="${PAPER}" style="background:${PAPER};border-radius:10px;">
  <tr><td style="padding:12px 14px;font-family:${FONT};">
    <div class="ink" style="font-size:15px;line-height:20px;font-weight:600;color:${INK};word-break:break-word;">${escapeHtml(name)}</div>
    ${detail ? `<div class="muted" style="font-size:13px;line-height:18px;color:${MUTED};padding-top:2px;">${escapeHtml(detail)}</div>` : ""}
  </td></tr>
</table>`);

export const code = (text: string): Markup =>
  markup(`
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td class="well ink" align="left" style="text-align:left;background:${PAPER};border:1px solid ${LINE};border-radius:6px;padding:10px 12px;font-family:${MONO};font-size:12px;line-height:18px;color:${INK};word-break:break-all;">${escapeHtml(text)}</td>
</tr></table>`);

/** The footer line that repeats a button's link for clients where the button fails. */
export function linkFallback(url: string): Markup {
  const href = webUrl(url);
  if (!href) throw new Error("An email link needs a web link.");
  return markup(
    `If the button does not work, copy this link into your browser:<br><a class="muted" href="${escapeHtml(href)}" style="color:inherit;text-decoration:underline;word-break:break-all;">${escapeHtml(href)}</a>`,
  );
}

export const paragraphBreak = (): Markup =>
  markup(`<span style="display:block;height:12px;"></span>`);

export function emailHtml(input: {
  title: string;
  preheader: string;
  card: readonly Markup[];
  footer: readonly Inline[];
}): string {
  // Spacing characters after the preheader stop clients from filling the
  // inbox preview with the start of the body.
  const padding = "&#8199;&#847;".repeat(40);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
<!--[if mso]><style>table,td,p,div,a,b{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font:inherit!important}
  u + .body a{color:inherit;text-decoration:none}
  @media (max-width:600px){
    .px{padding-left:24px!important;padding-right:24px!important}
    .outer{padding-left:8px!important;padding-right:8px!important}
    .h1{font-size:22px!important;line-height:30px!important}
  }
  ${DARK}
</style>
</head>
<body class="bg body" style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}${padding}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" bgcolor="${PAPER}" style="background:${PAPER};">
<tr><td class="outer" align="center" style="padding:32px 12px 40px;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
  <tr><td class="ink" style="padding:0 8px 18px;font-family:${FONT};font-size:19px;line-height:28px;font-weight:800;color:${INK};letter-spacing:-0.2px;">dohc</td></tr>
  <tr><td class="card px" bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;padding:36px 40px;">${html(input.card)}</td></tr>
  <tr><td class="muted" style="padding:22px 8px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${MUTED};">${html(input.footer)}<span style="display:block;padding-top:12px;">dohc &middot; <a class="muted" href="https://dohc.computer" style="color:${MUTED};text-decoration:underline;">dohc.computer</a></span></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

/** An account email: one action behind a link that expires, as text and HTML. */
export function accountEmail(input: {
  to: string;
  subject: string;
  heading: string;
  body: string;
  action: string;
  url: string;
  note: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: input.subject,
    text: [input.body, "", input.url, "", input.note, ""].join("\n"),
    html: emailHtml({
      title: input.subject,
      preheader: input.body,
      card: [
        heading(input.heading, true),
        body(input.body),
        button(input.url, input.action),
        note(input.note),
      ],
      footer: [linkFallback(input.url)],
    }),
  };
}
