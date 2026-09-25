// @vitest-environment jsdom
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc} from "@dohc/ydoc-projection";
import {adapterImplementationPaths, preparePublicWorkload, type PublicFixtureSelection} from "./publicWorkloadAdapter.integration-helper.js";
import {renderPublicFixture} from "./publicWorkloadRendering.integration-helper.js";
import {readPublicWorkload, type WorkloadPin} from "./publicLinkWorkload.integration-helper.js";
import {readPublicTransitionWorkload, transitionNames, workloadHash as hash} from "./publicTransitionWorkload.integration-helper.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function fixture(run: (f: ReturnType<typeof prepare>) => void) {
  const prefix = join(tmpdir(), "dohc-tiny-public-adapter-"), root = mkdtempSync(prefix);
  try {run(prepare(root));}
  finally {if (!isAbsolute(root) || !root.startsWith(prefix)) throw new Error("Unexpected cleanup path."); rmSync(root, {recursive: true, force: true});}
}
function prepare(root: string) {
  const pinFile = (path: string): WorkloadPin => {const bytes = readFileSync(path); return {path, byteLength: bytes.length, sha256: hash(bytes)};};
  const save = (name: string, bytes: Uint8Array) => {const path = join(root, name); writeFileSync(path, bytes); return pinFile(path);};
  const json = (name: string, value: unknown) => save(name, Buffer.from(JSON.stringify(value)));
  const doc = markdownToYDoc("Hello"), checkpoint = Y.encodeStateAsUpdate(doc); doc.destroy();
  const blob = save("checkpoint.bin", checkpoint);
  const recipe = (text: string) => ({version: 1 as const, kind: "append-paragraph" as const, text});
  const step = (deliveryId: string) => ({deliveryId, recipe: recipe(deliveryId)});
  const transitions = Object.fromEntries([...transitionNames, "view"].map(name => [name, {baselineCase: "tiny-registration", updates: [step(`${name}-accepted`)],
    ...(name === "view" ? {} : {interrupted: step(`${name}-interrupted`)}),
    ...(["restart", "staleFrame"].includes(name) ? {resumed: step(`${name}-resumed`)} : {}),
    ...(name === "restore" ? {continuation: step("restore-continuation")} : {})}])) as PublicFixtureSelection["transitions"];
  // These numbers exercise the adapter only. They are not release admission or calibration evidence.
  const selection: PublicFixtureSelection = {version: 1, purpose: "tiny-adapter-test", selectionEvidence: [json("test-only.json", {admittedWorkload: false})],
    corpus: json("corpus.json", {cases: [{id: "tiny-registration", mode: "registration", checkpoint: blob.path, suffix: [], candidate: null}], blobs: [blob]}),
    caseIds: ["tiny-registration"], concurrency: 2,
    admission: {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: hash(checkpoint)}, currentPath: "docs/a.md",
      policy: {maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 100000, maxStructClientGroupVisits: 10000, maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000},
      bounds: {maxCheckpointBytes: 100000, maxSubmissionBytes: 100000, maxAdmissionBytes: 1000000, maxUpdateBytes: 100000}},
    renderingContext: json("context.json", {version: 1, environment: "jsdom-production-components", images: {}, links: {}}),
    implementationPins: adapterImplementationPaths.map(path => pinFile(resolve(repo, path))),
    wire: {baselineCase: "tiny-registration", rounds: [0, 1].map(round => ({updates: [0, 1].map(client => ({client, ...step(`round-${round}-client-${client}`)}))}))}, transitions};
  const seal = () => json("selection.json", selection);
  return {root, selection, seal, save, json, blob, checkpoint};
}

