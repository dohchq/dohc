import {expect, it} from "vitest";
import {namedAppTarget} from "./namedAppRoute";

const publication = "a".repeat(64);
it.each([
  [`/s/apps/ws_1-A/${publication}`, {workspaceId: "ws_1-A", publicationId: publication}],
  [`/s/apps/${"w".repeat(128)}/${publication}/`, {workspaceId: "w".repeat(128), publicationId: publication}],
])("parses %s", (pathname, target) => expect(namedAppTarget(pathname)).toEqual(target));
it.each([
  "/s/apps", "/s/apps/", `/s/apps//${publication}`, `/s/apps/ws/${publication}/extra`, `/s/apps/${"w".repeat(129)}/${publication}`,
  `/s/apps/ws%2F../${publication}`, `/s/apps/ws.dot/${publication}`, `/s/apps/ws/${publication.slice(1)}`, `/s/apps/ws/${"A".repeat(64)}`,
  `/s/apps/ws/${"g".repeat(64)}`, `/s/edit/${publication}`, `/apps/ws/${publication}`, `/s/apps/ws/${publication}?x=1`,
])("rejects %s", pathname => expect(namedAppTarget(pathname)).toBeNull());
