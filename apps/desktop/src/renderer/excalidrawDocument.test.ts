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

  it("accepts Excalidraw fractional element order", () => {
    expect(
      parseExcalidrawDocument(
        '{"type":"excalidraw","elements":[{"type":"rectangle","index":"a0"}]}',
      ).elements,
    ).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", "{"],
    ["another JSON file", '{"type":"other","elements":[]}'],
    ["an invalid elements list", '{"type":"excalidraw","elements":{}}'],
    ["invalid app state", '{"type":"excalidraw","appState":[]}'],
    ["invalid embedded files", '{"type":"excalidraw","files":[]}'],
    [
      "a null element",
      '{"type":"excalidraw","elements":[null],"appState":{},"files":{}}',
    ],
    [
      "a null active tool",
      '{"type":"excalidraw","elements":[],"appState":{"activeTool":null},"files":{}}',
    ],
    [
      "a non-string legacy font",
      '{"type":"excalidraw","elements":[{"type":"text","font":null}]}',
    ],
    [
      "non-string text content",
      '{"type":"excalidraw","elements":[{"type":"text","text":null,"height":20}]}',
    ],
    [
      "a non-string element link",
      '{"type":"excalidraw","elements":[{"type":"rectangle","link":{}}]}',
    ],
    [
      "an invalid fractional index",
      '{"type":"excalidraw","elements":[{"type":"rectangle","index":{}}]}',
    ],
    [
      "non-array element bindings",
      '{"type":"excalidraw","elements":[{"type":"rectangle","boundElements":{}}]}',
    ],
    [
      "a null element binding",
      '{"type":"excalidraw","elements":[{"type":"rectangle","boundElements":[null]}]}',
    ],
    [
      "non-array legacy element bindings",
      '{"type":"excalidraw","elements":[{"type":"rectangle","boundElementIds":{}}]}',
    ],
    [
      "missing linear points",
      '{"type":"excalidraw","elements":[{"type":"line"}]}',
    ],
    [
      "malformed linear points",
      '{"type":"excalidraw","elements":[{"type":"line","points":[null,[1,2]]}]}',
    ],
    [
      "a malformed fixed-point binding",
      '{"type":"excalidraw","elements":[{"type":"arrow","points":[[0,0],[1,1]],"elbowed":true,"startBinding":{"fixedPoint":{"0":0.5,"1":0.5}}}]}',
    ],
    [
      "a null embedded file",
      '{"type":"excalidraw","files":{"file-1":null}}',
    ],
  ])("rejects %s", (_label, text) => {
    expect(() => parseExcalidrawDocument(text)).toThrow();
  });
});
