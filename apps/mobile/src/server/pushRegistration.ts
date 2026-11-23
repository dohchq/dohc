import type { SignIn } from "./account";
import type { KeptStore } from "./keptStore";

type Owner = Pick<SignIn, "origin" | "userId">;

export interface PendingSignOuts {
  begin(owner: Owner): Promise<void>;
  isPending(owner: Owner): Promise<boolean>;
  cancel(owner: Owner): Promise<void>;
  end(owner: Owner): Promise<void>;
}

const key = (owner: Owner) => [owner.origin, owner.userId];

export async function readRegistration(store: KeptStore, owner: Owner) {
  const [row] = await store.read(
    "SELECT alerts, generation, signing_out FROM push_registrations WHERE origin = ? AND account_id = ?",
    key(owner),
  );
  if (!row) return null;
  return {
    alerts: row.alerts === 1,
    generation: typeof row.generation === "number" ? row.generation : null,
    signingOut: row.signing_out === 1,
  } as const;
}

export const saveRegistration = (
  store: KeptStore,
  owner: Owner,
  alerts: boolean,
  generation: number | null,
  live: () => boolean = () => true,
) =>
  store.transaction(async (sql) => {
    if (!live()) return;
    await sql.run(
      `INSERT INTO push_registrations (origin, account_id, alerts, generation, signing_out) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (origin, account_id) DO UPDATE SET alerts = excluded.alerts, generation = excluded.generation
       WHERE signing_out = 0`,
      [...key(owner), alerts ? 1 : 0, generation],
    );
  });

const mark = (store: KeptStore, owner: Owner, signingOut: 0 | 1) =>
  store.transaction((sql) =>
    sql.run(
      `INSERT INTO push_registrations (origin, account_id, alerts, generation, signing_out) VALUES (?, ?, 0, NULL, ?)
       ON CONFLICT (origin, account_id) DO UPDATE SET signing_out = excluded.signing_out`,
      [...key(owner), signingOut],
    ),
  );

export const pendingSignOuts = (store: KeptStore): PendingSignOuts => ({
  begin: (owner) => mark(store, owner, 1),
  isPending: async (owner) => (await readRegistration(store, owner))?.signingOut ?? false,
  cancel: (owner) => mark(store, owner, 0),
  end: (owner) =>
    store.transaction((sql) =>
      sql.run("DELETE FROM push_registrations WHERE origin = ? AND account_id = ?", key(owner)),
    ),
});
