import {
  createNamedLiveBrowserTransport,
  LiveAuthorityUnavailableError,
  parseNamedLiveBrowserLimits,
  type NamedLiveSelection,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import { fetchShareWeb } from "./apiVersion";

// A member's page opens for editing through the workspace's host. Only the
// editing page loads this, so the workspace page's first load stays small.

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type MemberPageAdmission =
  | {
      kind: "open";
      discriminator: string;
      objectId: string;
      userId: string;
      token: string;
      limits: unknown;
    }
  | { kind: "refused"; code: string };

async function memberLive(
  path: string,
  body: { grantId: string; path: string },
  signal: AbortSignal,
): Promise<{ status: number; value: unknown }> {
  const response = await fetchShareWeb(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
  const value: unknown = json
    ? await response.json().catch(() => null)
    : await response.body?.cancel().catch(() => null);
  signal.throwIfAborted();
  // share-web gives one answer for a signed-out browser, another account, and an ended membership.
  if ([401, 403, 404].includes(response.status))
    throw new LiveAuthorityUnavailableError("Unavailable");
  return { status: response.status, value };
}

/** Opens a page for editing. The host's refusal keeps its code, so the page can say why. */
export async function openMemberPage(
  grantId: string,
  path: string,
  signal: AbortSignal,
): Promise<MemberPageAdmission> {
  const { status, value } = await memberLive("/api/live/member-open", { grantId, path }, signal);
  if (
    status === 409 &&
    record(value) &&
    Object.keys(value).sort().join() === "code,ok" &&
    value.ok === false &&
    typeof value.code === "string"
  )
    return { kind: "refused", code: value.code };
  if (
    status !== 200 ||
    !record(value) ||
    Object.keys(value).sort().join() !== "discriminator,limits,objectId,token,userId" ||
    typeof value.discriminator !== "string" ||
    typeof value.objectId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.token !== "string"
  )
    throw Error("Unavailable");
  return {
    kind: "open",
    discriminator: value.discriminator,
    objectId: value.objectId,
    userId: value.userId,
    token: value.token,
    limits: value.limits,
  };
}

/** Waits while the owner's dohc starts the page's live history. True once the host can take it. */
export async function memberPageReady(
  grantId: string,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { status, value } = await memberLive("/api/live/member-ready", { grantId, path }, signal);
  if (status !== 200 || !record(value) || typeof value.ready !== "boolean")
    throw Error("Unavailable");
  return value.ready;
}

export type MemberDocument = {
  session: ReturnType<
    ReturnType<typeof createNamedLiveBrowserTransport<NamedLiveSelection>>["select"]
  >;
  close(): void;
};

/**
 * The page's live session. The admission that opened the page connects it
 * first; each later connection asks the host again, and a refusal reports its
 * code to `onRefused`.
 */
export function memberDocument(input: {
  grantId: string;
  path: string;
  accountId: string;
  admission: Extract<MemberPageAdmission, { kind: "open" }>;
  onRefused(code: string): void;
}): MemberDocument {
  let first: MemberPageAdmission | null = input.admission;
  const { objectId } = input.admission;
  const transport = createNamedLiveBrowserTransport<NamedLiveSelection>({
    publicOrigin: location.origin,
    limits: parseNamedLiveBrowserLimits(input.admission.limits),
    fetch: fetchShareWeb,
    recordingContext: (selection) => ({ kind: "account", accountId: selection.accountId }),
    async authorize(_selection, signal) {
      const admitted = first ?? (await openMemberPage(input.grantId, input.path, signal));
      first = null;
      if (admitted.kind === "refused") {
        input.onRefused(admitted.code);
        throw new LiveAuthorityUnavailableError(admitted.code);
      }
      // The answer must be for this account and this page.
      if (admitted.userId !== input.accountId || admitted.objectId !== objectId)
        throw new LiveAuthorityUnavailableError("Unavailable");
      const url = new URL("/api/live", location.origin);
      url.protocol = "wss:";
      url.searchParams.set("session", admitted.discriminator);
      return {
        ticketToken: admitted.token,
        discriminator: admitted.discriminator,
        websocketUrl: url.href,
      };
    },
  });
  const session = transport.select({
    accountId: input.accountId,
    workspaceId: `named:${input.grantId}`,
    grantId: input.grantId,
    objectId,
  });
  return { session, close: () => transport.close() };
}
