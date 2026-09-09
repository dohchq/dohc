import { randomBytes } from "node:crypto";
import { parseRedeemedLiveTicket, type RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { LIVE_MEMBERSHIP_BASE_BYTES, LIVE_MEMBERSHIP_MEMBER_BYTES, type LiveMembershipFrame } from "@dohc/live-session-contract/live-frame";

export interface LiveMembershipPolicy {
  readonly maxSessions: number;
  readonly maxMembers: number;
  readonly maxSnapshotBytes: number;
}
export interface LiveMembershipSession {
  readonly invalidated: AbortSignal;
  snapshot(maxFrameBytes: number): LiveMembershipFrame;
  subscribe(onChange: () => void): () => void;
  close(): void;
}
interface Member {
  readonly pseudonym: string;
  readonly assertCurrent: () => void;
  readonly close: () => void;
  notify?: () => void;
}
interface Group { revision: number; readonly members: Set<Member> }

/** One relay deployment owns this registry. Join only after successful ticket redemption. */
export function createLiveMembershipRegistry(input: LiveMembershipPolicy, readAuthority: <T>(run: () => T) => T) {
  if (typeof readAuthority !== "function") throw new TypeError("Live membership requires an authority reader.");
  const policy = { maxSessions: input.maxSessions, maxMembers: input.maxMembers, maxSnapshotBytes: input.maxSnapshotBytes };
  for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid live membership policy.");
  if (policy.maxSnapshotBytes < LIVE_MEMBERSHIP_BASE_BYTES) throw new TypeError("Membership cannot encode its overflow indicator.");
  const tickets = new Set<string>(), groups = new Map<string, Group>();
  return {
    join(input: { ticket: RedeemedLiveTicket; invalidated: AbortSignal; assertCurrent(): void }): LiveMembershipSession {
      input.invalidated.throwIfAborted();
      input.assertCurrent();
      const ticket = parseRedeemedLiveTicket(input.ticket);
      if (tickets.size >= policy.maxSessions || tickets.has(ticket.ticketId)) throw new Error("Live membership is at capacity or the ticket is already joined.");
      const { binding } = ticket;
      const key = JSON.stringify([binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId, binding.restoreFenceGeneration, ticket.hostEpoch]);
      const group = groups.get(key) ?? { revision: 0, members: new Set<Member>() };
      const pseudonym = randomBytes(LIVE_MEMBERSHIP_MEMBER_BYTES).toString("hex");
      if ([...group.members].some(member => member.pseudonym === pseudonym) || group.revision === Number.MAX_SAFE_INTEGER) throw new Error("Live membership identity exhausted.");
      const lifetime = new AbortController(), source = input.invalidated, assertCurrent = input.assertCurrent.bind(input);
      let closed = false;
      function changed() {
        if (group.revision === Number.MAX_SAFE_INTEGER) {
          for (const member of [...group.members]) member.close();
          return;
        }
        group.revision++;
        for (const member of group.members) {
          try { member.notify?.(); } catch { /* A subscriber does not own other memberships. */ }
        }
      }
      function close() {
        if (closed) return;
        closed = true;
        source.removeEventListener("abort", close);
        member.notify = undefined;
        group.members.delete(member); tickets.delete(ticket.ticketId);
        if (!group.members.size) groups.delete(key);
        lifetime.abort(new Error("Live membership closed."));
        changed();
      }
      function check() {
        lifetime.signal.throwIfAborted();
        try { source.throwIfAborted(); assertCurrent(); }
        catch (error) { close(); throw error; }
      }
      const member: Member = { pseudonym, assertCurrent: check, close };
      groups.set(key, group); group.members.add(member); tickets.add(ticket.ticketId);
      source.addEventListener("abort", close, { once: true });
      if (source.aborted) { close(); source.throwIfAborted(); }
      changed();
      return {
        invalidated: lifetime.signal,
        snapshot(maxFrameBytes) {
          return readAuthority(() => {
            check();
            if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < LIVE_MEMBERSHIP_BASE_BYTES) throw new TypeError("Invalid membership frame bound.");
            // Idle peers can lose authority without sending another frame.
            for (const peer of group.members) {
              try { peer.assertCurrent(); } catch { peer.close(); }
            }
            check();
            const max = Math.min(policy.maxMembers, Math.floor((Math.min(maxFrameBytes, policy.maxSnapshotBytes) - LIVE_MEMBERSHIP_BASE_BYTES) / LIVE_MEMBERSHIP_MEMBER_BYTES));
            const members: string[] = [];
            for (const peer of group.members) {
              if (members.length === max) break;
              members.push(peer.pseudonym);
            }
            return { kind: "membership" as const, revision: group.revision, members, overflow: members.length < group.members.size };
          });
        },
        subscribe(onChange) {
          check();
          if (member.notify) throw new Error("Live membership already has a subscriber.");
          member.notify = onChange;
          return () => { if (member.notify === onChange) member.notify = undefined; };
        },
        close,
      };
    },
  };
}
