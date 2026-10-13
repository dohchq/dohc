import { z } from "zod";
import {
  ServerAccountDeletionPreview,
  ServerAccountDeleteResult,
  type ServerAccountDeleteRequest,
} from "@dohc/cli/account";
import type { CloudCredentials } from "./cloudCredentialStore";

// Deletes the server account this computer is connected to, for the desktop
// window and the CLI alike. Both steps use the stored session, and the
// password only ever goes to the server the preview came from. Local
// workspaces are never touched: after deletion this computer only
// disconnects from that server.

export interface ServerAccountDeletionOptions {
  credentials(): Promise<CloudCredentials | null>;
  workspaces(): readonly { workspaceId: string; rootPath: string }[];
  // Disconnects from the deleted account, if this computer is still
  // connected to it.
  disconnect(deleted: CloudCredentials): Promise<void>;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 30_000;
// The server finishes the relay purge before it answers.
const DELETE_TIMEOUT_MS = 90_000;
const UNREACHABLE = "dohc could not reach this server. Check your connection, then try again.";
const SESSION_EXPIRED = "Your server session expired. Sign in again, then retry.";
const RATE_LIMITED = "The server paused deletion after too many attempts. Wait a few minutes, then try again.";
// The server's preview token lives five minutes.
const REVIEW_MS = 5 * 60_000;
// Server codes whose message is written for the person deleting.
const SERVER_WORDS = new Set(["DELETION_UNAVAILABLE", "DELETION_PENDING"]);
const Deleted = z.union([
  z.object({ finished: z.literal(true) }),
  z.object({ finished: z.literal(false), pending: z.literal(true) }),
]);

function sameServer(left: string, right: string): boolean {
  return left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");
}

// The folder name, as the workspace list shows it.
function workspaceName(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "workspace";
}

async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return {};
    return {
      ...("code" in body && typeof body.code === "string" ? { code: body.code } : {}),
      ...("message" in body && typeof body.message === "string" ? { message: body.message } : {}),
    };
  } catch {
    return {};
  }
}

function failure(status: number, body: { code?: string; message?: string }, failed: string): Error {
  if (status === 401) return new Error(SESSION_EXPIRED);
  if (status === 429) return new Error(RATE_LIMITED);
  if (body.code && SERVER_WORDS.has(body.code) && body.message) return new Error(body.message);
  return new Error(`${failed} The server answered ${status}. Try again, or contact the server owner.`);
}

export function createServerAccountDeletion(options: ServerAccountDeletionOptions) {
  const fetchImpl = options.fetch ?? fetch;
  // The account each preview token was issued to, so the password only goes
  // with the session that the person reviewed.
  const reviews = new Map<string, { serverUrl: string; userId: string; at: number }>();

  async function session(): Promise<CloudCredentials> {
    const credentials = await options.credentials();
    if (!credentials) throw new Error("Connect to a server first.");
    return credentials;
  }

  async function post(credentials: CloudCredentials, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetchImpl(`${credentials.serverUrl.replace(/\/+$/u, "")}/api/auth/account/${path}`, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(UNREACHABLE);
    }
  }

  return {
    async preview(): Promise<ServerAccountDeletionPreview> {
      const credentials = await session();
      const response = await post(credentials, "deletion-preview", {}, TIMEOUT_MS);
      if (!response.ok) throw failure(response.status, await errorBody(response), "The server could not list what deletion removes.");
      const body: unknown = await response.json().catch(() => null);
      const scope = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const ids = scope.workspaceIds;
      if (scope.passwordRequired !== true || typeof scope.email !== "string" || typeof scope.previewToken !== "string" ||
          !Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
        throw new Error("The server returned an invalid deletion preview. Contact the server owner.");
      }
      const owned = new Set(ids);
      const workspaces = options.workspaces()
        .filter((workspace) => owned.has(workspace.workspaceId))
        .map((workspace) => ({ workspaceId: workspace.workspaceId, name: workspaceName(workspace.rootPath) }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId));
      const parsed = ServerAccountDeletionPreview.safeParse({
        email: scope.email,
        server: credentials.serverUrl,
        workspaces,
        workspacesElsewhere: owned.size - workspaces.length,
        storedBytes: scope.storedBytes,
        ownedShareCount: scope.ownedShareCount,
        heldGrantCount: scope.heldGrantCount,
        previewToken: scope.previewToken,
      });
      if (!parsed.success) throw new Error("The server returned an invalid deletion preview. Contact the server owner.");
      const now = Date.now();
      for (const [token, review] of reviews) if (now - review.at >= REVIEW_MS) reviews.delete(token);
      reviews.set(parsed.data.previewToken, { serverUrl: credentials.serverUrl, userId: credentials.userId, at: now });
      return parsed.data;
    },

    async delete(input: ServerAccountDeleteRequest): Promise<ServerAccountDeleteResult> {
      const credentials = await session();
      // The password goes only to the server and account the person reviewed.
      if (!sameServer(input.server, credentials.serverUrl)) {
        return { ok: false, code: "preview-changed", reason: "This computer is now connected to another server. Review deletion again." };
      }
      const review = reviews.get(input.previewToken);
      if (!review || Date.now() - review.at >= REVIEW_MS) {
        return { ok: false, code: "preview-changed", reason: "The review expired, or what deletion removes changed. Review it again." };
      }
      if (!sameServer(review.serverUrl, credentials.serverUrl) || review.userId !== credentials.userId) {
        return { ok: false, code: "preview-changed", reason: "This computer is now connected to another account. Review deletion again." };
      }
      const response = await post(credentials, "delete", { previewToken: input.previewToken, password: input.password }, DELETE_TIMEOUT_MS);
      if (response.status === 429) return { ok: false, code: "rate-limited", reason: RATE_LIMITED };
      if (!response.ok) {
        const body = await errorBody(response);
        if (body.code === "PREVIEW_CHANGED" || body.code === "PREVIEW_REQUIRED") {
          return { ok: false, code: "preview-changed", reason: "The review expired, or what deletion removes changed. Review it again." };
        }
        if (body.code === "INVALID_PASSWORD" || body.code === "PASSWORD_REQUIRED") {
          return { ok: false, code: "wrong-password", reason: "The password is incorrect. Enter your server account password." };
        }
        throw failure(response.status, body, "The server could not delete this account.");
      }
      // Only an answer that says finished or pending means the account is
      // gone. Anything else leaves the session alone.
      const deleted = Deleted.safeParse(await response.json().catch(() => null));
      if (!deleted.success) throw new Error("The server returned an invalid answer to deletion. Contact the server owner.");
      // The server already ended every session of the account, finished or
      // not. The disconnect clears the cached session before anything that
      // can fail, so a failure here must not hide the deletion.
      await options.disconnect(credentials).catch(() => undefined);
      return ServerAccountDeleteResult.parse({ ok: true, finished: deleted.data.finished, email: credentials.email, server: credentials.serverUrl });
    },
  };
}

export type ServerAccountDeletion = ReturnType<typeof createServerAccountDeletion>;
