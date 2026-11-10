// The server address a person types, as the origin the phone signs in to. A server takes HTTPS. Plain HTTP is only
// for the development server on this computer, and only in a development build: localhost and 127.0.0.1 from the iOS
// Simulator, 10.0.2.2 from the Android emulator.
const DEVELOPMENT_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);
const MAX_ADDRESS_LENGTH = 2048;

export type AddressCheck =
  | { readonly origin: string }
  | { readonly problem: "empty" | "insecure" | "invalid" };

export function checkServerAddress(value: string, options: { readonly developmentServer: boolean }): AddressCheck {
  const typed = value.trim();
  if (!typed) return { problem: "empty" };
  if (typed.length > MAX_ADDRESS_LENGTH) return { problem: "invalid" };
  // A bare name, such as dohc.example.com, means HTTPS.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol === "http:" && !(options.developmentServer && DEVELOPMENT_HOSTS.has(url.hostname))) return { problem: "insecure" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "invalid" };
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") return { problem: "invalid" };
  return { origin: url.origin };
}

/** The server as a person reads it: its host, with the port when it has one. */
export function serverName(origin: string): string {
  return new URL(origin).host;
}
