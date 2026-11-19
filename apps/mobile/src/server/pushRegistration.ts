import type { KeptStore } from "./keptStore";

export interface Owner {
  readonly origin: string;
  readonly userId: string;
}

export interface Registration {
  readonly alerts: boolean;
  readonly generation: number | null;
  readonly signingOut: boolean;
}

/** A Sign out waiting for the server, kept in the account's registration row so a relaunch finishes it. */
export interface PendingSignOuts {
  begin(owner: Owner): Promise<void>;
  isPending(owner: Owner): Promise<boolean>;
  end(owner: Owner): Promise<void>;
}

const key = (owner: Owner) => [owner.origin, owner.userId];

export async function readRegistration(
  store: KeptStore,
  owner: Owner,
): Promise<Registration | null> {
  const [row] = await store.read(
    "SELECT alerts, generation, signing_out FROM push_registrations WHERE origin = ? AND account_id = ?",
    key(owner),
  );
  if (!row) return null;
  return {
    alerts: row.alerts === 1,
    generation: typeof row.generation === "number" ? row.generation : null,
    signingOut: row.signing_out === 1,
  };
}

export const saveRegistration = (
  store: KeptStore,
  owner: Owner,
  alerts: boolean,
  generation: number | null,
) =>
  store.transaction((sql) =>
    sql.run(
      `INSERT INTO push_registrations (origin, account_id, alerts, generation, signing_out) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (origin, account_id) DO UPDATE SET alerts = excluded.alerts, generation = excluded.generation
       WHERE signing_out = 0`,
      [...key(owner), alerts ? 1 : 0, generation],
    ),
  );

export const pendingSignOuts = (store: KeptStore): PendingSignOuts => ({
  begin: (owner) =>
    store.transaction((sql) =>
      sql.run(
        `INSERT INTO push_registrations (origin, account_id, alerts, generation, signing_out) VALUES (?, ?, 0, NULL, 1)
         ON CONFLICT (origin, account_id) DO UPDATE SET alerts = 0, signing_out = 1`,
        key(owner),
      ),
    ),
  isPending: async (owner) => (await readRegistration(store, owner))?.signingOut ?? false,
  end: (owner) =>
    store.transaction((sql) =>
      sql.run("DELETE FROM push_registrations WHERE origin = ? AND account_id = ?", key(owner)),
    ),
});
