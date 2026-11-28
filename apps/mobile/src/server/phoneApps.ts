import { accountOperations, each, isFields, text } from "./api";
import { exchange, ServerError, statusProblem, type Fetch, type ServerClient } from "./client";

// The account operations for a workspace's published apps (the relay's phoneApps.ts), and the launch exchange with the
// server's share-web, each answer checked before the phone uses it. The sign-in's token goes only to the relay;
// share-web gets the one-use grant alone, with no token, cookie or Origin.

/** Whether the person allowed what a Member app can do: not yet, still, or not since it came to reach more. */
export type MemberConsent = "none" | "current" | "changed";

/**
 * A Member app: one a workspace member shared, which runs within both its author's reach and the viewer's, and opens
 * only once the viewer allowed what it can do.
 */
export interface MemberApp {
  readonly name: string;
  readonly author: string | null;
  readonly consent: MemberConsent;
}

/**
 * One published version of an app. Approval holds only for this exact publication and revision, and for a Member app
 * only while the person's allowing still covers what it can do.
 */
export interface PhoneApp {
  readonly publicationId: string;
  readonly authorityRevision: number;
  readonly appRoot: string;
  readonly sourceRevision: string;
  readonly approved: boolean;
  readonly owner: boolean;
  /** Null for the owner's own published app. */
  readonly member: MemberApp | null;
}

export interface AppOperation {
  readonly name: string;
  readonly readOnly: boolean;
  readonly fields: readonly string[];
}

export interface AppReview extends PhoneApp {
  readonly createdAtMs: number;
  /** Null when no agent published it; an agent's label, or null when it gave none. */
  readonly agent: { readonly label: string | null } | null;
  /** Each Collection it can use. A Member app lists only what both its author and the viewer can do, at their lower level. */
  readonly reach: readonly {
    readonly datasetId: string;
    readonly name: string;
    readonly alias: string | null;
    readonly access: "view" | "comment" | "edit" | null;
    readonly operations: readonly AppOperation[];
  }[];
  readonly sources: readonly string[];
  /** The exact operations reviewed, which allowing a Member app pins. Null for the owner's own app. */
  readonly scopeDigest: string | null;
  /** An approval or an allowing stands to revoke, even when the app needs another review. */
  readonly revocable: boolean;
}

export type AppSource =
  | { readonly available: true; readonly text: string }
  | { readonly available: false };

/** What native code submits to start the app: the bootstrap address and its one-use handoff. */
export interface AppLaunch {
  readonly action: string;
  readonly handoff: string;
}

type Version = Pick<PhoneApp, "publicationId" | "authorityRevision">;
const ACCESS = ["view", "comment", "edit"] as const;
const CONSENT: readonly MemberConsent[] = ["none", "current", "changed"];
const AUDIENCE: readonly unknown[] = [undefined, "link", "workspace", "owner"];

const PUBLICATION = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isPublication = (value: unknown): value is string =>
  typeof value === "string" && PUBLICATION.test(value);
/** A catalog read gives up past this many pages, as failed: the server pages stored publications 25 at a time. */
const CATALOG_PAGES = 200;

/** An app's name: a Member app's as its author shared it, otherwise the last folder of its root. */
export const appName = (app: Pick<PhoneApp, "appRoot" | "member">) =>
  app.member?.name ?? app.appRoot.split("/").filter(Boolean).at(-1) ?? app.appRoot;
/** A version as a person tells it apart: its source revision's first characters. */
export const shortVersion = (app: { readonly sourceRevision: string }) =>
  app.sourceRevision.slice(0, 7);

const readAuthor = (value: unknown): string | null | undefined =>
  isFields(value) && (value.name === null || text(value.name, 320)) ? value.name : undefined;

function readVersion(item: unknown, member: boolean): PhoneApp | null {
  if (
    !isFields(item) ||
    !isPublication(item.publicationId) ||
    !revision(item.authorityRevision) ||
    !text(item.appRoot) ||
    !text(item.sourceRevision, 128) ||
    typeof item.approved !== "boolean" ||
    !AUDIENCE.includes(item.audience)
  )
    return null;
  const author = readAuthor(item.author);
  const consent = CONSENT.find((value) => value === item.consent);
  if (member && (!text(item.name, 64) || author === undefined || !consent)) return null;
  return {
    publicationId: item.publicationId,
    authorityRevision: item.authorityRevision,
    appRoot: item.appRoot,
    sourceRevision: item.sourceRevision,
    approved: item.approved,
    owner: item.audience === "owner",
    member: member ? { name: item.name as string, author: author!, consent: consent! } : null,
  };
}
const readApp = (item: unknown) => readVersion(item, false);
const readMemberApp = (item: unknown) => readVersion(item, true);

function readOperation(item: unknown): AppOperation | null {
  if (!isFields(item) || !text(item.name, 256) || typeof item.readOnly !== "boolean") return null;
  const fields =
    item.fields === undefined
      ? []
      : each(item.fields, (field) =>
          isFields(field) && text(field.name, 256) ? field.name : null,
        );
  return fields && { name: item.name, readOnly: item.readOnly, fields };
}

