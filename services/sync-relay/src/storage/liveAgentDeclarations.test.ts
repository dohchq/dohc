import {afterEach, expect, it} from "vitest";
import type {AgentDeclaration} from "@dohc/live-session-contract/live-update-admission";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import {initialAcceptedHistoryDigest} from "../liveAcceptedHistory.js";
import {openRelayDeployment} from "../relayDeployment.js";
import type {SyncRelayStorage} from "../storage.js";
import type {StorageContext} from "./context.js";
import {readAcceptedHistoryDelivery, readAcceptedHistoryInterval, RestoreHistoryBudget} from "./liveAcceptedHistory.js";

afterEach(cleanupLiveDeliveryFixtures);

type Fixture = ReturnType<typeof registered>;
type Input = ReturnType<Fixture["capture"]>;
const declared: AgentDeclaration = {agentId: "trip-agent-ü", onBehalfOf: "local-person", depth: 2};
const declare = (input: Input, agentDeclaration: AgentDeclaration): Input =>
  ({...input, metadata: {...input.metadata, agentDeclaration}});
const declarations = (f: Fixture) =>
  f.raw.prepare("SELECT * FROM sync_relay_live_update_agent_declarations ORDER BY journal_cursor").all();

it("binds an owner's declared agent to its delivery and refuses a changed, added, or removed declaration", () => {
  const f = registered({deployment: true});
  try {
    const first = declare(f.capture(f.update(), "declared"), declared);
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    expect(accepted.admitted!.metadata.accepted.agentDeclaration).toEqual(declared);
    // The declaration names an agent; the authenticated owner stays the authority.
    expect(accepted.admitted!.metadata.accepted.authority).toEqual(first.expectedAuthority);
    expect(declarations(f)).toEqual([{journal_cursor: 1, agent_id: "trip-agent-ü", on_behalf_of: "local-person", depth: 2}]);
    expect(f.storage.commitLiveUpdateJournal(first).result).toMatchObject({kind: "accepted", replayed: true});

    // This cut carries the declared event, so admission compares it with storage.
    const plain = f.capture(f.update("more", "plain"), "plain");
    expect(plain.cutToken.suffix[0]!.metadata.accepted.agentDeclaration).toEqual(declared);
    const second = f.storage.commitLiveUpdateJournal(plain);
    expect(second.result).toMatchObject({kind: "accepted", replayed: false});
    expect(second.admitted!.metadata.accepted).not.toHaveProperty("agentDeclaration");

    const {agentDeclaration: _removed, ...undeclared} = first.metadata;
    const before = f.journalRows();
    for (const retry of [declare(first, {...declared, agentId: "other-agent"}), declare(first, {...declared, onBehalfOf: null}),
      declare(first, {...declared, depth: 3}), {...first, metadata: undeclared}, declare(plain, declared)]) {
      expect(f.storage.commitLiveUpdateJournal(retry).result).toEqual({kind: "refused", reason: "delivery-conflict"});
    }
    expect(f.journalRows()).toEqual(before);
    expect(declarations(f)).toHaveLength(1);
  } finally { f.close(); }
});

it("refuses an agent declaration from a named recipient without writing", () => {
  const f = registered({deployment: true});
  try {
    const named = f.capture(f.update(), "named", {kind: "named", userId: "reader", grantId: "grant"});
    const before = f.journalRows();
    expect(f.storage.commitLiveUpdateJournal(declare(named, declared)))
      .toEqual({result: {kind: "refused", reason: "authority-refused"}, admitted: null});
    expect(f.journalRows()).toEqual(before);
    expect(declarations(f)).toEqual([]);
    expect(f.storage.commitLiveUpdateJournal(named).result).toMatchObject({kind: "accepted", replayed: false});
  } finally { f.close(); }
});

it("reads a declaration folded into a checkpoint from committed delivery, accepted history, and a reopened store", () => {
  const f = registered({deployment: true});
  let open = true;
  try {
    const first = declare(f.capture(f.update(), "declared"), declared);
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result.kind).toBe("accepted");
    // Large undeclared events reach the journal's byte checkpoint.
    const large = f.update("payload", "x".repeat(1_048_576));
    let cursor = 1;
    while (!f.raw.prepare("SELECT 1 FROM sync_relay_live_update_journal WHERE validation_checkpoint_bytes IS NOT NULL").get()) {
      expect(cursor).toBeLessThan(40);
      expect(f.storage.commitLiveUpdateJournal(f.capture(large, `large-${cursor}`)).result.kind).toBe("accepted");
      cursor++;
    }
    const terminal = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1").get()!;
    expect(terminal.validation_checkpoint_bytes).not.toBeNull();
    const cut = f.storage.readLiveUpdateJournalCut({document: first.cutToken.document});
    if (cut.kind !== "cut") throw new Error("Expected journal cut");
    expect(cut.cut.suffix).toEqual([]);
    const read = (storage: SyncRelayStorage) => {
      expect(storage.readCommittedLiveUpdate({host: first.host, document: first.cutToken.document, journalCursor: 1}))
        .toEqual({kind: "committed", admitted: accepted.admitted});
      const document = first.cutToken.document, namespace = String(terminal.relay_database_namespace);
      const eventCount = Number(terminal.accepted_event_count), through = Number(terminal.journal_cursor);
      const delivery = readAcceptedHistoryDelivery(storage as unknown as StorageContext,
        {document, namespace, through, eventCount, deliveryId: "declared"}, new RestoreHistoryBudget(1 << 30, 10_000));
      expect(delivery?.accepted.agentDeclaration).toEqual(declared);
      const events = readAcceptedHistoryInterval(storage as unknown as StorageContext, {document, namespace,
        selected: {eventCount: 0, terminal: null, evidenceDigest: initialAcceptedHistoryDigest(namespace, document)},
        accepted: {eventCount, evidenceDigest: String(terminal.accepted_evidence_digest),
          terminal: {deliveryId: String(terminal.delivery_id), updateDigest: String(terminal.update_digest),
            journalCursor: through, acceptingHostEpoch: first.host.hostEpoch}}}, new RestoreHistoryBudget(1 << 30, 10_000));
      expect(events.map(event => event.metadata.accepted.agentDeclaration ?? null))
        .toEqual([declared, ...Array.from({length: events.length - 1}, () => null)]);
    };
    read(f.storage);
    f.close(); open = false;
    const reopened = openRelayDeployment(f.configPath).storage;
    try { read(reopened); } finally { reopened.close(); }
  } finally { if (open) f.close(); }
}, 120_000);
