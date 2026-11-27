import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { TableCell } from "@tiptap/extension-table";
import { getExtensionField } from "@tiptap/core";
import * as projection from "./import-export.js";
import { getDohcYDocFrontmatter, markdownToYDoc } from "./import-export.js";
import * as ordered from "./orderedLiveUpdateCut.js";
import { type OrderedLiveUpdateCutPolicy } from "./orderedLiveUpdateCut.js";
import { holdsBodySequence } from "./bodySequenceStore.js";
import {
  admitBodySequenceNotes,
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
  liveEditFitsCopy,
  type LiveMarkdownRegistrationEvidence,
} from "./liveDocumentValidation.js";
import { WORKER_LIVE_VALIDATION_POLICY, withinLiveNoteCapacity } from "./liveValidationPolicy.js";

const fixturePolicy: OrderedLiveUpdateCutPolicy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
};

const document = {
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "object",
  lineageClaimId: "lineage",
};
const validate = createLiveMarkdownRegistrationValidator(fixturePolicy);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function input(checkpoint: Uint8Array = new Uint8Array([0, 0])) {
  return { document: { ...document }, currentPath: "notes/example.md", checkpoint };
}
function encode(markdown: string, edit?: (doc: Y.Doc) => void): Uint8Array {
  const doc = markdownToYDoc(markdown);
  try {
    edit?.(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
function accepted(checkpoint: Uint8Array): LiveMarkdownRegistrationEvidence {
  const result = validate(input(checkpoint));
  expect(
    result,
    JSON.stringify(result.kind === "refused" ? result : { kind: result.kind }),
  ).toHaveProperty("kind", "accepted");
  if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
  return result.evidence;
}
function refused(checkpoint: Uint8Array, reason = "invalid-schema") {
  const result = validate(input(checkpoint));
  expect(result.kind).toBe("refused");
  if (result.kind === "refused")
    expect(result).toEqual({ kind: "refused", reason, source: "registration-input" });
}
afterEach(() => vi.restoreAllMocks());

it.each(["\n", "\r\n"])("registers the captured bytes with or without a final %j", (newline) => {
  const body = ["- &amp;", "  - child"].join(newline);
  const canonical = body + newline;
  const utf8 = new TextEncoder();
  for (const markdown of [body, canonical]) {
    const checkpoint = encode(markdown, (doc) => {
      const meta = doc.getMap("meta");
      meta.set("dohcMarkdownSource", markdown);
      meta.set("dohcMarkdownSourceSha256", hash(utf8.encode(markdown)));
      meta.set("dohcMarkdownSourceProjectionSha256", hash(utf8.encode(canonical)));
    });
    const { projectedMarkdown, projectedMarkdownSha256, projectedMarkdownByteLength } =
      accepted(checkpoint);
    expect(projectedMarkdown).toBe(markdown);
    expect(projectedMarkdownSha256).toBe(hash(utf8.encode(markdown)));
    expect(projectedMarkdownByteLength).toBe(utf8.encode(markdown).length);
  }
});

it("canonical importer output with an isolated hostile key reaches registration validation", () => {
  const doc = markdownToYDoc("---\nnested:\n  __proto__: preserved\n---\n\nBody");
  try {
    expect(getDohcYDocFrontmatter(doc)).toEqual({ nested: { ["__proto__"]: "preserved" } });
    const checkpoint = Y.encodeStateAsUpdate(doc);
    expect(accepted(checkpoint).projectedMarkdown).toContain("__proto__: preserved");
  } finally {
    doc.destroy();
  }
});

describe("private policy construction", () => {
  it("owns distinct policies without rereading caller records", () => {
    const caller = { ...fixturePolicy };
    const generous = createLiveMarkdownRegistrationValidator(caller);
    const narrow = createLiveMarkdownRegistrationValidator({
      ...fixturePolicy,
      maxStructVisits: 1,
    });
    caller.maxStructVisits = 1;
    const call = input(encode("A **bold** paragraph"));
    expect(generous(call).kind).toBe("accepted");
    expect(narrow(call)).toEqual({
      kind: "refused",
      reason: "capacity-refused",
      source: "registration-input",
    });
  });
});

describe("call and byte ownership", () => {
  it("requires exact own enumerable data fields and canonical main Markdown paths", () => {
    const getter = vi.fn(() => document);
    const accessor = Object.defineProperty(input(), "document", { get: getter });
    for (const call of [
      null,
      [],
      accessor,
      { ...input(), extra: true },
      { ...input(), updates: [] },
      { ...input(), document: { ...document, extra: 1 } },
      { ...input(), document: { ...document, mainVersionId: "branch" } },
      { ...input(), document: Object.create(document) },
      ...["a/../b.md", "/a.md", "a\\b.md", "a.txt", "../a.md", " a.md "].map((currentPath) => ({
        ...input(),
        currentPath,
      })),
    ])
      expect(validate(call)).toEqual({ kind: "refused", reason: "invalid-input", source: "call" });
    expect(getter).not.toHaveBeenCalled();
    expect(validate({ ...input(), currentPath: `${"a/".repeat(520)}note.md` }).kind).toBe(
      "accepted",
    );
  });

  it("rejects incompatible, empty, shared, resizable and detached views", () => {
    const detached = new Uint8Array([0, 0]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const resizable = Reflect.construct(ArrayBuffer, [2, { maxByteLength: 4 }]) as ArrayBuffer;
    for (const checkpoint of [
      new Uint8Array(),
      new Int8Array([0, 0]),
      new DataView(new ArrayBuffer(2)),
      new Uint8Array(new SharedArrayBuffer(2)),
      new Uint8Array(resizable),
      detached,
      [0, 0],
      null,
    ])
      expect(validate({ ...input(), checkpoint })).toEqual({
        kind: "refused",
        reason: "invalid-input",
        source: "registration-input",
      });
  });

  it("owns evidence records, original bytes, ranges and each returned byte view", () => {
    const bytes = encode("Evidence");
    const call = input(bytes);
    const result = validate(call);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const evidence = result.evidence;
    const original = bytes.slice();
    call.document.workspaceId = "changed";
    bytes.fill(255);
    expect(evidence.document).toEqual(document);
    expect(evidence.checkpoint.bytes).toEqual(original);
    for (const record of [
      result,
      evidence,
      evidence.document,
      evidence.checkpoint,
      evidence.checkpoint.ranges,
      ...evidence.checkpoint.ranges,
    ])
      expect(Object.isFrozen(record)).toBe(true);
    for (const read of [
      () => evidence.checkpoint.bytes,
      () => evidence.stateUpdate,
      () => evidence.stateVector,
    ]) {
      const before = read();
      read().fill(255);
      expect(read()).toEqual(before);
      expect(read()).not.toBe(read());
    }
    expect(evidence.version).toBe(1);
    expect(evidence.projectedMarkdownSha256).toBe(
      hash(new TextEncoder().encode(evidence.projectedMarkdown)),
    );
    expect(evidence.stateUpdateSha256).toBe(hash(evidence.stateUpdate));
    expect(evidence.stateVectorSha256).toBe(hash(evidence.stateVector));
    expect(evidence.checkpoint.ranges.length).toBeGreaterThan(0);
    expect(Object.keys(evidence).sort()).toEqual(
      [
        "version",
        "document",
        "currentPath",
        "checkpoint",
        "projectedMarkdown",
        "projectedMarkdownSha256",
        "projectedMarkdownByteLength",
        "stateUpdate",
        "stateUpdateSha256",
        "stateUpdateByteLength",
        "stateVector",
        "stateVectorSha256",
      ].sort(),
    );
  });
});

describe("public Markdown schema", () => {
  function nodeCheckpoint(name: string, attributes: Record<string, unknown>): Uint8Array {
    const schema = projection.getDohcProseMirrorSchema();
    const node = structuredClone(schema.nodes[name].create().toJSON());
    Object.assign(node.attrs, attributes);
    const paragraph = { type: "paragraph", content: [{ type: "text", text: "Text" }] };
    if (["callout", "taskItem", "tableCell", "tableHeader"].includes(name))
      node.content = [paragraph];
    if (name === "orderedList") node.content = [{ type: "listItem", content: [paragraph] }];
    if (name === "tableRow") node.content = [{ type: "tableCell", content: [paragraph] }];
    if (name === "heading" || name === "codeBlock") node.content = [{ type: "text", text: "Text" }];
    let child = node;
    if (schema.nodes[name].isInline) child = { type: "paragraph", content: [node] };
    if (name === "taskItem") child = { type: "taskList", content: [node] };
    if (name === "tableCell" || name === "tableHeader")
      child = { type: "table", content: [{ type: "tableRow", content: [node] }] };
    if (name === "tableRow") child = { type: "table", content: [node] };
    return encode("", (doc) =>
      prosemirrorJSONToYXmlFragment(
        schema,
        { type: "doc", content: [child] },
        doc.getXmlFragment("body"),
      ),
    );
  }

  it.each([
    ["heading", "level"],
    ["taskItem", "checked"],
    ["tableCell", "colwidth"],
    ["callout", "fold"],
  ])("refuses malformed scalar %s.%s without coercion", (name, key) => {
    const malformed = name === "taskItem" || ["level", "colwidth"].includes(key) ? "wrong" : 5;
    refused(nodeCheckpoint(name, { [key]: malformed }));
  });
  it.each([
    ["tableCell", "colwidth", [80, -Infinity]],
    ["heading", "level", 7],
  ] as const)("refuses decoded numeric value %s.%s = %s", (name, key, value) => {
    const checkpoint = nodeCheckpoint(name, { [key]: value });
    const decoded = new Y.Doc();
    try {
      Y.applyUpdate(decoded, checkpoint);
      const find = (fragment: Y.XmlFragment): Y.XmlElement | undefined => {
        for (const child of fragment.toArray()) {
          if (!(child instanceof Y.XmlElement)) continue;
          if (child.nodeName === name) return child;
          const nested = find(child);
          if (nested) return nested;
        }
      };
      const attributes = find(decoded.getXmlFragment("body"))?.getAttributes() as
        | Record<string, unknown>
        | undefined;
      expect(attributes).toBeDefined();
      expect(attributes?.[key]).toEqual(value);
    } finally {
      decoded.destroy();
    }
    refused(checkpoint);
  });
  it.each([TableCell])("preserves the HTML parser no-width value from $name", (extension) => {
    const attributes = getExtensionField(extension, "addAttributes", {
      name: extension.name,
      options: extension.options,
      storage: extension.storage,
    })!();
    const parse = attributes.colwidth.parseHTML!;
    const element = { getAttribute: (name: string) => (name === "colwidth" ? "80,auto" : null) };
    const widths = parse(element as HTMLElement);
    expect(widths[0]).toBe(80);
    expect(Number.isNaN(widths[1])).toBe(true);
    const checkpoint = nodeCheckpoint(extension.name, { colspan: 2, colwidth: widths });
    const evidence = accepted(checkpoint);
    expect(evidence.checkpoint.bytes).toEqual(checkpoint);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, evidence.checkpoint.bytes);
      const cell = (
        (restored.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlElement
      ).get(0) as Y.XmlElement;
      const decodedWidths = (cell.getAttributes() as Record<string, unknown>).colwidth as number[];
      expect(decodedWidths[0]).toBe(80);
      expect(Number.isNaN(decodedWidths[1])).toBe(true);
    } finally {
      restored.destroy();
    }
    expect(evidence.projectedMarkdown).toBe(
      accepted(nodeCheckpoint(extension.name, { colspan: 2, colwidth: [80, 0] })).projectedMarkdown,
    );
  });

  it.each(["href"])("refuses malformed link %s values", (key) => {
    for (const value of [5, true, { nested: "value" }, ["x"]]) {
      refused(
        encode("[text](https://example.com)", (doc) => {
          const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
          const attrs = text.toDelta()[0].attributes!.link;
          text.format(0, text.length, { link: { ...attrs, [key]: value } });
        }),
      );
    }
  });
  // Proves: a checkpoint's long format key is refused before projection, whose own mark-name
  // pattern takes time quadratic in the key's length.
  it("refuses a long format key before projection without stalling", () => {
    refused(
      encode("Text", (doc) => {
        const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.format(0, text.length, { ["x".repeat(1 << 18)]: true });
      }),
    );
  });
  it("preserves nullable link attributes and canonical frontmatter bigint", () => {
    const checkpoint = encode(
      "---\ninteger: 9223372036854775807\n---\n\n[text](https://example.com)",
      (doc) => {
        const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.format(0, text.length, {
          link: { href: null, target: null, rel: null, class: null, title: null },
        });
      },
    );
    const evidence = accepted(checkpoint);
    expect(evidence.projectedMarkdown).toContain("9223372036854775807");
    expect(evidence.projectedMarkdown).toContain("[text]()");
  });

  it("accepts canonical zero seed and metadata-only empty documents", () => {
    expect(accepted(new Uint8Array([0, 0])).projectedMarkdown).toBe("");
    const doc = new Y.Doc();
    try {
      doc.getMap("meta").set("schemaVersion", 1);
      expect(accepted(Y.encodeStateAsUpdate(doc)).projectedMarkdown).toBe("");
    } finally {
      doc.destroy();
    }
  });

  it("validates nonempty embeds and format attributes beside empty XmlText", () => {
    for (const invalid of ["embed", "link"] as const) {
      refused(
        encode("Text", (doc) => {
          const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
          const text = paragraph.get(0) as Y.XmlText;
          paragraph.insert(0, [new Y.XmlText()]);
          if (invalid === "embed") text.insertEmbed(0, { hidden: "value" });
          else text.format(0, text.length, { link: { href: 42 } });
        }),
      );
    }
  });

  it("accepts neighbouring texts in one paragraph, as two editors typing into one new line leave them", () => {
    const twin = (marks: { first?: object; second?: object }) =>
      encode("Text", (doc) => {
        const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
        const first = paragraph.get(0) as Y.XmlText,
          second = new Y.XmlText();
        paragraph.insert(1, [second]);
        second.insert(0, " more", marks.second);
        if (marks.first) first.format(0, first.length, marks.first);
      });
    const bold = { bold: {} };
    for (const [marks, markdown] of [
      [{}, "Text more"],
      [{ first: bold, second: bold }, "**Text more**"],
      [{ first: bold }, "**Text** more"],
    ] as const)
      expect(accepted(twin(marks)).projectedMarkdown).toBe(
        accepted(encode(markdown)).projectedMarkdown,
      );
  });

  it("keeps invalid roots, nesting and attributes refused beside empty XmlText", () => {
    refused(encode("Text", (doc) => doc.getXmlFragment("body").insert(0, [new Y.XmlText()])));
    refused(
      encode("Text", (doc) => {
        const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
        const nested = new Y.XmlElement("paragraph");
        nested.insert(0, [new Y.XmlText()]);
        paragraph.insert(0, [nested]);
      }),
    );
    refused(
      encode("Text", (doc) => {
        const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
        const text = paragraph.get(0) as Y.XmlText;
        text.delete(0, text.length);
        paragraph.setAttribute("unknown", "hidden");
      }),
    );
    refused(
      encode("Text", (doc) => {
        const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.delete(0, text.length);
        text.setAttribute("hidden", "value");
      }),
    );
  });

  it.each([
    ["schemaVersion", 2],
    ["unknown", true],
  ])("rejects strict metadata %s = %s", (key, value) => {
    refused(encode("Text", (doc) => doc.getMap("meta").set(key as string, value)));
  });

  it.each([undefined, new Uint8Array([1]), new Y.Text("discarded"), new Y.Doc()])(
    "rejects nonpublic frontmatter values %#",
    (value) => {
      refused(encode("Text", (doc) => doc.getMap("frontmatter").set("value", value)));
      if (value instanceof Y.Doc) value.destroy();
    },
  );

  it("rejects topology-hidden keyed body and active unknown roots", () => {
    const keyed = new Y.Doc();
    try {
      keyed.getMap("body").set("hidden", "value");
      keyed.getMap("meta").set("schemaVersion", 1);
      refused(Y.encodeStateAsUpdate(keyed));
    } finally {
      keyed.destroy();
    }
    refused(encode("Text", (doc) => doc.getMap("unknown").set("hidden", true)));
  });
  it("rejects invalid children, attributes and marks that the schema drops", () => {
    refused(
      encode("Text", (doc) => doc.getXmlFragment("body").insert(0, [new Y.XmlElement("unknown")])),
    );
    refused(
      encode("Text", (doc) =>
        (doc.getXmlFragment("body").get(0) as Y.XmlElement).setAttribute("unknown", "hidden"),
      ),
    );
    refused(
      encode("Text", (doc) =>
        ((doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 1, {
          unknown: {},
        }),
      ),
    );
  });
  it("accepts sealed pieces and a loose list, and refuses them with values the writers cannot write", () => {
    const sealed = (
      edit?: (block: Y.XmlElement, inline: Y.XmlElement, list: Y.XmlElement) => void,
    ) =>
      encode("Before\n\n- a\n- b", (doc) => {
        const body = doc.getXmlFragment("body");
        const block = new Y.XmlElement("rawBlock");
        block.setAttribute("source", "<details>\n<summary>More</summary>\n</details>");
        const inline = new Y.XmlElement("rawInline");
        inline.setAttribute("source", "&nbsp;");
        (body.get(0) as Y.XmlElement).insert(1, [inline]);
        body.insert(1, [block]);
        const list = body.get(2) as Y.XmlElement;
        (list as unknown as Y.XmlElement<{ loose: boolean }>).setAttribute("loose", true);
        edit?.(block, inline, list);
      });
    expect(accepted(sealed()).projectedMarkdown).toBe(
      "Before&nbsp;\n\n<details>\n<summary>More</summary>\n</details>\n\n- a\n\n- b\n",
    );
    refused(sealed((block) => block.setAttribute("source", 1 as unknown as string)));
    refused(sealed((_block, inline) => inline.setAttribute("source", {} as unknown as string)));
    refused(sealed((_block, _inline, list) => list.setAttribute("loose", "yes")));
  });
  // Two people turning neighbouring to-dos into plain lines at once merge into an empty list.
  it("accepts a list or item left empty by a merge, and refuses one that holds text", () => {
    const plain = accepted(encode("- [ ] alpha\n\nbravo")).projectedMarkdown;
    const withShells = accepted(
      encode("- [ ] alpha\n\nbravo", (doc) => {
        const body = doc.getXmlFragment("body");
        const list = new Y.XmlElement("taskList");
        list.insert(0, [new Y.XmlElement("taskItem")]);
        body.insert(1, [list]);
        (body.get(0) as Y.XmlElement).insert(1, [new Y.XmlElement("taskItem")]);
      }),
    );
    expect(withShells.projectedMarkdown).toBe(plain);
    refused(
      encode("- [ ] alpha\n\nbravo", (doc) => {
        const list = new Y.XmlElement("taskList"),
          paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("hidden")]);
        list.insert(0, [paragraph]);
        doc.getXmlFragment("body").insert(1, [list]);
      }),
    );
  });
  const first = (parent: Y.XmlFragment) => parent.get(0) as Y.XmlElement;
  const shell = () => {
    const list = new Y.XmlElement("bulletList");
    list.insert(0, [new Y.XmlElement("listItem")]);
    return list;
  };
  // Each would still change the Markdown file the engine writes, though a reading leaves it out.
  it.each<[string, string, (body: Y.XmlFragment) => void]>([
    [
      "a ticked to-do holding an empty list, which keeps its box",
      "- [ ] alpha\n- [x] ticked",
      (body) => {
        const ticked = first(body).get(1) as Y.XmlElement;
        ticked.delete(0, ticked.length);
        ticked.insert(0, [new Y.XmlElement("taskList")]);
      },
    ],
    [
      "an empty to-do with an attribute the schema doesn't define",
      "- [ ] alpha",
      (body) => {
        const hidden = new Y.XmlElement("taskItem");
        hidden.setAttribute("x-hidden", "secret");
        first(body).insert(1, [hidden]);
      },
    ],
    [
      "an empty item at the top of a numbered list, which renumbers it",
      "1. alpha\n2. bravo",
      (body) => first(body).insert(0, [new Y.XmlElement("listItem")]),
    ],
    [
      "an empty list before an item's text, which moves the text out of the list",
      "- alpha\n- bravo",
      (body) => (first(body).get(1) as Y.XmlElement).insert(0, [shell()]),
    ],
    [
      "an empty list in a table cell, which adds a break to the cell",
      "| h |\n|---|\n| a |",
      (body) => ((first(body).get(1) as Y.XmlElement).get(0) as Y.XmlElement).insert(1, [shell()]),
    ],
    [
      "an empty callout, whose title the file keeps",
      "alpha",
      (body) => {
        const callout = new Y.XmlElement("callout");
        callout.setAttribute("calloutType", "note");
        callout.setAttribute("title", "hidden");
        body.insert(1, [callout]);
      },
    ],
  ])("refuses %s", (_, markdown, change) => {
    accepted(encode(markdown));
    refused(encode(markdown, (doc) => change(doc.getXmlFragment("body"))));
  });
  it("accepts a full 2 MiB file as one text run, and refuses one UTF-8 byte over", () => {
    // The limit counts the projected file, final newline included.
    const limit = 2 * 1024 * 1024;
    expect(accepted(encode("x".repeat(limit - 1))).projectedMarkdownByteLength).toBe(limit);
    refused(encode("x".repeat(limit)), "capacity-refused");
    expect(accepted(encode(`${"é".repeat(limit / 2 - 1)}x`)).projectedMarkdownByteLength).toBe(
      limit,
    );
    refused(encode("é".repeat(limit / 2)), "capacity-refused");
  }, 60_000);

  it("enforces public depth 128 independently of text length", () => {
    const fixture = (depth: number) =>
      encode("", (doc) => {
        let value: unknown = "leaf";
        for (let index = 0; index < depth; index++) value = { child: value };
        doc.getMap("frontmatter").set("nested", value);
      });
    accepted(fixture(128));
    refused(fixture(129), "capacity-refused");
  });
});

describe("real scratch finalization", () => {
  function observe() {
    const actual = ordered.validateRegistrationCutForProjection;
    let scratch: Y.Doc | undefined;
    const events: string[] = [];
    vi.spyOn(ordered, "validateRegistrationCutForProjection").mockImplementation((...args) => {
      const result = actual(...args);
      if (result.kind === "accepted") {
        scratch = result.cut.document;
        const off = scratch.off.bind(scratch);
        vi.spyOn(scratch, "off").mockImplementation((...offArgs) => {
          if (offArgs[0] === "beforeTransaction") events.push("finalize");
          return off(...offArgs);
        });
        const destroy = scratch.destroy.bind(scratch);
        vi.spyOn(scratch, "destroy").mockImplementation(() => {
          events.push("destroy");
          destroy();
        });
      }
      return result;
    });
    return { events, scratch: () => scratch };
  }
  it.each(["success", "schema refusal", "transaction"])(
    "finalizes exactly once after %s",
    (mode) => {
      const checkpoint = encode(
        "Text",
        mode === "schema refusal"
          ? (doc) => doc.getMap("meta").set("unknown", 1)
          : mode === "topology refusal"
            ? (doc) => doc.getMap("unknown").set("hidden", 1)
            : undefined,
      );
      const probe = observe();
      const original = projection.yDocToMarkdown;
      const projector = vi.spyOn(projection, "yDocToMarkdown").mockImplementation((doc) => {
        expect(doc).toBe(probe.scratch());
        if (mode === "throw") throw new Error("projection failed");
        if (mode === "transaction") {
          doc.transact(() => {});
          throw new Error("projection failed after mutation");
        }
        if (mode === "destruction") {
          doc.destroy();
          throw new Error("projection failed after destruction");
        }
        return original(doc);
      });
      const result = validate(input(checkpoint));
      if (mode === "success") expect(result.kind).toBe("accepted");
      else
        expect(result).toEqual({
          kind: "refused",
          reason: ["transaction", "destruction"].includes(mode)
            ? "projection-mutated"
            : "invalid-schema",
          source: "registration-input",
        });
      expect(probe.events.filter((event) => event === "finalize")).toHaveLength(1);
      expect(probe.scratch()?.isDestroyed).toBe(true);
      if (mode !== "destruction") expect(probe.events).toEqual(["finalize", "destroy"]);
      expect(projector).toHaveBeenCalledTimes(
        ["schema refusal", "topology refusal"].includes(mode) ? 0 : 1,
      );
    },
  );

  it("refuses content changes with an unchanged state vector and no transaction", () => {
    const checkpoint = encode("Text");
    const original = projection.yDocToMarkdown;
    vi.spyOn(projection, "yDocToMarkdown").mockImplementation((doc) => {
      const vector = Y.encodeStateVector(doc);
      const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const item = text._start!;
      const content = item.content as Y.ContentString;
      content.str = "Next";
      expect(Y.encodeStateVector(doc)).toEqual(vector);
      return original(doc);
    });
    refused(checkpoint, "projection-mutated");
  });
});

function journalFixture(edits: ((doc: Y.Doc) => void)[] = [], markdown = "Text") {
  const doc = markdownToYDoc(markdown);
  try {
    const checkpoint = Y.encodeStateAsUpdate(doc);
    const updates = edits.map((edit) => {
      const vector = Y.encodeStateVector(doc);
      edit(doc);
      return Y.encodeStateAsUpdate(doc, vector);
    });
    return {
      ...input(checkpoint),
      suffix: updates.slice(0, -1),
      candidate: updates.at(-1) ?? new Uint8Array([0, 0]),
    };
  } finally {
    doc.destroy();
  }
}
const journal = createLiveMarkdownJournalValidator(fixturePolicy);
const editText = (text: string) => (doc: Y.Doc) => {
  ((doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, text);
};
function observeJournalCuts() {
  const actual = ordered.validateJournalCutForProjection;
  const scratches: { doc: Y.Doc; finalizations: number }[] = [];
  const spy = vi.spyOn(ordered, "validateJournalCutForProjection").mockImplementation((...args) => {
    const result = actual(...args);
    if (result.kind === "accepted") {
      const entry = { doc: result.cut.document, finalizations: 0 };
      scratches.push(entry);
      const off = entry.doc.off.bind(entry.doc);
      vi.spyOn(entry.doc, "off").mockImplementation((...args) => {
        if (args[0] === "beforeTransaction") entry.finalizations++;
        return off(...args);
      });
    }
    return result;
  });
  return { spy, scratches };
}

describe("private journal evidence and ownership", () => {
  it("accepts deleting all text as a journal candidate, reopening, and continued editing", () => {
    const call = journalFixture([
      (doc) => {
        doc.gc = false;
        const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.delete(0, text.length);
      },
    ]);
    const result = journal(call);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.evidence.projectedMarkdownByteLength).toBe(0);
    expect(result.evidence.projectedMarkdownSha256).toBe(hash(new Uint8Array()));
    const checkpoint = result.evidence.stateUpdate;
    expect(accepted(checkpoint).projectedMarkdown).toBe("");
    const reopened = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(reopened, checkpoint);
      const text = (reopened.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      expect(text).toBeInstanceOf(Y.XmlText);
      expect(text.toDelta()).toEqual([]);
      const before = Y.encodeStateVector(reopened);
      text.insert(0, "Continued");
      const candidate = Y.encodeStateAsUpdate(reopened, before);
      const continued = journal({ ...input(checkpoint), suffix: [], candidate });
      expect(continued.kind).toBe("accepted");
      if (continued.kind !== "accepted") return;
      expect(accepted(continued.evidence.stateUpdate).projectedMarkdown).toBe("Continued\n");
      const withDeletedPrefix = journal({ ...call, suffix: [call.candidate], candidate });
      expect(withDeletedPrefix.kind).toBe("accepted");
      if (withDeletedPrefix.kind === "accepted")
        expect(withDeletedPrefix.evidence.stateUpdate).toEqual(continued.evidence.stateUpdate);
    } finally {
      reopened.destroy();
    }
  });
  it("retains checkpoint and candidate identities with reusable finalized state", () => {
    const call = journalFixture([editText("first "), editText("second ")]);
    const result = journal(call);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const evidence = result.evidence;
    expect(evidence.checkpointDigest).toBe(hash(call.checkpoint));
    expect(evidence.suffixDigests).toEqual(call.suffix.map(hash));
    expect(evidence.candidate.updateDigest).toBe(hash(call.candidate));
    expect(evidence.stateUpdateSha256).toBe(hash(evidence.stateUpdate));
    expect(evidence.stateUpdateByteLength).toBe(evidence.stateUpdate.byteLength);
    expect(evidence.stateUpdateSha256).not.toBe(evidence.checkpointDigest);
    const originalRanges = Y.decodeUpdate(call.candidate).structs.map((struct) => ({
      clientId: struct.id.client,
      startClock: struct.id.clock,
      endClock: struct.id.clock + struct.length,
    }));
    expect(evidence.candidate.ranges).toEqual(originalRanges);
    const checkpointRanges = [
      ...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(call.checkpoint)),
    ].map(([clientId, endClock]) => ({ clientId, startClock: 0, endClock }));
    expect(evidence.checkpointRanges).toEqual(checkpointRanges);
    const registered = createLiveMarkdownRegistrationValidator(fixturePolicy)(
      input(evidence.stateUpdate),
    );
    expect(registered.kind).toBe("accepted");
    if (registered.kind === "accepted") {
      expect(evidence.projectedMarkdownSha256).toBe(registered.evidence.projectedMarkdownSha256);
      expect(evidence.projectedMarkdownByteLength).toBe(
        registered.evidence.projectedMarkdownByteLength,
      );
    }
    expect(Object.keys(evidence).sort()).toEqual(
      [
        "version",
        "document",
        "currentPath",
        "checkpointDigest",
        "checkpointRanges",
        "suffixDigests",
        "candidate",
        "projectedMarkdownSha256",
        "projectedMarkdownByteLength",
        "stateUpdate",
        "stateUpdateSha256",
        "stateUpdateByteLength",
      ].sort(),
    );
    for (const record of [
      result,
      evidence,
      evidence.document,
      evidence.checkpointRanges,
      ...evidence.checkpointRanges,
      evidence.suffixDigests,
      evidence.candidate,
      evidence.candidate.ranges,
      ...evidence.candidate.ranges,
    ])
      expect(Object.isFrozen(record)).toBe(true);
    const original = evidence.stateUpdate;
    evidence.stateUpdate.fill(255);
    call.checkpoint.fill(255);
    call.suffix[0].fill(255);
    call.candidate.fill(255);
    call.document.workspaceId = "changed";
    call.currentPath = "changed.md";
    expect(evidence.stateUpdate).toEqual(original);
    expect(evidence.stateUpdate).not.toBe(evidence.stateUpdate);
    expect(evidence.document).toEqual(document);
    expect(evidence.currentPath).toBe("notes/example.md");
  });

  it("rejects descriptor, path, sparse and accessor suffix failures at call without reading getters", () => {
    const getter = vi.fn(() => new Uint8Array([0, 0]));
    const accessor = Object.defineProperty([new Uint8Array([0, 0])], "0", { get: getter });
    const hidden = Object.defineProperty([new Uint8Array([0, 0])], "0", { enumerable: false });
    const extra = Object.assign([], { extra: true });
    const call = journalFixture();
    for (const value of [
      null,
      [],
      { ...call, extra: 1 },
      { ...call, currentPath: "../bad.md" },
      { ...call, document: { ...document, mainVersionId: "branch" } },
      Object.defineProperty({ ...call }, "candidate", { get: getter }),
      ...[new Array(1), accessor, hidden, extra, null, Object.create([])].map((suffix) => ({
        ...call,
        suffix,
      })),
    ])
      expect(journal(value)).toEqual({ kind: "refused", reason: "invalid-input", source: "call" });
    expect(getter).not.toHaveBeenCalled();
    const excessive = new Array(4095);
    Object.defineProperty(excessive, "0", { get: getter });
    expect(journal({ ...call, suffix: excessive })).toEqual({
      kind: "refused",
      reason: "capacity-refused",
      source: "call",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("private journal refusal attribution and cleanup", () => {
  it.each(["suffix", "candidate"] as const)(
    "does not diagnose an input-stage %s refusal",
    (role) => {
      const call = journalFixture([editText("first "), editText("second ")]);
      const probe = observeJournalCuts();
      const registration = vi.spyOn(ordered, "validateRegistrationCutForProjection");
      expect(
        journal({
          ...call,
          [role]: role === "suffix" ? [new Uint8Array([0])] : new Uint8Array([0]),
        }),
      ).toEqual({
        kind: "refused",
        reason: "invalid-update",
        source: role === "candidate" ? "candidate" : "admitted-cut",
      });
      expect(probe.spy).toHaveBeenCalledOnce();
      expect(registration).not.toHaveBeenCalled();
      expect(probe.scratches).toHaveLength(0);
    },
  );

  it.each([true])(
    "diagnoses a valid prefix once after final schema refusal, suffix=%s",
    (withSuffix) => {
      const edits = withSuffix ? [editText("prefix ")] : [];
      const call = journalFixture([...edits, (doc) => doc.getMap("meta").set("unknown", 1)]);
      const probe = observeJournalCuts();
      const registration = vi.spyOn(ordered, "validateRegistrationCutForProjection");
      expect(journal(call)).toEqual({ kind: "refused", reason: "invalid-schema", source: "final" });
      expect(probe.spy).toHaveBeenCalledTimes(withSuffix ? 2 : 1);
      expect(registration).toHaveBeenCalledTimes(withSuffix ? 0 : 1);
      for (const entry of probe.scratches) {
        expect(entry.finalizations).toBe(1);
        expect(entry.doc.isDestroyed).toBe(true);
      }
    },
  );

  it.each([true])("diagnoses an invalid prefix once without recursion, suffix=%s", (withSuffix) => {
    const call = withSuffix
      ? journalFixture([(doc) => doc.getMap("meta").set("unknown", 1), editText("candidate ")])
      : {
          ...journalFixture(),
          checkpoint: encode("Text", (doc) => doc.getMap("meta").set("unknown", 1)),
        };
    const probe = observeJournalCuts();
    const registration = vi.spyOn(ordered, "validateRegistrationCutForProjection");
    expect(journal(call)).toEqual({
      kind: "refused",
      reason: "invalid-schema",
      source: "admitted-cut",
    });
    expect(probe.spy).toHaveBeenCalledTimes(withSuffix ? 2 : 1);
    expect(registration).toHaveBeenCalledTimes(withSuffix ? 0 : 1);
    for (const entry of probe.scratches) {
      expect(entry.finalizations).toBe(1);
      expect(entry.doc.isDestroyed).toBe(true);
    }
  });

  it.each(["throw"] as const)(
    "finalizes once on projection %s, rethrows, and never diagnoses",
    () => {
      const probe = observeJournalCuts();
      const registration = vi.spyOn(ordered, "validateRegistrationCutForProjection");
      const original = projection.yDocToMarkdown;
      vi.spyOn(projection, "yDocToMarkdown").mockImplementation((doc) => {
        if (doc === probe.scratches[0]?.doc) {
          throw new Error("projection failed");
        }
        return original(doc);
      });
      expect(() => journal(journalFixture())).toThrow("projection failed");
      expect(probe.spy).toHaveBeenCalledOnce();
      expect(registration).not.toHaveBeenCalled();
      expect(probe.scratches[0].finalizations).toBe(1);
      expect(probe.scratches[0].doc.isDestroyed).toBe(true);
    },
  );
});

describe("journal real cut counterexamples and checkpoint feasibility", () => {
  it.each([1])(
    "records finalized checkpoint revalidation under the exact measured work policy, suffix=%s",
    (suffixCount) => {
      const call = journalFixture(
        Array.from({ length: suffixCount + 1 }, (_, index) => editText(`${index} `)),
      );
      const measured = ordered.validateJournalCutForProjection(
        {
          mode: "journal-candidate",
          checkpoint: call.checkpoint,
          suffix: call.suffix,
          candidate: call.candidate,
        },
        fixturePolicy,
      );
      expect(measured.kind).toBe("accepted");
      if (measured.kind !== "accepted") return;
      const final = measured.cut.finishAfterProjection();
      measured.cut.document.destroy();
      expect(final.kind).toBe("accepted");
      if (final.kind !== "accepted") return;
      const policy = {
        maxStructVisits: Math.max(1, final.usage.structVisits),
        maxValueNodeVisits: Math.max(1, final.usage.valueNodeVisits),
        maxDecodedPayloadByteVisits: Math.max(1, final.usage.decodedPayloadByteVisits),
        maxStructClientGroupVisits: Math.max(1, final.usage.structClientGroupVisits),
        maxDeleteClientGroupVisits: Math.max(1, final.usage.deleteClientGroupVisits),
        maxDeleteIntervalVisits: Math.max(1, final.usage.deleteIntervalVisits),
        maxIndexOperations: Math.max(1, final.usage.indexOperations),
      };
      const result = createLiveMarkdownJournalValidator(policy)(call);
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") return;
      const registration = createLiveMarkdownRegistrationValidator(policy)(
        input(result.evidence.stateUpdate),
      );
      expect(registration).toEqual({
        kind: "refused",
        reason: "capacity-refused",
        source: "registration-input",
      });
      expect(
        createLiveMarkdownJournalValidator(policy)({
          ...input(result.evidence.stateUpdate),
          suffix: [],
          candidate: new Uint8Array([0, 0]),
        }),
      ).toEqual({ kind: "refused", reason: "capacity-refused", source: "admitted-cut" });

      // Each shape must charge its own work under the same policy.
      const checkpoint = ordered.validateRegistrationCutForProjection(
        {
          mode: "registration",
          checkpoint: result.evidence.stateUpdate,
        },
        fixturePolicy,
      );
      expect(checkpoint.kind).toBe("accepted");
      if (checkpoint.kind !== "accepted") return;
      const checkpointFinal = checkpoint.cut.finishAfterProjection();
      checkpoint.cut.document.destroy();
      expect(checkpointFinal.kind).toBe("accepted");
      expect(
        createLiveMarkdownRegistrationValidator({
          ...policy,
          maxIndexOperations: checkpointFinal.usage.indexOperations,
        })(input(result.evidence.stateUpdate)).kind,
      ).toBe("accepted");
    },
  );
});

it("refuses an update that binds a source the document does not import as, and drops one in a baseline", () => {
  const digest = (text: string) => hash(new TextEncoder().encode(text));
  const forge = (doc: Y.Doc) => {
    const meta = doc.getMap("meta");
    meta.set("dohcMarkdownSource", "- # Title\n");
    meta.set("dohcMarkdownSourceSha256", digest("- # Title\n"));
    meta.set("dohcMarkdownSourceProjectionSha256", digest(projection.yDocToMarkdown(doc)));
  };
  expect(journal(journalFixture([forge]))).toEqual({
    kind: "refused",
    reason: "invalid-schema",
    source: "final",
  });
  expect(accepted(encode("Text", forge)).projectedMarkdown).toBe("Text\n");
});

it("never projects a preserved source that holds text the document lacks", () => {
  const table = "| a | b |\n|---|---|\n| c | d |\n";
  const codeTable = "| `a|b` | c |\n|---|---|---|\n| x | `y|z` |\n";
  const digest = (text: string) => hash(new TextEncoder().encode(text));
  for (const [document, source] of [
    [table, "| a | b |\n|---|---|\n| c | d | hidden |\n"],
    [table, "a | b\n--- | ---\nc | d | hidden\n"],
    // A header with a pipe inside a code span makes the importer read the
    // table from the raw text, where the row's code span splits too.
    [codeTable, "| `a|b` | c |\n|---|---|---|\n| x | `y|z` | hidden |\n"],
    ["Hello\n", 'Hello\n\n[x]: https://h.example "hidden"\n'],
    ["Hello\n", 'Hello[](https://h.example "hidden")\n'],
    ["[x]: https://a.example\n", '[x]: https://a.example\n[x]: https://b.example "hidden"\n'],
  ]) {
    const canonical = projection.yDocToMarkdown(markdownToYDoc(document));
    const result = validate(
      input(
        encode(document, (doc) => {
          doc.getMap("meta").set("dohcMarkdownSource", source);
          doc.getMap("meta").set("dohcMarkdownSourceSha256", digest(source));
          doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", digest(canonical));
        }),
      ),
    );
    expect(result.kind === "accepted" ? result.evidence.projectedMarkdown : canonical, source).toBe(
      canonical,
    );
  }
});

describe("live note capacity (#3575, #2534)", () => {
  // A note refused for its weight offers Copy as Markdown, which serializes the open note with this
  // function. The notes that reach the limit are mostly deleted blocks: a 100-block note that another
  // program saved about 190 times, each save deleting the body and inserting every block.
  it("serializes a note over the capacity, heavy with deleted blocks, to its current text", () => {
    const block = (n: number) =>
      n % 10 === 0
        ? `## Section ${n / 10}`
        : n % 7 === 0
          ? `- item ${n} one\n- item ${n} two\n- item ${n} three`
          : `Paragraph ${n} says something ordinary about the week, with enough words to be a real line of a note.`;
    const note = (save: number) =>
      Array.from({ length: 100 }, (_, n) =>
        n === 50 ? `${block(n)} Save ${save}.` : block(n),
      ).join("\n\n") + "\n";
    const owner = new Y.Doc({ gc: false });
    Y.applyUpdate(owner, Y.encodeStateAsUpdate(markdownToYDoc(note(0))));
    const body = owner.getXmlFragment("body");
    let saves = 0;
    while (withinLiveNoteCapacity(owner, WORKER_LIVE_VALIDATION_POLICY)) {
      const blocks = markdownToYDoc(note(++saves))
        .getXmlFragment("body")
        .toArray() as Y.XmlElement[];
      owner.transact(() => {
        body.delete(0, body.length);
        body.insert(
          0,
          blocks.map((child) => child.clone()),
        );
      });
    }
    // The open note holds the same history, deleted blocks included.
    const open = new Y.Doc({ gc: false });
    Y.applyUpdate(open, Y.encodeStateAsUpdate(owner));
    const started = performance.now();
    const markdown = projection.yDocToMarkdown(open);
    const elapsed = performance.now() - started;
    expect(saves).toBeGreaterThan(150);
    expect(markdown).toBe(note(saves));
    // It walks the deleted blocks once; well under the time that would stall the window.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);
});

describe("notes the save threw on or refused by mistake (#4475, #4601)", () => {
  const emptyText = (doc: Y.Doc) => {
    const text = (doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(0, text.length);
  };

  it("refuses properties text that no longer reads as the properties", () => {
    const call = journalFixture(
      [(doc) => doc.getMap("meta").set("dohcFrontmatterSource", "status: other")],
      "---\nstatus: draft\n---\n\nText\n",
    );
    expect(journal(call)).toEqual({ kind: "refused", reason: "invalid-schema", source: "final" });
  });

  it("takes emptying a note with CRLF line ends, and typing into it again", () => {
    const emptied = journal(journalFixture([emptyText], "Text\r\n"));
    expect(emptied.kind).toBe("accepted");
    if (emptied.kind !== "accepted") return;
    expect(emptied.evidence.projectedMarkdownByteLength).toBe(0);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, emptied.evidence.stateUpdate);
      const before = Y.encodeStateVector(doc);
      editText("Again")(doc);
      const candidate = Y.encodeStateAsUpdate(doc, before);
      const checkpoint = emptied.evidence.stateUpdate;
      const typed = journal({ ...input(checkpoint), suffix: [], candidate });
      expect(typed.kind).toBe("accepted");
      if (typed.kind === "accepted")
        expect(accepted(typed.evidence.stateUpdate).projectedMarkdown).toBe("Again\r\n");
    } finally {
      doc.destroy();
    }
  });

  it("takes emptying a CRLF note whose properties keep LF line ends", () => {
    const call = journalFixture([emptyText], "---\nstatus: draft\n---\n\nText\r\n");
    expect(journal(call).kind).toBe("accepted");
  });

  it("refuses a CRLF note whose text the writer trims to nothing", () => {
    const call = journalFixture(
      [
        (doc) => {
          emptyText(doc);
          ((doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(
            0,
            "\u2003",
          );
        },
      ],
      "Text\r\n",
    );
    expect(journal(call)).toEqual({ kind: "refused", reason: "invalid-schema", source: "final" });
  });

  it.each(["Run [`npm install`](https://docs.example/install) first.\n", "A **`flag`** here.\n"])(
    "registers inline code under a link or bold as written, and keeps format 1 when format 2 is asked for: %j",
    (markdown) => {
      expect(accepted(encode(markdown)).projectedMarkdown).toBe(markdown);
      admitBodySequenceNotes(true);
      try {
        const doc = markdownToYDoc(markdown, { bodySequence: true });
        try {
          expect(holdsBodySequence(doc)).toBe(false);
          expect(accepted(Y.encodeStateAsUpdate(doc)).projectedMarkdown).toBe(markdown);
        } finally {
          doc.destroy();
        }
      } finally {
        admitBodySequenceNotes(false);
      }
    },
  );

  it.each([
    "[`a`](https://a.example)[`b`](https://b.example)\n",
    "`a`[`b`](https://b.example)\n",
    "**`a`**`b`\n",
  ])("refuses touching inline code that the writer would join into one: %j", (markdown) => {
    refused(encode(markdown));
  });

  it("refuses deleting the space between two linked inline codes", () => {
    const call = journalFixture(
      [
        (doc) =>
          ((doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(1, 1),
      ],
      "[`a`](https://a.example) [`b`](https://b.example)\n",
    );
    expect(journal(call)).toMatchObject({ kind: "refused", reason: "invalid-schema" });
  });
});

describe("live edit format guard", () => {
  const markdown = [
    "---",
    "title: Trip",
    "tags: [a, b]",
    "---",
    "# Plan",
    "",
    "Hello **world**",
    "",
    "<div>kept as written</div>",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- [ ] pack",
    "",
  ].join("\n");
  // The edit a page holding `note` sends after `edit`.
  function sent(note: Y.Doc, edit: (page: Y.Doc) => void) {
    const page = new Y.Doc();
    Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
    const before = Y.encodeStateVector(page);
    edit(page);
    return Y.encodeStateAsUpdate(page, before);
  }
  const paragraph = (page: Y.Doc) =>
    page
      .getXmlFragment("body")
      .toArray()
      .find(
        (node) => node instanceof Y.XmlElement && node.nodeName === "paragraph",
      ) as Y.XmlElement;
  const words = (page: Y.Doc) => paragraph(page).get(0) as Y.XmlText;
  // The room's copy of `note`, kept uncollected as the room's own note is.
  const copyOf = (note: Y.Doc) => {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
    return copy;
  };
  const fits = (note: Y.Doc, edit: Uint8Array) => liveEditFitsCopy(copyOf(note), edit);

  it("takes a whole note and the edits a page makes to it", () => {
    const note = markdownToYDoc(markdown);
    expect(fits(new Y.Doc(), Y.encodeStateAsUpdate(note))).toBe(true);
    const edits: ((page: Y.Doc) => void)[] = [
      (page) => words(page).insert(5, " there", { bold: {} }),
      (page) => words(page).format(0, 5, { italic: {} }),
      (page) => words(page).delete(0, 3),
      (page) => {
        const heading = new Y.XmlElement("heading");
        heading.setAttribute("level", 2 as never);
        heading.insert(0, [new Y.XmlText("Day one")]);
        page.getXmlFragment("body").insert(1, [heading]);
      },
      (page) => page.getMap("frontmatter").set("title", "Trip to Kyoto"),
      (page) => {
        const days = new Y.Array<unknown>();
        days.push([1, "two"]);
        page.getMap("frontmatter").set("days", days);
      },
      (page) => page.getMap("meta").set("dohcMarkdownCrlf", true),
      (page) => page.getMap("meta").set("dohcFrontmatterSourceItem:title", "x"),
    ];
    for (const edit of edits) expect(fits(note, sent(note, edit))).toBe(true);
  });

  it("refuses an edit that adds what a note can't hold", () => {
    const note = markdownToYDoc(markdown);
    const edits: Record<string, (page: Y.Doc) => void> = {
      root: (page) => page.getMap("extra").set("a", 1),
      element: (page) => page.getXmlFragment("body").insert(0, [new Y.XmlElement("script")]),
      top: (page) => page.getXmlFragment("body").insert(0, [new Y.XmlElement("doc")]),
      attribute: (page) => paragraph(page).setAttribute("onclick", "x"),
      mark: (page) => words(page).insert(2, "x", { blink: true }),
      "mark on existing words": (page) => words(page).format(0, 2, { blink: true }),
      embed: (page) => words(page).insertEmbed(1, { image: "x" }),
      "plain text in body": (page) =>
        page.getXmlFragment("body").insert(0, [new Y.Text("x") as never]),
      "map in body": (page) => paragraph(page).insert(0, [new Y.Map() as never]),
      "binary value": (page) => page.getMap("frontmatter").set("blob", new Uint8Array([1])),
      "nested note": (page) => page.getMap("frontmatter").set("doc", new Y.Doc()),
      hook: (page) => page.getMap("frontmatter").set("hook", new Y.XmlHook("h") as never),
      "meta key": (page) => page.getMap("meta").set("owner", "me"),
      "meta type": (page) => page.getMap("meta").set("schemaVersion", new Y.Map() as never),
    };
    for (const [name, edit] of Object.entries(edits))
      expect(fits(note, sent(note, edit)), name).toBe(false);
    expect(fits(note, new Uint8Array([1, 2, 3]))).toBe(false);
  });

  // Proves: a long mark name is refused in time linear in its length, so it can't hold up admission.
  it("refuses a long unknown mark name without stalling", () => {
    const note = markdownToYDoc(markdown);
    const edit = sent(note, (page) => words(page).format(0, 2, { ["x".repeat(1 << 18)]: true }));
    expect(fits(note, edit)).toBe(false);
    // The name is read from the key's start: a line break before a known mark's name keeps it unknown.
    const split = sent(note, (page) => words(page).format(0, 2, { "x\nbold--12345678": {} }));
    expect(fits(note, split)).toBe(false);
  });

  it("follows a run of typing back to where it starts", () => {
    const note = markdownToYDoc(markdown);
    // The bold letter builds on the typed ones, and only they name a neighbour the note holds.
    const typed = sent(note, (page) => {
      words(page).insert(1, "abc");
      words(page).insert(4, "d", { bold: {} });
    });
    expect(fits(note, typed)).toBe(true);
    const marked = sent(note, (page) => {
      words(page).insert(1, "abc");
      words(page).insert(4, "d", { blink: true });
    });
    expect(fits(note, marked)).toBe(false);
  });

  it("passes what the note already holds or has already collected", () => {
    const note = markdownToYDoc(markdown);
    expect(fits(note, Y.encodeStateAsUpdate(note))).toBe(true);
    // A page types into a paragraph another page removed, and the note collected its words.
    const late = sent(note, (page) => words(page).insert(1, "x"));
    const removed = sent(note, (page) =>
      page
        .getXmlFragment("body")
        .delete(page.getXmlFragment("body").toArray().indexOf(paragraph(page))),
    );
    Y.applyUpdate(note, removed);
    expect(fits(note, late)).toBe(true);

    // One edit can hold both the words typed into a paragraph and its collected removal.
    const page = new Y.Doc();
    Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
    const start = Y.encodeStateVector(page);
    const added = new Y.XmlElement("paragraph");
    added.insert(0, [new Y.XmlText("ab")]);
    page.getXmlFragment("body").insert(0, [added]);
    const typed = sent(page, (other) =>
      ((other.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(1, "x"),
    );
    page.getXmlFragment("body").delete(0);
    const both = Y.mergeUpdates([Y.encodeStateAsUpdate(page, start), typed]);
    expect(fits(note, both)).toBe(true);
  });

  it("places what an edit builds on by the note's own items, as Yjs does, not the edit's copies", () => {
    // The note: a paragraph at (7, 0) holding a text run at (7, 1).
    const note = new Y.Doc();
    note.clientID = 7;
    const kept = new Y.XmlElement("paragraph");
    note.getXmlFragment("body").insert(0, [kept]);
    kept.insert(0, [new Y.XmlText()]);
    const clone = () => {
      // Kept uncollected, so where Yjs put an item can be read after its removals.
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
      return copy;
    };

    // A map claimed at the paragraph's id, with a key set in it by another editor. Yjs keeps the
    // note's paragraph, so the key lands on it as an attribute it doesn't have.
    const fake = new Y.Doc();
    fake.clientID = 7;
    fake.getMap("frontmatter").set("x", new Y.Map());
    const other = new Y.Doc();
    other.clientID = 9;
    Y.applyUpdate(other, Y.encodeStateAsUpdate(fake));
    (other.getMap("frontmatter").get("x") as Y.Map<unknown>).set("onclick", "alert(1)");
    const attribute = Y.encodeStateAsUpdate(other);
    const landed = clone();
    Y.applyUpdate(landed, attribute);
    expect(paragraph(landed).getAttribute("onclick")).toBe("alert(1)");
    expect(fits(note, attribute)).toBe(false);

    // A collected item claimed at the text run's id, so the edit's own copy says its child is
    // dropped. Yjs puts the child on the note's text run.
    const gone = new Y.Doc();
    gone.clientID = 7;
    const outer = new Y.Map<unknown>();
    gone.getMap("frontmatter").set("outer", outer);
    outer.set("inner", new Y.Map());
    const writer = new Y.Doc();
    writer.clientID = 9;
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(gone));
    const start = Y.encodeStateVector(writer);
    (
      (writer.getMap("frontmatter").get("outer") as Y.Map<unknown>).get("inner") as Y.Map<unknown>
    ).set("k", new Y.XmlElement("script"));
    gone.getMap("frontmatter").delete("outer");
    const dropped = Y.mergeUpdates([
      Y.encodeStateAsUpdate(gone),
      Y.encodeStateAsUpdate(writer, start),
    ]);
    expect(Y.decodeUpdate(dropped).structs.some((struct) => struct instanceof Y.GC)).toBe(true);
    const placed = clone();
    Y.applyUpdate(placed, dropped);
    const child = Y.getItem(placed.store, Y.createID(9, 0)) as Y.Item;
    expect(child.parent).toBeInstanceOf(Y.XmlText);
    // The same removals take out the text run it lands on, so it never shows.
    expect(child.deleted).toBe(true);
    expect(fits(note, dropped)).toBe(true);
  });

  it("refuses an edit whose run past the note's text would sit somewhere else", () => {
    // The note: two paragraphs and a list of days in its frontmatter.
    const start = new Y.Doc();
    start.clientID = 7;
    for (const index of [0, 1]) {
      const block = new Y.XmlElement("paragraph");
      block.insert(0, [new Y.XmlText()]);
      start.getXmlFragment("body").insert(index, [block]);
    }
    start.getMap("frontmatter").set("days", new Y.Array());
    const text = (doc: Y.Doc, index: number) =>
      (doc.getXmlFragment("body").get(index) as Y.XmlElement).get(0) as Y.XmlText;
    // One run from client 9, made from the note's start.
    const run = (write: (doc: Y.Doc) => void) => {
      const doc = new Y.Doc();
      doc.clientID = 9;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(start));
      const before = Y.encodeStateVector(doc);
      write(doc);
      return Y.encodeStateAsUpdate(doc, before);
    };
    const holding = (taken: Uint8Array) => {
      const note = new Y.Doc();
      Y.applyUpdate(note, Y.encodeStateAsUpdate(start));
      Y.applyUpdate(note, taken);
      return note;
    };
    const abc = run((doc) => text(doc, 0).insert(0, "abc"));

    // The note took "abc" into the first paragraph, which is then removed and collected. The run
    // goes on in the second paragraph, beside an item that is gone.
    const collected = holding(abc);
    collected.getXmlFragment("body").delete(0, 1);
    expect(Y.getItem(collected.store, Y.createID(9, 2))).toBeInstanceOf(Y.GC);
    expect(
      fits(
        collected,
        run((doc) => text(doc, 1).insert(0, "abcdef")),
      ),
    ).toBe(false);

    // The note took three paragraphs. Text claimed under their ids would be linked after the
    // third paragraph, in the body itself.
    const blocks = holding(
      run((doc) =>
        doc.getXmlFragment("body").insert(
          2,
          [0, 1, 2].map(() => new Y.XmlElement("paragraph")),
        ),
      ),
    );
    expect(
      fits(
        blocks,
        run((doc) => text(doc, 0).insert(0, "XXXXXXXXX")),
      ),
    ).toBe(false);

    // Values claimed under "abc"'s ids would be linked into the text, not the list of days.
    const days = run((doc) =>
      (doc.getMap("frontmatter").get("days") as Y.Array<number>).push([1, 2, 3, 4, 5, 6]),
    );
    expect(fits(holding(abc), days)).toBe(false);

    // The note took a title and "ab". A title set five times under those ids sends the first four
    // as one deleted struct, whose new part would be linked into the text as the title's value.
    const titled = holding(
      run((doc) => {
        doc.getMap("frontmatter").set("title", "t");
        text(doc, 0).insert(0, "ab");
      }),
    );
    const retitled = run((doc) => {
      for (const value of ["a", "b", "c", "d", "v"]) doc.getMap("frontmatter").set("title", value);
    });
    expect(
      Y.decodeUpdate(retitled).structs.some(
        (struct) => struct.length === 4 && (struct as Y.Item).content instanceof Y.ContentDeleted,
      ),
    ).toBe(true);
    expect(fits(titled, retitled)).toBe(false);
  });

  // Proves: an edit the check takes is in the copy, so the next edit is read against it.
  it("keeps each edit it takes in the copy", () => {
    const note = markdownToYDoc(markdown);
    const copy = copyOf(note);
    const page = copyOf(note);
    const next = (edit: (doc: Y.Doc) => void) => {
      const before = Y.encodeStateVector(page);
      edit(page);
      return Y.encodeStateAsUpdate(page, before);
    };
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 2 as never);
    expect(
      liveEditFitsCopy(
        copy,
        next((doc) => doc.getXmlFragment("body").insert(0, [heading])),
      ),
    ).toBe(true);
    // Each builds on the one before, which only the copy holds.
    expect(
      liveEditFitsCopy(
        copy,
        next(() => heading.insert(0, [new Y.XmlText("Day one")])),
      ),
    ).toBe(true);
    expect(
      liveEditFitsCopy(
        copy,
        next(() => heading.setAttribute("onclick", "x")),
      ),
    ).toBe(false);
    expect(
      liveEditFitsCopy(
        copyOf(note),
        next(() => heading.setAttribute("level", 3 as never)),
      ),
    ).toBe(false);
  });

  // Proves: an edit that needs something the copy doesn't have is refused, not held for later.
  it("refuses an edit that builds on what the copy doesn't have", () => {
    const note = markdownToYDoc(markdown);
    const page = copyOf(note);
    const first = sent(page, (doc) => words(doc).insert(1, "ab"));
    Y.applyUpdate(page, first);
    const second = sent(page, (doc) => words(doc).insert(3, "cd"));
    expect(fits(note, second)).toBe(false);
    // Removing words the copy never had.
    expect(
      fits(
        note,
        sent(page, (doc) => words(doc).delete(1, 2)),
      ),
    ).toBe(false);
  });

  // Proves: text claimed under ids the note holds in a paragraph, but sent as the body's own, is
  // refused before Yjs joins it to the paragraph's text.
  it("refuses a run that Yjs would link into another list, before it joins the run", () => {
    const note = new Y.Doc();
    note.clientID = 7;
    const block = new Y.XmlElement("paragraph");
    note.getXmlFragment("body").insert(0, [block]);
    block.insert(0, [new Y.XmlText()]);
    const page = new Y.Doc();
    page.clientID = 9;
    Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
    const before = Y.encodeStateVector(page);
    ((page.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "abc");
    Y.applyUpdate(note, Y.encodeStateAsUpdate(page, before));
    const claim = new Y.Doc();
    claim.clientID = 9;
    claim.getText("body").insert(0, "abcdef");
    const edit = Y.encodeStateAsUpdate(claim);
    const landed = copyOf(note);
    Y.applyUpdate(landed, edit);
    // Yjs counts the run in the body but joins it to the paragraph's text.
    expect(landed.getXmlFragment("body").length).toBe(4);
    expect(fits(note, edit)).toBe(false);
  });

  // Proves: an item the same edit removes is still refused where it would leave a root or key a
  // note can't have, from a page that collects removed items or one that keeps them.
  it("refuses a removed item under a root or key a note can't have", () => {
    const note = markdownToYDoc(markdown);
    for (const gc of [false, true]) {
      const page = new Y.Doc({ gc });
      Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
      const removed = (edit: (doc: Y.Doc) => void) => {
        const before = Y.encodeStateVector(page);
        page.transact(() => edit(page));
        return Y.encodeStateAsUpdate(page, before);
      };
      const root = removed((doc) => {
        doc.getMap("evil").set("x", 1);
        doc.getMap("evil").delete("x");
      });
      expect(fits(note, root), `root, gc ${gc}`).toBe(false);
      // A page that reads the body as a map sets a key in it and removes it.
      const keyed = new Y.Doc({ gc });
      keyed.transact(() => {
        keyed.getMap("body").set("x", 1);
        keyed.getMap("body").delete("x");
      });
      expect(fits(note, Y.encodeStateAsUpdate(keyed)), `body key, gc ${gc}`).toBe(false);
    }
  });

  // Proves: content the save refuses even once removed is refused when the same edit removes it.
  it("refuses a removed hook or JSON value", () => {
    const note = markdownToYDoc(markdown);
    const removed = (edit: (frontmatter: Y.Map<unknown>) => void) => {
      const page = new Y.Doc({ gc: false });
      Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
      const before = Y.encodeStateVector(page);
      page.transact(() => edit(page.getMap("frontmatter")));
      return Y.encodeStateAsUpdate(page, before);
    };
    const hook = removed((frontmatter) => {
      frontmatter.set("hook", new Y.XmlHook("h"));
      frontmatter.delete("hook");
    });
    expect(fits(note, hook)).toBe(false);
    // A value Yjs reads as JSON, an older kind of content, replaced in the same edit.
    const replaced = removed((frontmatter) => {
      frontmatter.set("k", "zzzz");
      frontmatter.set("k", "y");
    });
    expect(fits(note, replaced)).toBe(true);
    // Its first value as one item holding one string: the count, the string's type, length and letters.
    const any = [1, 119, 4, 122, 122, 122, 122];
    const at = replaced.findIndex((_, index) =>
      any.every((byte, step) => replaced[index + step] === byte),
    );
    // The item's kind, in the byte before its key and parent: from any (8) to JSON (2).
    const info = at - 2 - 1 - "frontmatter".length - 1 - 1;
    expect(replaced[info]).toBe(0x28);
    const json = new Uint8Array([
      ...replaced.slice(0, info),
      0x22,
      ...replaced.slice(info + 1, at),
      1,
      6,
      ...new TextEncoder().encode('"zzzz"'),
      ...replaced.slice(at + any.length),
    ]);
    const decoded = Y.decodeUpdate(json).structs.find(
      (struct) => struct instanceof Y.Item && struct.content instanceof Y.ContentJSON,
    );
    expect(decoded).toBeDefined();
    expect(fits(note, json)).toBe(false);
  });

  // Proves: an empty item, which Yjs takes without moving its editor's clock, is refused.
  it("refuses an empty item", () => {
    const note = markdownToYDoc(markdown);
    const edit = sent(note, (page) => paragraph(page).setAttribute("onclick", "zzzz"));
    // The value as one item holding one string: its count, the string's type, length and letters.
    const value = [1, 119, 4, 122, 122, 122, 122];
    const at = edit.findIndex((_, index) =>
      value.every((byte, step) => edit[index + step] === byte),
    );
    expect(at).toBeGreaterThan(0);
    const empty = new Uint8Array([...edit.slice(0, at), 0, ...edit.slice(at + value.length)]);
    const landed = copyOf(note);
    Y.applyUpdate(landed, empty);
    expect(Object.hasOwn(paragraph(landed).getAttributes(), "onclick")).toBe(true);
    expect(fits(note, empty)).toBe(false);
  });

  it("takes an edit that runs on from text the note already holds", () => {
    const note = markdownToYDoc(markdown);
    const page = new Y.Doc();
    page.clientID = 9;
    Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
    const before = Y.encodeStateVector(page);
    words(page).insert(0, "abc");
    Y.applyUpdate(note, Y.encodeStateAsUpdate(page, before));
    // Sent again from before, the edit holds "abcdef" in one struct the note holds the start of,
    // and bold that ends after its last letter.
    words(page).insert(3, "def");
    words(page).format(0, 6, { bold: {} });
    const edit = Y.encodeStateAsUpdate(page, before);
    expect(
      Y.decodeUpdate(edit).structs.some((struct) => struct.id.client === 9 && struct.length === 6),
    ).toBe(true);
    expect(fits(note, edit)).toBe(true);
  });
});
