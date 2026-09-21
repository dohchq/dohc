import { describe, expect, it } from "vitest";
import type { CollectionSchema } from "@dohc/workspace-contracts/collection";
import { generateAppForm } from "./appFormGenerator";

const schema: CollectionSchema = { name: "Registrations", description: null, views: [], fields: [
  { name: "Name", type: "text" }, { name: "Payment", type: "select", options: ["Pending", "Verified"] },
] };
const generate = (overrides: Partial<Parameters<typeof generateAppForm>[0]> = {}) => generateAppForm({
  schema, schemaSource: "Participants", appRoot: "apps/registration", publicFields: ["Name"], ...overrides,
});

describe("Collection field definitions to app source", () => {
  it("generates one private response store and does not expose organizer fields in the frontend", () => {
    const { files } = generate();
    const manifest = JSON.parse(files["app.publish.json"]!);
    expect(manifest).not.toHaveProperty("collection");
    expect(manifest.backend).toMatchObject({ dataPath: "apps/registration/responses.sqlite", operations: [
      { name: "submit", access: "link", readOnly: false },
      { name: "listResponses", access: "helper", readOnly: true },
      { name: "editResponse", access: "helper", readOnly: false },
    ] });
    expect(manifest.inputs).toEqual(["apps/registration/frontend.js", "apps/registration/frontend.css", "apps/registration/backend.js", "apps/registration/schema.sql"]);
    expect(files["schema.sql"]).toContain("Existing records are not copied");
    expect(files["frontend.js"]).not.toMatch(/Payment|Verified|listResponses|editResponse/);
    expect(files["backend.js"]).toContain('"name":"Payment"');
  });

  it.each(["multi-select", "person", "relation"] as const)("refuses unsupported %s fields, including private ones", type => {
    const field = type === "multi-select" ? { name: "Extra", type, options: ["One"] } : type === "relation"
      ? { name: "Extra", type, collection: "Other", many: false } : { name: "Extra", type };
    expect(() => generate({ schema: { ...schema, fields: [...schema.fields, field] } })).toThrow(`does not support ${type}`);
  });

  it.each([[], ["Missing"], ["Name", "Name"]].map(publicFields => ({ publicFields })))("requires explicit distinct public field names $publicFields", ({ publicFields }) => {
    expect(() => generate({ publicFields })).toThrow(/public field/);
  });

  it.each(["id", "version", "createdAt", "__proto__", "prototype", "constructor"])("refuses metadata/prototype field %s", name => {
    expect(() => generate({ schema: { ...schema, fields: [{ name, type: "text" }] }, publicFields: [name] })).toThrow(/Rename/);
  });

  it("maps labels to fixed SQL identifiers without collisions or executable interpolation", () => {
    const fields = ["First name", "First-name", "名", 'x\"; DROP TABLE responses; --'].map(name => ({ name, type: "text" as const }));
    const { files } = generate({ schema: { ...schema, fields }, publicFields: fields.map(field => field.name) });
    expect(files["schema.sql"]).toContain("field_4 TEXT");
    expect(files["schema.sql"]).not.toContain("DROP TABLE");
    expect(files["frontend.js"]).toContain('x\\\"; DROP TABLE');
  });

  it.each(["../outside", "bad app", "app/../other", "/absolute", ".dohc/generated"])("refuses nonpublishable app path %s", appRoot => {
    expect(() => generate({ appRoot })).toThrow(/workspace paths/);
  });

  it("bounds schema metadata and preserves input objects", () => {
    const frozen = structuredClone(schema);
    Object.freeze(frozen.fields);
    generate({ schema: frozen });
    expect(frozen).toEqual(schema);
    expect(() => generate({ schema: { ...schema, fields: Array.from({ length: 25 }, (_, i) => ({ name: `Field ${i}`, type: "text" })) } })).toThrow(/1 to 24/);
    expect(() => generate({ schema: { ...schema, fields: [{ name: "Name", type: "select", options: [] }] } })).toThrow(/distinct/);
  });
});
