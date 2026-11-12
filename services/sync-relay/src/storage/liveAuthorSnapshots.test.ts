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
import {seedLinkAgent} from "../liveTickets.test-helper.js";
import {AGENT_ACCESS_TOKEN_TTL_MS} from "./agentConnections.js";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {agentAccessCheck} from "../linkAuthority.js";
import {SERVICE_HOST_ENROLLMENTS} from "./serviceHostEnrollment.js";

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

it("records a connected agent's last action when its live edit commits, never when its access is checked", () => {
  const f = registered({deployment: true});
  try {
    let agent!: ReturnType<typeof seedLinkAgent>;
    f.write(db => {
      db.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL WHERE grant_id='grant'");
      agent = seedLinkAgent(db, {connectionId: "agent-connection", workspaceId: "workspace", shareId: "share", grantId: "grant",
        generation: 4, expiresAtMs: Date.now() + AGENT_ACCESS_TOKEN_TTL_MS});
    });
    const lastAction = () => f.raw.prepare("SELECT last_action_at_ms FROM sync_relay_agent_connections WHERE connection_id=?").get(agent.connectionId);
    // Capturing the edit checks the agent's access, as each wake does.
    const edit = f.capture(f.update(), "agent-edit", agent.actor);
    expect(lastAction()).toEqual({last_action_at_ms: null});
    const accepted = f.storage.commitLiveUpdateJournal(edit);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    expect(accepted.admitted!.metadata.accepted.authority).toMatchObject({principalKind: "link", principalId: agent.principalId});
    expect(lastAction()).toEqual({last_action_at_ms: edit.receivedAtMs});
  } finally {f.close();}
});

const personalHost = {mode: "service", hostId: "service", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection"} as const;
const helperId = `p-${"h".repeat(26)}`;
/**
 * The owner's personal agent "Helper", signed in and reaching the workspace
 * at Edit as its sign-in commits it, on a self-hosted live host that enrolled
 * the document. Returns the agent's live actor.
 */
function personalEditor(f: Fixture) {
  const check = agentAccessCheck("a".repeat(43), "https://share.example.test/mcp/agent/w/workspace", new Uint8Array(32).fill(7))!;
  f.storage.claimWorkspaceIdentity({workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream"});
  f.write(db => {
    db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
      created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes) VALUES ('workspace',?,?,'owner',NULL,'epoch','stream',1,1,1,1,64)`)
      .run(f.input.evidence.document.objectId, f.input.evidence.currentPath);
    db.prepare("INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms) VALUES (?,'owner','Helper','olive','active',1,0)")
      .run(helperId);
    db.prepare(`INSERT INTO sync_relay_personal_agent_connections(connection_id,agent_id,owner_user_id,client_id,resource_hash,agent_epoch,fence_epoch,connected_at_ms)
      VALUES ('helper-connection',?,'owner','client',?,1,0,0)`).run(helperId, check.resourceHash);
    db.prepare("INSERT INTO sync_relay_personal_agent_tokens(token_hash,connection_id,kind,issued_at_ms,expires_at_ms) VALUES (?,'helper-connection','access',0,?)")
      .run(check.accessTokenHash, 4_000_000_000_000);
    db.prepare("INSERT INTO sync_relay_personal_agent_reach(agent_id,workspace_id,level,start_seq) VALUES (?,'workspace','edit',0)").run(helperId);
  });
  return {kind: "personal" as const, workspaceId: "workspace", agentId: helperId, connectionId: "helper-connection",
    accessTokenHash: check.accessTokenHash, resourceHash: check.resourceHash, fenceEpoch: 0};
}

// Proves: the journal admits a personal agent's live edit only on behalf of
// the workspace's owner. Another account's agent is provenance-refused, and a
// context the agent declares changes neither its snapshot nor its replay.
it("admits a personal agent's live edit on behalf of its owner, and never by what it declares", () => {
  const f = registered({deployment: true, host: personalHost});
  try {
    const actor = personalEditor(f);
    const helper = [{kind: "agent", agentId: helperId, agentName: "Helper", onBehalfOf: "owner", depth: 0}];
    const declaring = (input: Input, authorContext: import("@dohc/live-session-contract").LiveAuthorContext): Input =>
      ({...input, metadata: {...input.metadata, authorContext}});
    const human = {kind: "account" as const, accountId: "reader"};
    const otherAgent = {kind: "signed-out" as const, agent: {agentId: "other-agent", agentName: "Other", onBehalfOf: "reader", depth: 1}};
    const anotherPersonal = {kind: "account" as const, accountId: "owner", agent: {agentId: `p-${"o".repeat(26)}`, depth: 0}};
    const lastAction = () => f.raw.prepare("SELECT last_action_at_ms FROM sync_relay_personal_agents WHERE agent_id=?").get(helperId);
    const bytes = f.update("title", "Helper");
    // The edit by an agent whose record names another account, which its connection still authorizes here.
    f.write(db => { db.prepare("UPDATE sync_relay_personal_agents SET owner_user_id='other-owner' WHERE agent_id=?").run(helperId); });
    expect(f.storage.commitLiveUpdateJournal(f.capture(bytes, "helper-first", actor)).result).toEqual({kind: "refused", reason: "provenance-refused"});
    expect(lastAction()).toEqual({last_action_at_ms: null});
    f.write(db => { db.prepare("UPDATE sync_relay_personal_agents SET owner_user_id='owner' WHERE agent_id=?").run(helperId); });
    const first = f.capture(bytes, "helper-first", actor);
    expect(first.expectedAuthority).toEqual({principalKind: "personal", principalId: helperId, grantId: null, grantGeneration: null});
    const accepted = f.storage.commitLiveUpdateJournal(first);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    expect(accepted.admitted!.metadata.accepted.authority).toEqual(first.expectedAuthority);
    expect(accepted.admitted!.metadata.authorSnapshot).toEqual(helper);
    expect(lastAction()).toEqual({last_action_at_ms: first.receivedAtMs});
    // A replay that declares someone else is still the same delivery.
    expect(f.storage.commitLiveUpdateJournal(declaring(first, human)).result).toMatchObject({kind: "accepted", replayed: true});
    for (const [index, context] of [human, otherAgent, anotherPersonal].entries()) {
      const declared = declaring(f.capture(f.update("title", `Declared ${index}`), `helper-declared-${index}`, actor), context);
      const admitted = f.storage.commitLiveUpdateJournal(declared);
      expect(admitted.result).toMatchObject({kind: "accepted", replayed: false});
      expect(admitted.admitted!.metadata.authorSnapshot).toEqual(helper);
    }
    expect(f.raw.prepare("SELECT delivery_id, author_context_json, author_snapshot_json FROM sync_relay_live_update_journal WHERE delivery_id LIKE 'helper-%' ORDER BY journal_cursor").all()
      .map(row => ({...row, author_snapshot_json: JSON.parse(String(row.author_snapshot_json))})))
      .toEqual(["helper-first", "helper-declared-0", "helper-declared-1", "helper-declared-2"].map(delivery_id =>
        ({delivery_id, author_context_json: null, author_snapshot_json: helper})));
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
