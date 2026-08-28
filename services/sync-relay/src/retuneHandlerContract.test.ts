import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

const retuneStart =
  'if (route.route === "share-link-retune" && request.method === "POST") {';
const retuneEnd = 'if (route.route === "share-link-retune") throw methodNotAllowed();';
const rotateStart =
  'if (route.route === "share-link-rotate" && request.method === "POST") {';
const rotateEnd = 'if (route.route === "share-link-rotate") throw methodNotAllowed();';

function sourceBetween(start: string, end: string): string {
  const startIndex = serverSource.indexOf(start);
  const endIndex = serverSource.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return serverSource.slice(startIndex, endIndex);
}

describe("Phase 2 share-link-retune handler contract", () => {
  it("passes validated View access to storage without a widening credential path", () => {
    const handlerSource = sourceBetween(retuneStart, retuneEnd);
    const rotateHandlerSource = sourceBetween(rotateStart, rotateEnd);

    expect(handlerSource).toContain(
      "const access = validatePhase2LinkAccess(input.access);",
    );
    expect(handlerSource).toContain("const result = storage.retuneShareGrant({");
    expect(handlerSource).toContain("access,");
    expect(handlerSource).toMatch(
      /return jsonResponse\(\{\s*ok: true,\s*\.\.\.linkGrantBody\(result\.grant\),?\s*\}\);/,
    );

    for (const forbidden of [
      "shareAccessRank",
      "widening",
      "mintCredential",
      "newLinkBearer",
      "composePublicLinkUrl",
      "let secret",
      "...(secret",
      "url:",
    ]) {
      expect(handlerSource, forbidden).not.toContain(forbidden);
    }

    expect(handlerSource).not.toContain('route.route === "share-link-rotate"');
    expect(serverSource.indexOf(rotateEnd)).toBeLessThan(serverSource.indexOf(retuneStart));
    expect(rotateHandlerSource).toContain("mintCredential");
    expect(rotateHandlerSource).toContain("newLinkBearer");
    expect(rotateHandlerSource).toContain("composePublicLinkUrl");
  });
});
