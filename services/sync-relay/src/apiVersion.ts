import { RELAY_API_VERSION_HEADER, checkApiVersion } from "@dohc/workspace-contracts/relay-values";
import { carriesAutomationReplicaBearer } from "./automationReplicaCredential";
import { RelayError, relayError } from "./errors";
import { parseRoute, type SyncRelayRoute } from "./relayRoute";

// The relay API versions this relay serves. The newest may run ahead of the
// version this build's clients send, because the relay deploys first. Raise the
// oldest only when the relay stops serving an older contract. A self-hosted
// relay serves the same range as the release it runs, so its operator updates
// it the same way dohc updates dohc Drive.
export const RELAY_API_VERSIONS = Object.freeze({ min: 1, max: 2 });

export const ENGINE_API_MIN_SETTING = "DOHC_RELAY_ENGINE_API_MIN";

const ENGINE_ROUTES: ReadonlySet<SyncRelayRoute["route"]> = new Set([
  "workspaces",
  "log",
  "log-coordinate",
  "epoch",
  "keys",
  "blob",
  "blob-have",
  "share-log",
  "share-blob",
  "share-proposals",
  "share-collection-writes",
  "live-notes",
]);

export function engineApiMinimum(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const value = env[ENGINE_API_MIN_SETTING];
  if (value === undefined) return RELAY_API_VERSIONS.min;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > RELAY_API_VERSIONS.max) return null;
  return Number(value);
}

export function relayApiVersionsFor(
  request: Pick<Request, "url" | "headers">,
  engineMin: number,
): { min: number; max: number } {
  if (engineMin === RELAY_API_VERSIONS.min) return RELAY_API_VERSIONS;
  if (carriesAutomationReplicaBearer(request.headers)) return RELAY_API_VERSIONS;
  let route: SyncRelayRoute["route"];
  try {
    route = parseRoute(request).route;
  } catch {
    return RELAY_API_VERSIONS;
  }
  return ENGINE_ROUTES.has(route)
    ? { min: engineMin, max: RELAY_API_VERSIONS.max }
    : RELAY_API_VERSIONS;
}

// A request names the relay API version it speaks. A request without the
// header is read as version 1. This check only refuses: it runs before
// authentication, reads only the route and the bearer's prefix, and never
// grants anything.
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
