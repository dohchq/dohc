import {expect, it} from "vitest";
import {
  liveAuthorIdentity,
  parseLiveAuthorSnapshot,
  type AdmittedLiveUpdateMetadata,
  type LiveAuthorEntry,
  type LiveAuthorSnapshot,
  type LiveUpdateStructRange,
} from "@dohc/live-session-contract";
import {assessLiveAuthorWindow, liveAuthorCoverageCheckpointDue, liveAuthorCheckpointAnticipated, limitLiveDeclaredAgents} from "./liveAuthorWindow";

const range = (clientId: number, startClock = 0, endClock = 1): LiveUpdateStructRange => ({clientId, startClock, endClock});
const human = (id: string, name = id): LiveAuthorEntry => ({kind: "human", humanId: id, humanName: name});
const candidate = (authorSnapshot: LiveAuthorSnapshot, firstSeen = [range(1)], firstSeenDeletes: LiveUpdateStructRange[] = []) =>
  ({authorSnapshot, firstSeen, firstSeenDeletes});
const admitted = (authorSnapshot: LiveAuthorSnapshot, firstSeen = [range(1)], firstSeenDeletes: LiveUpdateStructRange[] = []): AdmittedLiveUpdateMetadata =>
  ({accepted: {} as AdmittedLiveUpdateMetadata["accepted"], canonicalVersion: 2, authorSnapshot, firstSeen, firstSeenDeletes});
const authors = (count: number) => Array.from({length: count}, (_, index) => admitted([human(String(index))], [range(index)]));

it("credits new structs and deletion-only edits, but no-op or unnamed rows credit nobody", () => {
  const result = assessLiveAuthorWindow([
    admitted([human("alice")], [range(3)]),
    admitted([human("bob")], [], [range(3, 1, 2)]),
    admitted([human("forwarder")], [], []),
    {accepted: {} as AdmittedLiveUpdateMetadata["accepted"], firstSeen: [range(4)]},
  ], candidate([human("opener")], [], []));
  expect(result.identityCount).toBe(2);
  expect(result.coverage).toEqual([
    {author: human("alice"), structRanges: [range(3)], deletionRanges: []},
    {author: human("bob"), structRanges: [], deletionRanges: [range(3, 1, 2)]},
  ]);
  expect(assessLiveAuthorWindow([], candidate([], [range(4)])).identityCount).toBe(0);
});

it("unions and normalizes ranges without changing admitted rows", () => {
  const suffix = [admitted([human("alice", "First name")], [range(2, 3, 7), range(1, 1, 3)], [range(7, 1, 4)])];
  const before = structuredClone(suffix);
  const result = assessLiveAuthorWindow(suffix, candidate([human("alice", "Later name")], [range(1, 3, 6), range(2, 1, 4)], [range(7, 4, 8), range(7, 2, 5)]));
  expect(result.coverage).toEqual([{author: human("alice", "First name"), structRanges: [range(1, 1, 6), range(2, 1, 7)], deletionRanges: [range(7, 1, 8)]}]);
  expect(suffix).toEqual(before);
});

it("keeps public link identities separate from accounts and retains their first labels", () => {
  const link: LiveAuthorEntry = {kind: "link", publicPrincipalId: "same-id", label: "同じ名前"};
  const result = assessLiveAuthorWindow([
    admitted([human("same-id", "同じ名前")]),
    admitted([link]),
  ], candidate([{...link, label: "Changed label"}]));
  expect(result.identityCount).toBe(2);
  expect(result.coverage.map(entry => entry.author)).toEqual([human("same-id", "同じ名前"), link]);
  expect(result.authorBytes).toBe(Buffer.byteLength(JSON.stringify([human("same-id", "同じ名前"), link]), "utf8"));
});

