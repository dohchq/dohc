import {expect, it} from "vitest";
import {liveAuthorIdentity, parseAutomationDeclaration, parseLiveAuthorSnapshot} from "./liveAuthorship";

const declaration = {automationId: "collection:Tasks#mark", attribution: {actorKind: "automation" as const,
  onBehalfOf: "presser", depth: 1, run: {claimId: "claim", automationName: "Mark done"}}};

it("keeps a shared automation's presser and run in its canonical native snapshot", () => {
  const [author] = parseLiveAuthorSnapshot([{kind: "automation", ...declaration}]);
  expect(author).toEqual({kind: "automation", ...declaration});
  expect(JSON.stringify(author)).toBe('{"kind":"automation","automationId":"collection:Tasks#mark","attribution":{"actorKind":"automation","onBehalfOf":"presser","depth":1,"run":{"claimId":"claim","automationName":"Mark done"}}}');
  expect(liveAuthorIdentity(author!)).toBe('["automation","claim","collection:Tasks#mark"]');
  expect(() => parseLiveAuthorSnapshot([author, {kind: "agent", agentId: "agent"}])).toThrow();
});

it.each([
  {...declaration, automationId: ""},
  {...declaration, attribution: {...declaration.attribution, actorKind: "human"}},
  {...declaration, attribution: {...declaration.attribution, onBehalfOf: null}},
  {...declaration, attribution: {...declaration.attribution, depth: 65}},
  {...declaration, attribution: {...declaration.attribution, run: {...declaration.attribution.run, automationName: "bad\nname"}}},
])("refuses malformed automation provenance", value => {
  expect(() => parseAutomationDeclaration(value)).toThrow();
});
