import {
  RELAY_API_VERSION,
  RELAY_API_VERSION_HEADER,
  checkApiVersion,
} from "@dohc/workspace-contracts/relay-values";
import { RelayError, relayError } from "./errors";

// The relay API versions this relay serves. The newest is the one this build
// speaks. Raise the oldest only when the relay stops serving an older
// contract. A self-hosted relay serves the same range as the release it runs,
// so its operator updates it the same way dohc updates dohc Drive.
export const RELAY_API_VERSIONS = Object.freeze({ min: 1, max: RELAY_API_VERSION });

// A request names the relay API version it speaks. A request without the
// header is read as version 1. This check only refuses: it runs before
// authentication, reads nothing else, and never grants anything.
export function relayApiVersionRefusal(
  headers: Headers,
  versions: { min: number; max: number } = RELAY_API_VERSIONS,
): RelayError | null {
  const check = checkApiVersion(headers.get(RELAY_API_VERSION_HEADER), versions);
  if (check === "malformed") {
    return new RelayError("bad_request", `${RELAY_API_VERSION_HEADER} must be a positive integer`);
  }
  if (check === "too_old") return relayError("api_version_too_old");
  if (check === "too_new") return relayError("api_version_too_new");
  return null;
}
