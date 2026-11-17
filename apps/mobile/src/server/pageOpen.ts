import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-limits";
import { readLimits } from "../pages/liveBridge";
import { isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

// The account operation that opens a page to edit it live. `ready` carries a one-use ticket for the page's owner
// connection: it stays in this answer and the socket's protocols, never in the web view, a URL or a log.

export type PageOpen =
  | {
      readonly status: "ready";
      readonly objectId: string;
      readonly lineageClaimId: string;
      readonly ticket: string;
      readonly limits: NamedLiveBrowserLimits;
    }
  | { readonly status: "preparing" }
  | { readonly status: "refused"; readonly reason: string };

function readOpen(body: unknown): PageOpen | null {
  const result = okAnswer(body)?.result;
  if (!isFields(result)) return null;
  if (result.status === "preparing") return { status: "preparing" };
  if (result.status === "refused") {
    return text(result.reason, 128) ? { status: "refused", reason: result.reason } : null;
  }
  const limits = readLimits(result.editorLimits);
  return result.status === "ready" &&
    text(result.objectId, 256) &&
    text(result.lineageClaimId, 256) &&
    text(result.ticket, 1024) &&
    limits
    ? {
        status: "ready",
        objectId: result.objectId,
        lineageClaimId: result.lineageClaimId,
        ticket: result.ticket,
        limits,
      }
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
