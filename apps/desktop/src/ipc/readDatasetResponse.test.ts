import { expect, it } from "vitest";
import { readDatasetResponse } from "./readDatasetResponse";

it("preserves an operation correction but never confuses an authorization error with one", async () => {
  const signal = new AbortController().signal;
  await expect(readDatasetResponse(Response.json({ code: "capacity_full", message: "Choose another session." }, { status: 409 }), "invoke", signal))
    .rejects.toMatchObject({ name: "AppBackendRuntimeError", refusal: { code: "capacity_full", message: "Choose another session." } });
  const auth = { ok: false, code: "not_found", error: "not found" };
  expect(await readDatasetResponse(Response.json(auth, { status: 404 }), "invoke", signal)).toEqual(auth);
});

it("allows file and artifact bodies without relaxing operation or error response limits", async () => {
  const body = JSON.stringify({ bytes: "a".repeat(2 * 1024 * 1024) }), signal = new AbortController().signal;
  expect(await readDatasetResponse(new Response(body), "file", signal)).toEqual(JSON.parse(body));
  expect(await readDatasetResponse(new Response(body), "artifacts", signal)).toEqual(JSON.parse(body));
  await expect(readDatasetResponse(new Response(body), "invoke", signal)).rejects.toThrow(/limit/);
  await expect(readDatasetResponse(new Response(body, { status: 500 }), "file", signal)).rejects.toThrow(/limit/);
});
