import {afterEach, expect, it} from "vitest";
import type {AgentDeclaration} from "@dohc/live-session-contract/live-update-admission";
import type {LiveAuthorSnapshot} from "@dohc/live-session-contract";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import {initialAcceptedHistoryDigest} from "../liveAcceptedHistory.js";
import {openRelayDeployment} from "../relayDeployment.js";
import type {SyncRelayStorage} from "../storage.js";
import type {StorageContext} from "./context.js";
import {readAcceptedHistoryDelivery, readAcceptedHistoryInterval, RestoreHistoryBudget} from "./liveAcceptedHistory.js";
import {nativeSourceAuthorMatches} from "./liveNativeSourceAuthors.js";
import type {NativeRestoreProposalReceipt} from "../liveRestoreProposal.js";
import {limitLiveDeclaredAgents} from "./liveAuthorWindow.js";

afterEach(cleanupLiveDeliveryFixtures);

it("binds server automation provenance to owner admission and exact retries", () => {
  const f = registered({deployment: true});
  try {
    const trustedAutomation = {automationId: "collection:Tasks#mark", attribution: {actorKind: "automation" as const,
      onBehalfOf: "reader", depth: 1, run: {claimId: "claim", automationName: "Mark done"}}};
    const first = {...f.capture(f.update(), "automation"), trustedAutomation, trustedAutomationGrant: {grantId: "grant", grantGeneration: 4}};
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    expect(accepted.admitted!.metadata.authorSnapshot).toEqual([{kind: "automation", ...trustedAutomation}]);
    expect(accepted.admitted!.metadata.accepted.authority.principalKind).toBe("owner");
    const source: NativeRestoreProposalReceipt["nativeSources"][number] = {outboxId: "outbox", outboxSequence: 1, binding: first.metadata.binding,
      deliveryId: first.metadata.deliveryId, byteLength: first.updateBytes.length, createdAtMs: 1, acceptedReceipt: accepted.admitted!.metadata.accepted.receipt,
      appendKey: "write/Status", updateDigest: first.metadata.updateDigest,
      source: {binding: first.metadata.binding, updateDigest: first.metadata.updateDigest, origin: {kind: "ownerDraft", automationDeclaration: trustedAutomation}}};
    const matches = (candidate: typeof source) => nativeSourceAuthorMatches(f.storage as StorageContext, candidate, accepted.admitted!.metadata, new RestoreHistoryBudget(1 << 20, 100));
    expect(matches(source)).toBe(true);
    expect(matches({...source, source: {...source.source, origin: {kind: "ownerDraft"}}})).toBe(false);
    expect(matches({...source, source: {...source.source, origin: {kind: "ownerDraft", automationDeclaration: {...trustedAutomation,
      attribution: {...trustedAutomation.attribution, onBehalfOf: "someone-else"}}}}})).toBe(false);
    expect(f.storage.commitLiveUpdateJournal(first).result).toMatchObject({kind: "accepted", replayed: true});
    for (const retry of [f.capture(f.update(), "automation"), {...first, trustedAutomation: {...trustedAutomation,
      attribution: {...trustedAutomation.attribution, onBehalfOf: "different-reader"}}}]) {
      expect(f.storage.commitLiveUpdateJournal(retry).result).toEqual({kind: "refused", reason: "delivery-conflict"});
    }
    const named = f.capture(f.update("more", "named"), "named", {kind: "named", userId: "reader", grantId: "grant"});
    expect(f.storage.commitLiveUpdateJournal({...named, trustedAutomation}).result).toEqual({kind: "refused", reason: "authority-refused"});
  } finally {f.close();}
});

type Fixture = ReturnType<typeof registered>;
type Input = ReturnType<Fixture["capture"]> & {trustedAccount?: {accountId:string;name:string}; metadata: ReturnType<Fixture["capture"]>["metadata"] & {authorContext?: import("@dohc/live-session-contract").LiveAuthorContext}};
const declared: AgentDeclaration = {agentId: "trip-agent-ü", onBehalfOf: "local-person", depth: 2};
const declare = (input: Input, agentDeclaration: AgentDeclaration): Input =>
  ({...input, trustedAccount: {accountId: input.expectedAuthority.principalId, name: "Owner"}, metadata: {...input.metadata,
    authorContext: {kind: "account", accountId: input.expectedAuthority.principalId,
      agent: {agentId: agentDeclaration.agentId, ...(agentDeclaration.onBehalfOf === null ? {} : {onBehalfOf: agentDeclaration.onBehalfOf}), depth: agentDeclaration.depth}}}});
