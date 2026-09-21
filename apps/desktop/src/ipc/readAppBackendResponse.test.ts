import { expect, it } from "vitest";
import { readAppBackendResponse } from "./readAppBackendResponse";

it("admits a recovery bundle larger than an operation reply without relaxing error bounds", async () => {
  const body = JSON.stringify({ bytes: "a".repeat(2 * 1024 * 1024) });
  expect(await readAppBackendResponse(new Response(body), "export", new AbortController().signal)).toEqual(JSON.parse(body));
  await expect(readAppBackendResponse(new Response(body), "invoke", new AbortController().signal)).rejects.toThrow(/limit/);
  await expect(readAppBackendResponse(new Response(body, { status: 500 }), "export", new AbortController().signal)).rejects.toThrow(/limit/);
});
