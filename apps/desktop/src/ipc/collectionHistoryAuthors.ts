import type { DatasetHistoryPage } from "@dohc/cli/dataset";
import { recordHistoryPersonIsNamed } from "./recordHistoryIpc";

type Entry = DatasetHistoryPage["entries"][number];

/** How main names the people, agents, and apps in the owner's Collection History. */
export interface CollectionHistoryNames {
  /** The workspace owner's account, whose changes are the viewer's own. */
  ownerId: string | null;
  /** Prepare account labels together, without waiting on network I/O. */
  prepare(userIds: readonly string[]): void;
  person(userId: string): string;
  agent(agentId: string): string;
  /** The app's folder name while this workspace still holds or shares it, else null. */
  app(publicationId: string): Promise<string | null>;
}

/** Replaces each entry's raw actor with the names the owner's History shows. Ids stay in main. */
export async function collectionHistoryAuthors(
  entries: readonly Entry[],
  names: CollectionHistoryNames,
): Promise<Entry[]> {
  const named = (userId: string) => recordHistoryPersonIsNamed(userId, names.ownerId);
  names.prepare([
    ...new Set(
      entries.flatMap(({ actor }) =>
        actor?.userId !== undefined && named(actor.userId) ? [actor.userId] : [],
      ),
    ),
  ]);
  const person = (userId: string) => (named(userId) ? names.person(userId) : "You");
  const apps = new Map<string, Promise<string>>();
  const app = (publicationId: string) => {
    const known =
      apps.get(publicationId) ??
      names.app(publicationId).then(
        (name) => name ?? "an app",
        () => "an app",
      );
    apps.set(publicationId, known);
    return known;
  };
  return Promise.all(
    entries.map(async ({ actor, ...rest }) => {
      const entry = { ...rest, callerReference: null };
      if (!actor) return entry;
      const through = actor.appId === undefined ? {} : { app: await app(actor.appId) };
      if (actor.kind === "agent")
        return {
          ...entry,
          by: {
            kind: "agent" as const,
            name: actor.agentId === undefined ? "Agent" : names.agent(actor.agentId),
            ...(actor.userId === undefined ? {} : { person: person(actor.userId) }),
            ...through,
          },
        };
      if (actor.kind === "link")
        return { ...entry, by: { kind: "link" as const, name: "Link holder", ...through } };
      const name =
        actor.kind === "owner" || actor.userId === undefined ? "You" : person(actor.userId);
      return { ...entry, by: { kind: "person" as const, name, ...through } };
    }),
  );
}