it("deduplicates scoped identities, preserves names and reserves agent depth growth", () => {
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "worker", agentName: "First agent", onBehalfOf: "alice"};
  const first = assessLiveAuthorWindow([], candidate([agent]));
  expect(first.authorBytes).toBe(Buffer.byteLength(JSON.stringify([agent])) + ',"depth":64'.length);
  const result = assessLiveAuthorWindow([
    admitted([agent]),
    admitted([{...agent, agentName: "Second agent", depth: 64}]),
    admitted([{...agent, onBehalfOf: "bob", depth: 1}]),
  ], candidate([{...agent, agentName: "Third agent", depth: 2}]));
  expect(result.identityCount).toBe(2);
  const covered = result.coverage.find(entry => liveAuthorIdentity(entry.author) === liveAuthorIdentity(agent));
  expect(covered?.author).toEqual({...agent, depth: 64});
  expect(assessLiveAuthorWindow([admitted([agent])], candidate([{...agent, depth: 64}])).authorBytes).toBe(first.authorBytes);
});

it("checkpoints at 960 identities and refuses only a new identity beyond 1024", () => {
  expect(liveAuthorCheckpointAnticipated(authors(957), [human("new")])).toBe(false);
  expect(liveAuthorCheckpointAnticipated(authors(958), [human("new")])).toBe(true);
  expect(assessLiveAuthorWindow(authors(958), candidate([human("new")])).checkpointDue).toBe(false);
  const due = assessLiveAuthorWindow(authors(959), candidate([human("new")]));
  expect(due.identityCount).toBe(960);
  expect(due.checkpointDue).toBe(true);
  expect(liveAuthorCoverageCheckpointDue(due.coverage)).toBe(true);
  expect(due.refused).toBe(false);
  expect(assessLiveAuthorWindow(authors(1023), candidate([human("new")])).refused).toBe(false);
  const full = authors(1024);
  expect(assessLiveAuthorWindow(full, candidate([human("new")])).refused).toBe(true);
  expect(assessLiveAuthorWindow(full, candidate([human("0", "A different name")])).refused).toBe(false);
  expect(assessLiveAuthorWindow(full, candidate([human("new")], [], [])).refused).toBe(false);
  expect(assessLiveAuthorWindow(full, candidate([human("0"), {kind: "agent", agentId: "new"}])).refused).toBe(true);
});

function byteBoundaryWindow(target: number, agent?: LiveAuthorEntry) {
  const prefix = Array.from({length: Math.floor(target / 1048)}, (_, index) => human(String(index), '"'.repeat(500)));
  const final = human("last", "");
  const missing = target - Buffer.byteLength(JSON.stringify([...prefix, final, ...(agent ? [agent] : [])])) - (agent ? 1 : 0);
  if (missing < 0 || missing > 1024) throw new Error("Invalid byte-boundary fixture.");
  const author = human("last", '"'.repeat(Math.floor(missing / 2)) + "x".repeat(missing % 2));
  parseLiveAuthorSnapshot([author]);
  for (const entry of prefix) parseLiveAuthorSnapshot([entry]);
  return {suffix: [...prefix.map(entry => admitted([entry])), ...(agent ? [admitted([agent])] : [])], author};
}

it("uses escaped UTF-8 author bytes at the 96 KiB checkpoint threshold", () => {
  const {suffix, author} = byteBoundaryWindow(96 * 1024);
  const at = assessLiveAuthorWindow(suffix, candidate([author]));
  expect(at.authorBytes).toBe(96 * 1024);
  expect(at.checkpointDue).toBe(true);
  expect(liveAuthorCoverageCheckpointDue(at.coverage)).toBe(true);
  const smaller = author.kind === "human" ? {...author, humanName: author.humanName.slice(0, -1)} : author;
  expect(assessLiveAuthorWindow(suffix, candidate([smaller])).checkpointDue).toBe(false);
  const parked = [...suffix, admitted([smaller])];
  expect(liveAuthorCheckpointAnticipated(parked, [human("new")])).toBe(true);
  expect(liveAuthorCheckpointAnticipated(parked, [smaller])).toBe(false);
  expect(liveAuthorCheckpointAnticipated(parked, [])).toBe(false);
  expect(liveAuthorCheckpointAnticipated([], [human("new")])).toBe(false);
});

