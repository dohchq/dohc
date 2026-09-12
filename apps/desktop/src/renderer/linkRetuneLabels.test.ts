import {expect, it} from "vitest";
import {shareAccessRank} from "@dohc/security-contract/share-selector";
import {linkRetuneLabels} from "./useRelayShareLinkPane";

it.each([
  ["view", "edit", "Turn on editing", "Turning on editing…"],
  ["comment", "edit", "Turn on editing", "Turning on editing…"],
  ["view", "comment", "Turn on comments", "Turning on comments…"],
  ["edit", "comment", "Use Comment access", "Changing access…"],
  ["comment", "comment", "Use Comment access", "Changing access…"],
  ["comment", "view", "Turn off comments", "Turning off comments…"],
  ["edit", "view", "Turn off editing", "Turning off editing…"],
] as const)("labels %s to %s by its actual direction", (from, to, action, pending) => {
  expect(linkRetuneLabels(shareAccessRank(to) > shareAccessRank(from), to, from)).toEqual({action, pending});
});