it("builds both current manifests while preserving sources and keeping restore bytes runtime-derived", () => fixture(f => {
  const result = preparePublicWorkload(f.seal(), join(f.root, "output"), renderPublicFixture);
  const wire = readPublicWorkload(result.wirePin, 2), transitions = readPublicTransitionWorkload(result.transitionPin, 2);
  expect(wire.checkpoint).toEqual(Buffer.from(f.checkpoint));
  expect(wire.rounds).toHaveLength(2);
  expect(transitions.cases.restore.continuation?.recipe.text).toBe("restore-continuation");
  expect(transitions.manifest.cases.restore.resumed).toBeUndefined();
  const receipt = JSON.parse(readFileSync(result.receipt.path, "utf8"));
  expect(receipt).toMatchObject({purpose: "tiny-adapter-test", releaseAccepted: false, browserProofComplete: false});
  expect(receipt.sourceAssets[0].preserved.sha256).toBe(f.blob.sha256);
  expect(receipt.derivations.find((item: {kind?: string}) => item.kind === "recipe-only-awaiting-native-restore").submittedCandidate).toBeNull();
  const first = wire.rounds[0]!.updates, second = wire.rounds[1]!.updates;
  const ids = first.map(update => new Set(Y.decodeUpdate(update.content).structs.map(item => item.id.client)));
  expect(ids.every(set => set.size === 1)).toBe(true);
  expect([...ids[0]!][0]).not.toBe([...ids[1]!][0]);
  for (let index = 0; index < 2; index++) expect(new Set(Y.decodeUpdate(second[index]!.content).structs.map(item => item.id.client))).toEqual(ids[index]);
  const reverse = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(reverse, wire.checkpoint);
    for (const round of wire.rounds) for (const update of [...round.updates].reverse()) Y.applyUpdate(reverse, update.content);
    expect(renderPublicFixture(Y.encodeStateAsUpdate(reverse), {version: 1, environment: "jsdom-production-components", images: {}, links: {}}).markdown).toBe(wire.rounds[1]!.markdown.toString());
  } finally {reverse.destroy();}
}));

