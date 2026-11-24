const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (agent: string, rules: readonly (readonly [RegExp, string])[]) =>
  rules.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

/** A browser's user agent as a short name, such as "Edge on Windows", or null when it names neither. */
export function deviceName(userAgent: string): string | null {
  const browser = first(userAgent, BROWSERS);
  const system = first(userAgent, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}