function readReview(result: unknown, publicationId: string): AppReview | null {
  if (
    !isFields(result) ||
    result.publicationId !== publicationId ||
    !revision(result.authorityRevision) ||
    !text(result.appRoot) ||
    !text(result.sourceRevision, 128) ||
    !revision(result.createdAtMs) ||
    (result.approval !== null && !isFields(result.approval)) ||
    typeof result.revocable !== "boolean" ||
    !AUDIENCE.includes(result.audience)
  )
    return null;
  const member =
    result.author === null && result.consent === null && result.scopeDigest === null
      ? null
      : isPublication(result.scopeDigest)
        ? readMemberApp({ ...result, approved: result.approval !== null })?.member
        : undefined;
  if (member === undefined) return null;
  const by = result.publishedByAgent;
  const agent =
    by === null
      ? null
      : isFields(by) && (by.label === null || text(by.label, 160))
        ? { label: by.label }
        : undefined;
  const reach = each(result.capabilities, (item) => {
    const operations = isFields(item) ? each(item.operations, readOperation) : null;
    const access =
      isFields(item) && item.access === undefined
        ? null
        : ACCESS.find((value) => isFields(item) && value === item.access);
    return isFields(item) &&
      item.kind === "dataset" &&
      text(item.datasetId, 128) &&
      text(item.name, 256) &&
      operations &&
      access !== undefined
      ? {
          datasetId: item.datasetId,
          name: item.name,
          alias: text(item.alias, 64) ? item.alias : null,
          access,
          operations,
        }
      : null;
  });
  const sources = each(result.sources, (item) =>
    isFields(item) && text(item.path) ? item.path : null,
  );
  return reach && sources && agent !== undefined
    ? {
        publicationId,
        authorityRevision: result.authorityRevision,
        appRoot: result.appRoot,
        sourceRevision: result.sourceRevision,
        approved: result.approval !== null,
        owner: result.audience === "owner",
        member,
        createdAtMs: result.createdAtMs,
        agent,
        reach,
        sources,
        scopeDigest: member ? (result.scopeDigest as string) : null,
        revocable: result.revocable,
      }
    : null;
}

/** The bootstrap share-web names: an HTTPS address at /bootstrap, with nothing else in it. */
function bootstrapAction(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.pathname === "/bootstrap" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.href === value
      ? value
      : null;
  } catch {
    return null;
  }
}

/** One workspace's app operations, for one sign-in's client. Each request ends when `signal` aborts. */
export function appOperations(client: ServerClient, workspaceId: string, signal: AbortSignal) {
  const { run, all } = accountOperations(client, workspaceId, signal);
  const version = (app: Version) => ({
    publicationId: app.publicationId,
    authorityRevision: app.authorityRevision,
  });

  return {
    /** Every app the phone can open: the owner's own, then the Member apps within reach. */
    list: async (): Promise<readonly PhoneApp[]> => {
      const [own, member] = await Promise.all([
        all("apps", CATALOG_PAGES, readApp, isPublication),
        all("memberApps", CATALOG_PAGES, readMemberApp, isPublication),
      ]);
      return [...own, ...member];
    },

    review: (publicationId: string) =>
      run("appReview", { publicationId }, (result) => readReview(result, publicationId)),

    /** The source this version was published from, as plain text, or unavailable when its bytes are gone. */
    source: (publicationId: string, path: string) =>
      run<AppSource>("appSource", { publicationId, path }, (result) => {
        if (!isFields(result) || result.path !== path) return null;
        if (result.available === false) return { available: false };
        return result.available === true && typeof result.text === "string"
          ? { available: true, text: result.text }
          : null;
      }),

    /** A changed app refuses with code `conflict`. A Member app is allowed for exactly the reviewed `scopeDigest`. */
    approve: (app: Version & { readonly scopeDigest?: string | null }) =>
      run(
        "appApprove",
        { ...version(app), ...(app.scopeDigest ? { scopeDigest: app.scopeDigest } : {}) },
        (result) => (isFields(result) && text(result.approvalId, 128) ? true : null),
      ),

    revoke: (publicationId: string) =>
      run("appRevoke", { publicationId }, (result) =>
        isFields(result) && typeof result.revoked === "boolean" ? true : null,
      ),

    /** A grant from the relay, then share-web's launch for it, on the sign-in's own origin, as a dohc server serves it. */
    async launch(fetch: Fetch, app: Version, own: AbortSignal): Promise<AppLaunch> {
      const grant = await run(
        "appLaunch",
        version(app),
        (result) =>
          isFields(result) && typeof result.grant === "string" && SECRET.test(result.grant)
            ? result.grant
            : null,
        own,
      );
      const answer = await exchange(fetch, `${client.origin}/api/apps/phone-launch`, {
        method: "POST",
        body: { grant, workspaceId, publicationId: app.publicationId },
        signal: own,
      });
      if (answer.status !== 200) throw new ServerError(statusProblem(answer.status), answer.status);
      const body = isFields(answer.body) ? answer.body : {};
      const action = bootstrapAction(body.action);
      if (!action || typeof body.handoff !== "string" || !SECRET.test(body.handoff))
        throw new ServerError("invalid", answer.status);
      return { action, handoff: body.handoff };
    },
  };
}

export type AppOperations = ReturnType<typeof appOperations>;
