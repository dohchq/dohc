import { describe, expect, it } from "vitest";
import { parseExcalidrawDocument } from "./excalidrawDocument";

describe("parseExcalidrawDocument", () => {
  it("keeps embedded file data in a portable Excalidraw document", () => {
    const embedded = {
      id: "file-1",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
      created: 1,
      lastRetrieved: 1,
    };
    const document = parseExcalidrawDocument(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [{ id: "image-1", type: "image", fileId: "file-1" }],
        appState: { viewBackgroundColor: "#ffffff" },
        files: { "file-1": embedded },
      }),
    );

    expect(document.files["file-1"]).toEqual(embedded);
    expect(document.elements).toHaveLength(1);
  });

  it("accepts omitted optional scene sections as empty sections", () => {
    expect(parseExcalidrawDocument('{"type":"excalidraw"}')).toMatchObject({
      elements: [],
      appState: {},
      files: {},
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["another JSON file", '{"type":"other","elements":[]}'],
    ["an invalid elements list", '{"type":"excalidraw","elements":{}}'],
    ["invalid app state", '{"type":"excalidraw","appState":[]}'],
    ["invalid embedded files", '{"type":"excalidraw","files":[]}'],
  ])("rejects %s", (_label, text) => {
    expect(() => parseExcalidrawDocument(text)).toThrow();
  });
});
