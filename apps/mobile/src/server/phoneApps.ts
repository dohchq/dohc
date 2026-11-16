import { each, isFields, okAnswer, segment, text } from "./api";
import { exchange, ServerError, statusProblem, type Fetch, type ServerClient } from "./client";

// The account operations for a workspace's published apps (the relay's phoneApps.ts), and the launch exchange with the
// server's share-web, each answer checked before the phone uses it. The sign-in's token goes only to the relay;
// share-web gets the one-use grant alone, with no token, cookie or Origin.

/** One published version of an app. Approval holds only for this exact publication and revision. */
export interface PhoneApp {
  readonly publicationId: string;
  readonly authorityRevision: number;
  readonly appRoot: string;
  readonly sourceRevision: string;
  readonly approved: boolean;
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
  readonly reach: readonly {
    readonly name: string;
    readonly operations: readonly AppOperation[];
  }[];
  readonly sources: readonly string[];
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

const PUBLICATION = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isPublication = (value: unknown): value is string =>
  typeof value === "string" && PUBLICATION.test(value);
/** A catalog read gives up past this many pages, as failed: the server pages stored publications 25 at a time. */
const CATALOG_PAGES = 200;

/** An app's name: the last folder of its root. */
export const appName = (app: { readonly appRoot: string }) =>
  app.appRoot.split("/").filter(Boolean).at(-1) ?? app.appRoot;
/** A version as a person tells it apart: its source revision's first characters. */
export const shortVersion = (app: { readonly sourceRevision: string }) =>
  app.sourceRevision.slice(0, 7);

const readApp = (item: unknown): PhoneApp | null =>
  isFields(item) &&
  isPublication(item.publicationId) &&
  revision(item.authorityRevision) &&
  text(item.appRoot) &&
  text(item.sourceRevision, 128) &&
  typeof item.approved === "boolean"
    ? {
        publicationId: item.publicationId,
        authorityRevision: item.authorityRevision,
        appRoot: item.appRoot,
        sourceRevision: item.sourceRevision,
        approved: item.approved,
      }
    : null;

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
    (result.approval !== null && !isFields(result.approval))
  )
    return null;
  const by = result.publishedByAgent;
  const agent =
    by === null
      ? null
      : isFields(by) && (by.label === null || text(by.label, 160))
        ? { label: by.label }
        : undefined;
  const reach = each(result.capabilities, (item) => {
    const operations = isFields(item) ? each(item.operations, readOperation) : null;
    return isFields(item) && item.kind === "dataset" && text(item.name, 256) && operations
      ? { name: item.name, operations }
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
        createdAtMs: result.createdAtMs,
        agent,
        reach,
        sources,
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
  const run = <T>(
    name: string,
    args: object,
    read: (result: unknown) => T | null,
    own = signal,
  ): Promise<T> =>
    client.send(
      "POST",
      `/sync/${segment(workspaceId)}/ops/${name}`,
      (body) => {
        const answer = okAnswer(body);
        return answer ? read(answer.result) : null;
      },
      args,
      { signal: own },
    );
  const version = (app: Version) => ({
    publicationId: app.publicationId,
    authorityRevision: app.authorityRevision,
  });

  return {
    /** Every app the phone can open. A cursor seen before, or more pages than CATALOG_PAGES, fails the read. */
    async list(): Promise<readonly PhoneApp[]> {
      const apps: PhoneApp[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < CATALOG_PAGES; page++) {
        const answer: { apps: PhoneApp[]; next: string | null } = await run(
          "apps",
          cursor === null ? {} : { cursor },
          (result) => {
            const listed = isFields(result) ? each(result.apps, readApp) : null;
            const next = isFields(result) ? result.nextCursor : undefined;
            return listed && (next === null || isPublication(next)) ? { apps: listed, next } : null;
          },
        );
        apps.push(...answer.apps);
        if (answer.next === null) return apps;
        if (seen.has(answer.next)) break;
        seen.add(answer.next);
        cursor = answer.next;
      }
      throw new ServerError("invalid");
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

    /** A changed app refuses with code `conflict`. */
    approve: (app: Version) =>
      run("appApprove", version(app), (result) =>
        isFields(result) && text(result.approvalId, 128) ? true : null,
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
