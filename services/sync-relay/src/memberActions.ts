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
    if (
      typeof before === "string" &&
      typeof after === "string" &&
      before !== after &&
      selector.reach &&
      selector.reach.nearestRule(before) !== selector.reach.nearestRule(after)
    ) {
      throw relayError("share_op_rejected", "Ask an admin to move this.");
    }
    if (before == null && typeof after === "string") {
      let limiter = createLimits.get(owner);
      if (!limiter) {
        limiter = new TokenBucketLimiter(30, 0.5, 10_000);
        createLimits.set(owner, limiter);
      }
      if (charge && !limiter.allow(userId, nowMs))
        throw relayError("collection_write_rate_limited");
      if (
        !selector.reach ||
        selector.reach.folderLevel(accessRuleFolder(after)) === null ||
        !selector.reach.folderExists(accessRuleFolder(after))
      )
        throw relayError("share_op_rejected", "can't create here");
    }
  }
}
