import { TokenBucketLimiter } from "@dohc/service-http";
import { accessRuleFolder, isAccessRuleRelatedPath } from "@dohc/security-contract/access-rules";
import { asRecord } from "@dohc/workspace-core";
import { isWorkspaceSelector, type AnyShareSelector } from "./shareFilter";
import { relayError } from "./errors";

const createLimits = new WeakMap<object, TokenBucketLimiter>();

/** Refusals depend on the caller's reach, before looking up a target's existence. */
export function assertMemberChanges(
  owner: object,
  selector: AnyShareSelector,
  userId: string,
  raw: unknown,
  nowMs: number,
  charge = false,
): void {
  if (!isWorkspaceSelector(selector) || !Array.isArray(raw)) return;
  for (const entry of raw) {
    const change = asRecord(entry);
    if (!change) continue;
    const before = change.basedOnPath,
      after = change.afterPath;
    if ([before, after].some((path) => typeof path === "string" && isAccessRuleRelatedPath(path)))
      throw relayError("share_op_rejected");
    if (selector.role !== "member") continue;
    const reach = selector.reach;
    const refuse = (message?: string): never => {
      // Only refusals cost a token: they are what a member could probe with.
      if (charge && !limiter(owner).allow(userId, nowMs))
        throw relayError("share_access_rate_limited");
      throw relayError("share_op_rejected", message);
    };
    const moves = typeof before === "string" && typeof after === "string" && before !== after;
    const creates = before == null && typeof after === "string";
    // With the bucket empty, every create and move waits, so a 429 can't say
    // whether a path is hidden.
    if (charge && (moves || creates) && !limiter(owner).has(userId, nowMs))
      throw relayError("share_access_rate_limited");
    if (moves) {
      if (!reach || reach.levelAt(before) === null || reach.levelAt(after) === null) refuse();
      // Both ends are visible, so naming the rule boundary shows nothing hidden.
      else if (reach.nearestRule(before) !== reach.nearestRule(after))
        refuse("Ask an admin to move this.");
    }
    if (creates && (!reach || reach.folderLevel(accessRuleFolder(after)) === null))
      refuse("can't create here");
  }
}

// Per storage instance: the relay has one writer process, so this bounds a
// member across all of their requests.
function limiter(owner: object): TokenBucketLimiter {
  let found = createLimits.get(owner);
  if (!found) {
    found = new TokenBucketLimiter(30, 0.5, 10_000);
    createLimits.set(owner, found);
  }
  return found;
}