it("produces deterministic fixture manifests for the same pinned selection", () => fixture(f => {
  const pin = f.seal(), one = preparePublicWorkload(pin, join(f.root, "one"), renderPublicFixture), two = preparePublicWorkload(pin, join(f.root, "two"), renderPublicFixture);
  expect(one.wirePin.sha256).toBe(two.wirePin.sha256); expect(one.transitionPin.sha256).toBe(two.transitionPin.sha256);
}));
it("executes the documented Node and tsx command with the existing JSX configuration", () => fixture(f => {
  const pin = f.json("selection-pin.json", f.seal()), output = join(f.root, "cli-output");
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-public-workload.mjs", pin.path, output],
    {cwd: resolve(repo, "services/share-web"), encoding: "utf8", timeout: 30000, windowsHide: true});
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
  expect(readPublicWorkload(result.wirePin, 2).rounds).toHaveLength(2);
  expect(readPublicTransitionWorkload(result.transitionPin, 2).cases.restore.continuation).toBeDefined();
  // The run took 15 s beside 32 CPU burners, so the test bound sits above its 30 s child bound.
}), 45_000);
it("rejects absent selection, changed source pins and a baseline over explicit bounds", () => fixture(f => {
  f.selection.caseIds = []; expect(() => preparePublicWorkload(f.seal(), join(f.root, "missing"), renderPublicFixture)).toThrow("case IDs");
  f.selection.caseIds = ["tiny-registration"]; f.selection.admission.bounds.maxCheckpointBytes = 1;
  expect(() => preparePublicWorkload(f.seal(), join(f.root, "bound"), renderPublicFixture)).toThrow("selected bounds");
  f.selection.admission.bounds.maxCheckpointBytes = 100000; writeFileSync(f.blob.path, "changed");
  expect(() => preparePublicWorkload(f.seal(), join(f.root, "changed"), renderPublicFixture)).toThrow("Changed input");
}));
it("rejects an ineffective selected candidate without substituting a recipe", () => fixture(f => {
  f.selection.corpus = f.json("ineffective.json", {cases: [{id: "tiny-registration", mode: "journal-candidate", checkpoint: f.blob.path, suffix: [], candidate: f.blob.path}], blobs: [f.blob]});
  expect(() => preparePublicWorkload(f.seal(), join(f.root, "ineffective"), renderPublicFixture)).toThrow(/no state|not admissible/);
}));
it("rejects source updates supplied through wire JSON", () => fixture(f => {
  const step = f.selection.wire.rounds[0]!.updates[0]!;
  Reflect.deleteProperty(step, "recipe");
  Object.assign(step, {source: {caseId: "tiny-registration", part: "candidate"}});
  expect(() => preparePublicWorkload(f.seal(), join(f.root, "wire-source"), renderPublicFixture)).toThrow("Wire updates require recipes");
}));
it("preserves a selected source candidate mapped to a transition", () => fixture(f => {
  const doc = new Y.Doc({gc: false});
  let candidate: WorkloadPin;
  try {
    Y.applyUpdate(doc, f.checkpoint);
    const vector = Y.encodeStateVector(doc), paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
    text.insert(0, "Selected candidate"); paragraph.insert(0, [text]); doc.getXmlFragment("body").push([paragraph]);
    candidate = f.save("selected-candidate.bin", Y.encodeStateAsUpdate(doc, vector));
  } finally {doc.destroy();}
  f.selection.corpus = f.json("selected-candidate.json", {cases: [{id: "tiny-registration", mode: "journal-candidate", checkpoint: f.blob.path, suffix: [], candidate: candidate.path}], blobs: [f.blob, candidate]});
  f.selection.transitions.view.updates = [{deliveryId: "selected-view-candidate", source: {caseId: "tiny-registration", part: "candidate"}}];
  const result = preparePublicWorkload(f.seal(), join(f.root, "source-mapping"), renderPublicFixture);
  const workload = readPublicTransitionWorkload(result.transitionPin, 2);
  expect(workload.cases.view.updates[0]!.bytes).toEqual(readFileSync(candidate.path));
  expect(workload.cases.view.updates[0]!.expected.viewText.toString()).toContain("Selected candidate");
}));
it("rejects a product-refused checkpoint without shrinking it", () => fixture(f => {
  const doc = new Y.Doc({gc: false}); doc.getMap("private-extra-root").set("data", "x");
  const blob = f.save("invalid.bin", Y.encodeStateAsUpdate(doc)); doc.destroy();
  f.selection.corpus = f.json("invalid.json", {cases: [{id: "tiny-registration", mode: "registration", checkpoint: blob.path, suffix: [], candidate: null}], blobs: [blob]});
  expect(() => preparePublicWorkload(f.seal(), join(f.root, "refused"), renderPublicFixture)).toThrow("Registration refused");
}));
it("uses distinct production Markdown, editor and View rendering with explicit image resolution", () => {
  const path = `/api/view/blob/${"a".repeat(64)}`, doc = markdownToYDoc("Before\n\n![Cat](cat.png)\n\nAfter");
  try {
    const checkpoint = Y.encodeStateAsUpdate(doc), context = {version: 1 as const, environment: "jsdom-production-components" as const, images: {"cat.png": path}, links: {}};
    const rendered = renderPublicFixture(checkpoint, context);
    expect(rendered.markdown).toContain("![Cat]"); expect(rendered.editorText).toContain("[Image: Cat]"); expect(rendered.viewText).not.toContain("Cat");
    expect(renderPublicFixture(checkpoint, {...context, images: {"cat.png": null}}).viewText).toContain("Cat");
  } finally {doc.destroy();}
});
it.each([
  ["image", "![Cat](cat.png)", "cat.png"],
  ["link", "[Other](other.md)", "other.md"],
])("rejects a missing %s resolver entry outside React rendering", (_kind, markdown, href) => {
  const doc = markdownToYDoc(markdown);
  try {
    expect(() => renderPublicFixture(Y.encodeStateAsUpdate(doc), {version: 1, environment: "jsdom-production-components", images: {}, links: {}}))
      .toThrow(`Rendering context has no resolution for ${href}`);
  } finally {doc.destroy();}
});
