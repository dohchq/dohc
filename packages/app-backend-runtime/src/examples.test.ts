import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateAppOperation, initializeAppDatabase } from "./index.ts";
import type { EvaluateAppOperationInput, JsonValue } from "./index.ts";

const participant = { kind: "link", principalId: "participant", grantId: "public" };
const helper = {
  kind: "named",
  userId: "organizer",
  grantId: "private",
  access: "edit",
  helper: true,
};
const file = {
  fileId: "receipt",
  name: "receipt.png",
  contentType: "image/png",
  byteLength: 128,
  sha256: "a".repeat(64),
};
const read = (app: string, name: string) =>
  readFileSync(new URL(`../../../examples/${app}/${name}`, import.meta.url), "utf8");
async function fixture() {
  const tables = ["sessions", "registrations", "registration_sessions", "attendees"];
  const source = read("fundraiser", "backend.ts");
  let database = await initializeAppDatabase({
    schemaSql: read("fundraiser", "schema.sql"),
    tables,
  });
  let sequence = 0;
  async function call(
    operation: string,
    input: JsonValue = {},
    options: Partial<EvaluateAppOperationInput> = {},
  ) {
    const requestId = `request-${++sequence}`;
    const result = await evaluateAppOperation({
      source,
      tables,
      database,
      operation,
      input,
      caller: participant,
      requestId,
      nowMs: sequence * 1000,
      secret: randomBytes(32).toString("base64url"),
      files: [file],
      ...options,
    });
    database = result.database;
    return result;
  }
  return { call };
}

// These tests run the app source in the real isolated runtime and use real SQLite transactions.
// The host suite separately proves commit ordering and durable request replay.
describe("fundraiser app operations", () => {
  it("refuses hidden organizer reads and writes for named nonhelpers", async () => {
    const f = await fixture();
    for (const caller of [{ ...helper, helper: false }]) {
      for (const operation of ["listRegistrations", "setStatus"]) {
        await expect(f.call(operation, {}, { caller })).rejects.toMatchObject({
          refusal: { code: "forbidden" },
        });
      }
    }
  });
});