const declarations = (f: Fixture) =>
  f.raw.prepare("SELECT author_snapshot_json FROM sync_relay_live_update_journal WHERE author_context_json IS NOT NULL ORDER BY journal_cursor").all();
const admittedAgent = (metadata: import("@dohc/live-session-contract").AdmittedLiveUpdateMetadata | null | undefined) => metadata?.authorSnapshot?.find(author => author.kind === "agent");
const expectedAgent = {kind: "agent", ...declared, onBehalfOf: "owner"};

it("records a recipient's bound pair while replay and native restore match the original declaration", () => {
  const f = registered({deployment: true});
  try {
    const agent = {...declared, onBehalfOf: "owner"};
    const first = {...declare(f.capture(f.update(), "recipient-agent", {kind: "named", userId: "reader", grantId: "grant"}), agent),
      trustedAccount: {accountId: "reader", name: "Reader"}};
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    const boundAgent = {kind: "agent" as const, ...agent, onBehalfOf: "reader"};
    const snapshot: LiveAuthorSnapshot = [{kind: "human", humanId: "reader", humanName: "Reader"}, boundAgent];
    expect(accepted.admitted!.metadata.authorSnapshot).toEqual(snapshot);
    expect(f.storage.commitLiveUpdateJournal(first)).toEqual({...accepted, result: {...accepted.result, replayed: true}});
    expect(f.raw.prepare("SELECT author_context_json FROM sync_relay_live_update_journal WHERE delivery_id=?").get("recipient-agent")?.author_context_json)
      .toBe(JSON.stringify(first.metadata.authorContext));
    const source = {source: {origin: {kind: "ownerDraft", agentDeclaration: agent}}} as NativeRestoreProposalReceipt["nativeSources"][number];
    const matches = (candidate: typeof source) => nativeSourceAuthorMatches(f.storage as StorageContext, candidate,
      accepted.admitted!.metadata, new RestoreHistoryBudget(1 << 20, 100));
    expect(matches(source)).toBe(true);
    expect(matches({source: {origin: {kind: "ownerDraft", agentDeclaration: {...agent, onBehalfOf: "reader"}}}} as typeof source)).toBe(false);

    // Changing the declaration on a new update cannot change the capped identity.
    const second = declare(f.capture(f.update("more", "recipient-more"), "recipient-more", {kind: "named", userId: "reader", grantId: "grant"}), {...agent, onBehalfOf: "other"});
    expect(f.storage.commitLiveUpdateJournal(second).admitted!.metadata.authorSnapshot).toEqual(snapshot);
    const suffix = Array.from({length: 16}, (_, index) => ({...accepted.admitted!.metadata,
      authorSnapshot: [snapshot[0]!, {...boundAgent, agentId: index === 0 ? agent.agentId : `writer-${index}`}]}));
    expect(limitLiveDeclaredAgents(suffix, first.expectedAuthority, accepted.admitted!.metadata.authorSnapshot!)).toEqual(snapshot);
  } finally {f.close();}
});

it("charges native request context before loading it for restore association", () => {
  const f = registered({deployment: true});
  try {
    const result = f.storage.commitLiveUpdateJournal(declare(f.capture(f.update(), "context-budget"), declared));
    expect(result.result.kind).toBe("accepted");
    const metadata = result.admitted!.metadata;
    const source = {source: {origin: {kind: "ownerDraft", agentDeclaration: declared}}} as NativeRestoreProposalReceipt["nativeSources"][number];
    const contextBytes = Number(f.raw.prepare("SELECT length(CAST(author_context_json AS BLOB)) AS bytes FROM sync_relay_live_update_journal WHERE delivery_id='context-budget'").get()!.bytes);
    expect(() => nativeSourceAuthorMatches(f.storage as unknown as StorageContext, source, metadata, new RestoreHistoryBudget(contextBytes - 1, 1)))
      .toThrow("Restore history exceeds configured byte bounds.");
    const budget = new RestoreHistoryBudget(contextBytes, 1);
    expect(nativeSourceAuthorMatches(f.storage as unknown as StorageContext, source, metadata, budget)).toBe(true);
    expect(budget.bytes).toBe(0);
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET author_context_json=? WHERE delivery_id='context-budget'").run(JSON.stringify({kind: "account", accountId: "x".repeat(1_000_000)})));
    expect(() => nativeSourceAuthorMatches(f.storage as unknown as StorageContext, source, metadata, new RestoreHistoryBudget(contextBytes, 1)))
      .toThrow("Restore history exceeds configured byte bounds.");
  } finally {f.close();}
});

