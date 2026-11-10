// The QR code a computer shows under Connect a phone. Its text is the origin of the server the computer's account
// signs in to, such as https://dohc.example.com, and nothing else. It holds no code, token or account ID, so a photo of
// it grants nothing: the phone still signs in to that server on its own.

/** The code's text for the server origin the computer is signed in to. Anything past the origin is left out. */
export function phoneConnectCode(serverOrigin: string): string {
  return new URL(serverOrigin).origin;
}

/**
 * The server address in a scanned code's text, for the phone to check as it checks a typed address. A computer's
 * code always starts with its scheme, so text without `http://` or `https://`, such as a sign-in code, is null.
 */
export function phoneConnectAddress(text: string): string | null {
  const address = text.trim();
  return /^https?:\/\//i.test(address) ? address : null;
}