it("does not retain state in the identity band for known accounts, links or scoped agents", () => {
  const link: LiveAuthorEntry = {kind: "link", publicPrincipalId: "public_link", label: "Sam"};
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "writer", onBehalfOf: "0", depth: 1};
  const suffix = [...authors(956), admitted([link, agent])];
  expect(liveAuthorCheckpointAnticipated(suffix, [])).toBe(false);
  expect(liveAuthorCheckpointAnticipated(suffix, [human("0", "Renamed")])).toBe(false);
  expect(liveAuthorCheckpointAnticipated(suffix, [{...link, label: "Renamed"}, {...agent, agentName: "Renamed", depth: 64}])).toBe(false);
  expect(liveAuthorCheckpointAnticipated(suffix, [human("new")])).toBe(true);
  expect(liveAuthorCheckpointAnticipated(suffix, [{...link, publicPrincipalId: "public_new"}])).toBe(true);
  expect(liveAuthorCheckpointAnticipated(suffix, [human("0"), {...agent, onBehalfOf: "new"}])).toBe(true);
});

it("retains state if the existing window is already due, even without a new identity", () => {
  expect(liveAuthorCheckpointAnticipated(authors(960), [])).toBe(true);
});

it("counts agent identities per authenticated principal and resets the cap with the consumed window", () => {
  const authority = {principalKind: "owner" as const, principalId: "alice", grantId: null, grantGeneration: null};
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "writer", onBehalfOf: "alice"};
  const snapshot: LiveAuthorSnapshot = [human("alice"), agent];
  const suffix = Array.from({length: 16}, (_, index) => ({...admitted([human("alice"), {...agent, agentId: `writer-${index}`}]),
    accepted: {...admitted([]).accepted, authority}}));
  expect(limitLiveDeclaredAgents(suffix, authority, snapshot)).toEqual([human("alice")]);
  expect(limitLiveDeclaredAgents(suffix, {...authority, principalKind: "named", grantId: "grant", grantGeneration: 1}, snapshot)).toEqual([human("alice")]);
  expect(limitLiveDeclaredAgents(suffix, {...authority, principalId: "bob"}, snapshot)).toEqual(snapshot);
  expect(limitLiveDeclaredAgents(suffix, authority, [human("alice"), {...agent, agentId: "writer-0", agentName: "Renamed", depth: 64}])).toHaveLength(2);
  expect(limitLiveDeclaredAgents([], authority, snapshot)).toEqual(snapshot);
  const changedScope = [human("alice"), {...agent, agentId: "writer-0", onBehalfOf: "bob"}];
  expect(limitLiveDeclaredAgents(suffix, authority, changedScope)).toEqual([human("alice")]);
});

it("shares a link grant's cap across all its principals, but not across grants", () => {
  const authority = {principalKind: "link" as const, principalId: "principal-new", grantId: "grant", grantGeneration: 1};
  const link: LiveAuthorEntry = {kind: "link", publicPrincipalId: "public_new", label: "Sam"};
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "new"};
  const suffix = Array.from({length: 16}, (_, index) => ({...admitted([{kind: "agent" as const, agentId: `writer-${index}`}]),
    accepted: {...admitted([]).accepted, authority: {...authority, principalId: `principal-${index}`}}}));
  expect(limitLiveDeclaredAgents(suffix.slice(0, 15), authority, [link, agent])).toEqual([link, agent]);
  expect(limitLiveDeclaredAgents(suffix, authority, [link, agent])).toEqual([link]);
  expect(limitLiveDeclaredAgents(suffix, {...authority, grantId: "another-grant"}, [link, agent])).toEqual([link, agent]);
  expect(limitLiveDeclaredAgents(suffix, authority, [link, {...agent, agentId: "writer-0"}])).toHaveLength(2);
  expect(limitLiveDeclaredAgents([], authority, [link, agent])).toHaveLength(2);
});

