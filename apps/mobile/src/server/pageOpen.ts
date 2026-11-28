import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-limits";
import { readLimits } from "../pages/liveBridge";
import { isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

// The account operation that opens a page to edit it live. `ready` carries a one-use ticket for the page's live
// connection: it stays in this answer and the socket's protocols, never in the web view, a URL or a log.

interface ReadyBase {
  readonly status: "ready";
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly ticket: string;
  readonly limits: NamedLiveBrowserLimits;
}

export type PageOpen =
  | (ReadyBase & { readonly mode: "owner" })
  | (ReadyBase & {
      readonly mode: "named";
      readonly session: string;
      readonly liveWorkspaceId: string;
    })
  | { readonly status: "preparing" }
  | { readonly status: "refused"; readonly reason: string };

const SESSION_DISCRIMINATOR = /^[A-Za-z0-9_-]{12}$/;

function readOpen(body: unknown): PageOpen | null {
  const result = okAnswer(body)?.result;
  if (!isFields(result)) return null;
  if (result.status === "preparing") return { status: "preparing" };
  if (result.status === "refused") {
    return text(result.reason, 128) ? { status: "refused", reason: result.reason } : null;
  }
  const limits = readLimits(result.editorLimits);
  if (
    result.status !== "ready" ||
    !text(result.objectId, 256) ||
    !text(result.lineageClaimId, 256) ||
    !text(result.ticket, 1024) ||
    !limits
  )
    return null;
  const base = {
    status: "ready" as const,
    objectId: result.objectId,
    lineageClaimId: result.lineageClaimId,
    ticket: result.ticket,
    limits,
  };
  if (result.mode === "named") {
    return typeof result.session === "string" &&
      SESSION_DISCRIMINATOR.test(result.session) &&
      text(result.liveWorkspaceId, 256) &&
      result.liveWorkspaceId.startsWith("named:")
      ? { ...base, mode: "named", session: result.session, liveWorkspaceId: result.liveWorkspaceId }
      : null;
  }
  return (result.mode === undefined || result.mode === "owner") &&
    result.session === undefined &&
    result.liveWorkspaceId === undefined
    ? { ...base, mode: "owner" }
    : null;
}

export function openPage(
  client: ServerClient,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
): Promise<PageOpen> {
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/openPage`,
    readOpen,
    { path },
    { signal },
  );
}
