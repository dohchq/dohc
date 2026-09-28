export const SHARE_WEB_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SHARE_WEB_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": SHARE_WEB_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "private, no-store",
});