it("caps new declared agents at 32 across the document and ignores rows with no new content", () => {
  const authority = {principalKind: "owner" as const, principalId: "new-account", grantId: null, grantGeneration: null};
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "writer", onBehalfOf: "new-account"};
  const snapshot: LiveAuthorSnapshot = [human("new-account"), agent];
  const suffix = Array.from({length: 32}, (_, index) => ({...admitted([{...agent, onBehalfOf: `account-${index}`}],
    index % 2 ? [] : [range(index)], index % 2 ? [range(index)] : []),
    accepted: {...admitted([]).accepted, authority: {...authority, principalId: `account-${index}`}}}));
  expect(limitLiveDeclaredAgents(suffix.slice(0, 31), authority, snapshot)).toEqual(snapshot);
  expect(limitLiveDeclaredAgents(suffix, authority, snapshot)).toEqual([human("new-account")]);
  expect(limitLiveDeclaredAgents(suffix, authority, [human("new-account"), {...agent, onBehalfOf: "account-0"}])).toHaveLength(2);
  const noop = {...suffix[31]!, firstSeen: [], firstSeenDeletes: []};
  expect(limitLiveDeclaredAgents([...suffix.slice(0, 31), noop], authority, snapshot)).toEqual(snapshot);
  expect(limitLiveDeclaredAgents([], authority, snapshot)).toEqual(snapshot);
});

it("derives a stored coverage checkpoint trigger with the agent growth reserve", () => {
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "worker", depth: 1};
  const {suffix, author} = byteBoundaryWindow(96 * 1024, agent);
  const result = assessLiveAuthorWindow(suffix, candidate([author]));
  expect(Buffer.byteLength(JSON.stringify(result.coverage.map(entry => entry.author)))).toBe(96 * 1024 - 1);
  expect(liveAuthorCoverageCheckpointDue(result.coverage)).toBe(true);
});

it("admits exactly 128 KiB, refuses a new identity above it, and permits known depth growth", () => {
  const {suffix, author} = byteBoundaryWindow(128 * 1024);
  const at = assessLiveAuthorWindow(suffix, candidate([author]));
  expect(at.authorBytes).toBe(128 * 1024);
  expect(at.refused).toBe(false);
  const bigger = author.kind === "human" ? {...author, humanName: author.humanName + "x"} : author;
  expect(assessLiveAuthorWindow(suffix, candidate([bigger])).refused).toBe(true);
  const agent: LiveAuthorEntry = {kind: "agent", agentId: "worker", depth: 1};
  const withAgent = byteBoundaryWindow(128 * 1024, agent);
  const full = [...withAgent.suffix, admitted([withAgent.author])];
  const grown = assessLiveAuthorWindow(full, candidate([{...agent, depth: 64}]));
  expect(grown.authorBytes).toBe(128 * 1024);
  expect(grown.refused).toBe(false);
});

it("starts a fresh bounded window after a consumed checkpoint", () => {
  const prior = assessLiveAuthorWindow(authors(1023), candidate([human("terminal")]));
  expect(prior.identityCount).toBe(1024);
  const next = assessLiveAuthorWindow([], candidate([human("next")]));
  expect(next.coverage).toEqual([{author: human("next"), structRanges: [range(1)], deletionRanges: []}]);
  expect(next.checkpointDue).toBe(false);
  expect(liveAuthorCoverageCheckpointDue(next.coverage)).toBe(false);
  expect(next.refused).toBe(false);
  const row = {...admitted([human("next")]), checkpointCoverage: prior.coverage};
  expect(assessLiveAuthorWindow([row], candidate([human("after")])).identityCount).toBe(2);
});