it("binds an owner's declared agent to its delivery and refuses a changed, added, or removed declaration", () => {
  const f = registered({deployment: true});
  try {
    const first = declare(f.capture(f.update(), "declared"), declared);
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    expect(admittedAgent(accepted.admitted!.metadata)).toEqual(expectedAgent);
    // The declaration names an agent; the authenticated owner stays the authority.
    expect(accepted.admitted!.metadata.accepted.authority).toEqual(first.expectedAuthority);
    expect(JSON.parse(String(declarations(f)[0]!.author_snapshot_json))).toContainEqual(expectedAgent);
    expect(f.storage.commitLiveUpdateJournal(first).result).toMatchObject({kind: "accepted", replayed: true});

    // This cut carries the declared event, so admission compares it with storage.
    const plain = f.capture(f.update("more", "plain"), "plain");
    expect(admittedAgent(plain.cutToken.suffix[0]!.metadata)).toEqual(expectedAgent);
    const second = f.storage.commitLiveUpdateJournal(plain);
    expect(second.result).toMatchObject({kind: "accepted", replayed: false});
    expect(second.admitted!.metadata.accepted).not.toHaveProperty("agentDeclaration");

    const {authorContext: _removed, ...undeclared} = first.metadata;
    const before = f.journalRows();
    for (const retry of [declare(first, {...declared, agentId: "other-agent"}), declare(first, {...declared, onBehalfOf: null}),
      declare(first, {...declared, depth: 3}), {...first, metadata: undeclared}, declare(plain, declared)]) {
      expect(f.storage.commitLiveUpdateJournal(retry).result).toEqual({kind: "refused", reason: "delivery-conflict"});
    }
    expect(f.journalRows()).toEqual(before);
    expect(declarations(f)).toHaveLength(1);
  } finally { f.close(); }
});

it("refuses the removed declaration field before writing", () => {
  const f = registered({deployment: true});
  try {
    const named = f.capture(f.update(), "named", {kind: "named", userId: "reader", grantId: "grant"});
    const before = f.journalRows();
    expect(() => f.storage.commitLiveUpdateJournal({...named, metadata: {...named.metadata, agentDeclaration: declared}} as never)).toThrow();
    expect(f.journalRows()).toEqual(before);
    expect(declarations(f)).toEqual([]);
    expect(f.storage.commitLiveUpdateJournal(named).result).toMatchObject({kind: "accepted", replayed: false});
  } finally {f.close();}
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
      expect(admittedAgent(delivery)).toEqual(expectedAgent);
      const events = readAcceptedHistoryInterval(storage as unknown as StorageContext, {document, namespace,
        selected: {eventCount: 0, terminal: null, evidenceDigest: initialAcceptedHistoryDigest(namespace, document)},
        accepted: {eventCount, evidenceDigest: String(terminal.accepted_evidence_digest),
          terminal: {deliveryId: String(terminal.delivery_id), updateDigest: String(terminal.update_digest),
            journalCursor: through, acceptingHostEpoch: first.host.hostEpoch}}}, new RestoreHistoryBudget(1 << 30, 10_000));
      expect(events.map(event => admittedAgent(event.metadata) ?? null))
        .toEqual([expectedAgent, ...Array.from({length: events.length - 1}, () => null)]);
    };
    read(f.storage);
    f.close(); open = false;
    const reopened = openRelayDeployment(f.configPath).storage;
    try { read(reopened); } finally { reopened.close(); }
  } finally { if (open) f.close(); }
}, 120_000);
