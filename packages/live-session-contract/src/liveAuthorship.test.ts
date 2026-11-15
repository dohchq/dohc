import { expect, it } from "vitest";
import {
  liveAuthorIdentity,
  parseAdmittedLiveAuthorSnapshot,
  parseAutomationDeclaration,
  parseLiveAuthorSnapshot,
} from "./liveAuthorship";

const declaration = {
  automationId: "collection:Tasks#mark",
  attribution: {
    actorKind: "automation" as const,
    onBehalfOf: "presser",
    depth: 1,
    run: { claimId: "claim", automationName: "Mark done" },
  },
};

it("accepts an exact unattributed marker with one stable identity", () => {
  const [marker] = parseLiveAuthorSnapshot([{ kind: "unattributed" }]);
  expect(marker).toEqual({ kind: "unattributed" });
  expect(liveAuthorIdentity(marker!)).toBe('["unattributed",null,""]');
  expect(() => parseLiveAuthorSnapshot([{ kind: "unattributed", humanId: "forged" }])).toThrow();
});

it("keeps a shared automation's presser and run in its canonical native snapshot", () => {
  const [author] = parseLiveAuthorSnapshot([{ kind: "automation", ...declaration }]);
  expect(author).toEqual({ kind: "automation", ...declaration });
  expect(JSON.stringify(author)).toBe(
    '{"kind":"automation","automationId":"collection:Tasks#mark","attribution":{"actorKind":"automation","onBehalfOf":"presser","depth":1,"run":{"claimId":"claim","automationName":"Mark done"}}}',
  );
  expect(liveAuthorIdentity(author!)).toBe('["automation","claim","collection:Tasks#mark"]');
  expect(() => parseLiveAuthorSnapshot([author, { kind: "agent", agentId: "agent" }])).toThrow();
});

it.each([
  { ...declaration, automationId: "" },
  { ...declaration, attribution: { ...declaration.attribution, actorKind: "human" } },
  { ...declaration, attribution: { ...declaration.attribution, onBehalfOf: null } },
  { ...declaration, attribution: { ...declaration.attribution, depth: 65 } },
  {
    ...declaration,
    attribution: {
      ...declaration.attribution,
      run: { ...declaration.attribution.run, automationName: "bad\nname" },
    },
  },
])("refuses malformed automation provenance", (value) => {
  expect(() => parseAutomationDeclaration(value)).toThrow();
});

it("reads a room save's list of everyone it names only under the owner, each once, and no automation in a list", () => {
  const ana = { kind: "human", humanId: "ana", humanName: "Ana" };
  const ben = { kind: "human", humanId: "ben", humanName: "Ben" };
  const link = { kind: "link", publicPrincipalId: "holder", label: "Anonymous" };
  const owner = { principalKind: "owner" },
    named = { principalKind: "named" };
  expect(parseAdmittedLiveAuthorSnapshot([ana, ben, link], owner)).toEqual([ana, ben, link]);
  expect(parseAdmittedLiveAuthorSnapshot([ana], named)).toEqual([ana]);
  expect(() => parseAdmittedLiveAuthorSnapshot([ana, ben], named)).toThrow(/Noncanonical/);
  expect(() => parseLiveAuthorSnapshot([ana, ben])).toThrow(/Noncanonical/);
  for (const list of [
    [ana, ben, ana],
    [ana, { kind: "automation", ...declaration }],
    [ana, { kind: "unattributed" }],
  ])
    expect(() => parseAdmittedLiveAuthorSnapshot(list, owner)).toThrow(/Noncanonical/);
});
