import { expect, it } from "vitest";
import { datasetResponseAction, readDatasetResponse } from "./readDatasetResponse";
import { APP_BACKEND_PROFILE_HEADER } from "@dohc/security-contract/app-backend";

it("preserves an operation correction but never confuses an authorization error with one", async () => {
  const signal = new AbortController().signal;
  await expect(
    readDatasetResponse(
      Response.json({ code: "capacity_full", message: "Choose another session." }, { status: 409 }),
      "invoke",
      signal,
    ),
  ).rejects.toMatchObject({
    name: "AppBackendRuntimeError",
    refusal: { code: "capacity_full", message: "Choose another session." },
  });
  const auth = { ok: false, code: "not_found", error: "not found" };
  expect(await readDatasetResponse(Response.json(auth, { status: 404 }), "invoke", signal)).toEqual(
    auth,
  );
});

it("allows file and artifact bodies without relaxing operation or error response limits", async () => {
  const body = JSON.stringify({ bytes: "a".repeat(2 * 1024 * 1024) }),
    signal = new AbortController().signal;
  expect(await readDatasetResponse(new Response(body), "file", signal)).toEqual(JSON.parse(body));
  expect(await readDatasetResponse(new Response(body), "artifacts", signal)).toEqual(
    JSON.parse(body),
  );
  // A change's response holds its result and the journal for the owner's kept copy, and no more.
  const change = JSON.stringify({ bytes: "a".repeat(3 * 1024 * 1024) });
  await expect(readDatasetResponse(new Response(change), "invoke", signal)).rejects.toThrow(
    /limit/,
  );
  await expect(
    readDatasetResponse(new Response(body, { status: 500 }), "file", signal),
  ).rejects.toThrow(/limit/);
});

it("recognizes workspace local-apps routes so error codes and response bounds apply", async () => {
  const signal = new AbortController().signal;
  expect(datasetResponseAction("/sync/w/local-apps")).toBe("local-app");
  expect(datasetResponseAction("/sync/w/local-apps/extra")).toBeNull();
  const missing = { ok: false, code: "not_found", error: "not found" };
  expect(
    await readDatasetResponse(Response.json(missing, { status: 404 }), "local-app", signal),
  ).toEqual(missing);
  const oversized = JSON.stringify({ bytes: "a".repeat(2 * 1024 * 1024) });
  await expect(
    readDatasetResponse(new Response(oversized, { status: 200 }), "local-app", signal),
  ).rejects.toThrow(/limit/);
});

it("reads an owner bulk result with the relay's profile header", async () => {
  const signal = new AbortController().signal;
  const value = {
    result: Array.from({ length: 20_000 }, () => "x".repeat(120)),
    revision: 1,
    replayed: false,
  };
  await expect(readDatasetResponse(Response.json(value), "invoke", signal)).rejects.toThrow(
    /limit.*bytes/,
  );
  const headers = { [APP_BACKEND_PROFILE_HEADER]: "bulk" };
  await expect(
    readDatasetResponse(Response.json(value, { headers }), "invoke", signal),
  ).resolves.toEqual({ ...value, profile: "bulk" });
});
