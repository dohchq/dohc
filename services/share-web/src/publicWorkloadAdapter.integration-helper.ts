import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, isAbsolute, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import {createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import type {OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/live-journal-validation";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {readPublicWorkload, type WorkloadPin} from "./publicLinkWorkload.integration-helper.js";
import {parseRestoreContinuationRecipe, readPublicTransitionWorkload, transitionNames, validateInterruptedPublicUpdate, workloadHash as hash, type RestoreContinuationRecipe} from "./publicTransitionWorkload.integration-helper.js";

type Recipe = RestoreContinuationRecipe;
type Source = {caseId: string; part: "candidate" | "suffix"; index?: number};
type Step = {deliveryId: string} & ({source: Source} | {recipe: Recipe});
type Transition = {baselineCase: string; updates: Step[]; interrupted?: Step; resumed?: Step; continuation?: {deliveryId: string; recipe: Recipe}};
export interface PublicFixtureSelection {
  version: 1;
  purpose: "selected-public-proof" | "tiny-adapter-test";
  selectionEvidence: WorkloadPin[];
  corpus: WorkloadPin;
  caseIds: string[];
  concurrency: number;
  admission: {document: LiveDocumentKey; currentPath: string; policy: OrderedLiveUpdateCutPolicy;
    bounds: {maxCheckpointBytes: number; maxSubmissionBytes: number; maxAdmissionBytes: number; maxUpdateBytes: number}};
  renderingContext: WorkloadPin;
  implementationPins: WorkloadPin[];
  wire: {baselineCase: string; rounds: {updates: {client: number; deliveryId: string; recipe: Recipe}[]}[]};
  transitions: Record<(typeof transitionNames)[number] | "view", Transition>;
}
export interface FixtureRenderingContext {
  version: 1;
  environment: "jsdom-production-components";
  images: Record<string, string | null>;
  links: Record<string, string | null>;
}
export type FixtureRenderer = (checkpoint: Uint8Array, context: FixtureRenderingContext) => {markdown: string; editorText: string; viewText: string};
type CorpusCase = {id: string; mode: "registration" | "journal-candidate"; checkpoint: string; suffix: string[]; candidate: string | null};
type Projection = {markdown: WorkloadPin; editorText: WorkloadPin; viewText: WorkloadPin};
type OutputStep = {deliveryId: string; bytes: WorkloadPin; expected: Projection};
type OutputTransition = {baseline: Projection & {checkpoint: WorkloadPin}; updates: OutputStep[];
  interrupted?: {deliveryId: string; bytes: WorkloadPin}; resumed?: OutputStep; continuation?: {deliveryId: string; recipe: WorkloadPin; expected: Projection}};

export const adapterImplementationPaths = [
  "services/share-web/src/publicWorkloadAdapter.integration-helper.ts", "services/share-web/src/publicWorkloadRendering.integration-helper.ts",
  "services/share-web/scripts/prepare-public-workload.mjs", "services/share-web/src/publicLinkWorkload.integration-helper.ts",
  "services/share-web/src/publicTransitionWorkload.integration-helper.ts", "services/share-web/viewer/src/MarkdownContent.tsx",
  "services/share-web/viewer/src/markdown.ts", "services/share-web/viewer/src/imageRetry.ts",
  "packages/ydoc-projection/src/browser-editor.ts", "packages/ydoc-projection/src/import-export.ts",
  "packages/ydoc-projection/src/liveDocumentValidation.ts", "packages/ydoc-projection/src/orderedLiveUpdateCut.ts", "pnpm-lock.yaml",
];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function requireValue(condition: unknown, message: string): asserts condition {if (!condition) throw new Error(message);}
function read(pin: WorkloadPin, base: string) {
  requireValue(pin && typeof pin.path === "string" && /^[a-f0-9]{64}$/iu.test(pin.sha256) && Number.isSafeInteger(pin.byteLength), "Invalid input pin.");
  const bytes = readFileSync(resolve(base, pin.path));
  requireValue(bytes.length === pin.byteLength && hash(bytes) === pin.sha256.toLowerCase(), `Changed input: ${pin.path}`);
  return bytes;
}
function clone(bytes: Uint8Array) {const doc = new Y.Doc({gc: false}); Y.applyUpdate(doc, bytes); return doc;}
function append(doc: Y.Doc, recipe: Recipe) {
  parseRestoreContinuationRecipe(Buffer.from(JSON.stringify(recipe)));
  const paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
  text.insert(0, recipe.text); paragraph.insert(0, [text]); doc.getXmlFragment("body").push([paragraph]);
}

// The selection contains every amount and mapping. This adapter never searches or scales cases.
export function preparePublicWorkload(selectionPin: WorkloadPin, output: string, render: FixtureRenderer) {
  requireValue(isAbsolute(selectionPin.path) && isAbsolute(output), "Selection and output paths must be absolute.");
  const base = dirname(selectionPin.path), selected = JSON.parse(read(selectionPin, base).toString()) as PublicFixtureSelection;
  requireValue(selected.version === 1 && ["selected-public-proof", "tiny-adapter-test"].includes(selected.purpose), "Explicit selection required.");
  requireValue(selected.selectionEvidence?.length && selected.caseIds?.length && new Set(selected.caseIds).size === selected.caseIds.length, "Selection evidence and distinct case IDs required.");
  requireValue(Number.isSafeInteger(selected.concurrency) && selected.concurrency > 0 && selected.wire?.rounds?.length, "Explicit concurrency and rounds required.");
  selected.selectionEvidence.forEach(pin => read(pin, base));
  const implementationPaths = new Set(selected.implementationPins.map(pin => {read(pin, base); return resolve(base, pin.path);}));
  for (const path of adapterImplementationPaths) {
    requireValue(implementationPaths.has(resolve(repo, path)), `Missing implementation pin: ${path}`);
  }
  const context = JSON.parse(read(selected.renderingContext, base).toString()) as FixtureRenderingContext;
  requireValue(context.version === 1 && context.environment === "jsdom-production-components" && context.images && context.links, "Explicit rendering context required.");
  for (const table of [context.images, context.links]) requireValue(!Array.isArray(table) && typeof table === "object" && Object.values(table).every(value => value === null || typeof value === "string"), "Invalid resolver table.");
  const {document, currentPath, policy, bounds} = selected.admission;
  for (const name of ["maxCheckpointBytes", "maxSubmissionBytes", "maxAdmissionBytes", "maxUpdateBytes"] as const) requireValue(Number.isSafeInteger(bounds[name]) && bounds[name] > 0, `Explicit ${name} required.`);
  const register = createLiveMarkdownRegistrationValidator(policy), validate = createLiveMarkdownJournalValidator(policy);
  const corpus = JSON.parse(read(selected.corpus, base).toString()) as {cases: CorpusCase[]; blobs: WorkloadPin[]};
  requireValue(Array.isArray(corpus.cases) && Array.isArray(corpus.blobs), "Invalid selected corpus.");
  requireValue(new Set(corpus.cases.map(item => item.id)).size === corpus.cases.length && new Set(corpus.blobs.map(item => item.path)).size === corpus.blobs.length, "Duplicate corpus identity.");
  const sourceBase = dirname(resolve(base, selected.corpus.path)), blobs = new Map<string, Uint8Array>(), cases = new Map<string, CorpusCase>(), usedClients = new Set<number>();
  const admissions: unknown[] = [], derivations: unknown[] = [];
  function admit(checkpoint: Uint8Array, suffix: Uint8Array[], candidate: Uint8Array) {
    const evidence = validateInterruptedPublicUpdate({document, currentPath, checkpoint, suffix, candidate, bounds, validate});
    admissions.push({checkpoint: hash(checkpoint), suffix: suffix.map(hash), ...evidence});
  }
  function registration(checkpoint: Uint8Array) {
    requireValue(checkpoint.length <= bounds.maxCheckpointBytes && checkpoint.length <= bounds.maxAdmissionBytes, "Checkpoint exceeds selected bounds.");
    const verdict = register({document, currentPath, checkpoint});
    requireValue(verdict.kind === "accepted", `Registration refused: ${JSON.stringify(verdict)}`);
    admissions.push({checkpoint: hash(checkpoint), projectedMarkdownSha256: verdict.evidence.projectedMarkdownSha256});
  }
  function bytes(path: string) {
    const cached = blobs.get(path); if (cached) return cached;
    const pin = corpus.blobs.find(item => item.path === path); requireValue(pin, `Missing corpus blob: ${path}`);
    const value = read(pin, sourceBase), decoded = Y.decodeUpdate(value);
    for (const item of decoded.structs) usedClients.add(item.id.client);
    for (const client of decoded.ds.clients.keys()) usedClients.add(client);
    blobs.set(path, value); return value;
  }
  for (const id of selected.caseIds) {
    const item = corpus.cases.find(item => item.id === id); requireValue(item, `Missing selected case: ${id}`);
    requireValue(Array.isArray(item.suffix) && (item.mode === "registration" ? !item.suffix.length && item.candidate === null : item.mode === "journal-candidate" && typeof item.candidate === "string"), `Invalid selected cut: ${id}`);
    cases.set(id, item); const checkpoint = bytes(item.checkpoint), suffix = item.suffix.map(bytes);
    registration(checkpoint);
    for (let index = 0; index < suffix.length; index++) admit(checkpoint, suffix.slice(0, index), suffix[index]!);
    if (item.candidate !== null) admit(checkpoint, suffix, bytes(item.candidate));
  }
  let nextClient = 1;
  function writer() {while (usedClients.has(nextClient)) nextClient++; requireValue(nextClient <= 0xffffffff, "No independent writer ID available."); usedClients.add(nextClient); return nextClient++;}
  function baseline(id: string) {const item = cases.get(id); requireValue(item, `Unselected baseline: ${id}`); return bytes(item.checkpoint);}
  function source(value: Source) {
    const item = cases.get(value.caseId); requireValue(item, "Update references an unselected case.");
    const path = value.part === "candidate" ? item.candidate : value.part === "suffix" && Number.isSafeInteger(value.index) ? item.suffix[value.index!] : null;
    requireValue(path, "Invalid selected update reference."); return bytes(path);
  }
  // mkdir is exclusive: a failed attempt remains inspectable and cannot be overwritten.
  mkdirSync(output);
  const assets = new Map<string, WorkloadPin>();
  function save(content: Uint8Array) {
    const sha256 = hash(content), path = `${sha256}.asset`, existing = assets.get(path); if (existing) return existing;
    writeFileSync(resolve(output, path), content, {flag: "wx"}); const pin = {path, sha256, byteLength: content.length}; assets.set(path, pin); return pin;
  }
  const json = (value: unknown) => save(Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  const sourceAssets = [...blobs].map(([path, value]) => ({source: {...corpus.blobs.find(pin => pin.path === path)!, path: resolve(sourceBase, path)}, preserved: save(value)}));
  function projection(doc: Y.Doc): Projection {
    const value = render(Y.encodeStateAsUpdate(doc), context);
    requireValue(value.markdown === yDocToMarkdown(doc), "Renderer changed the selected Markdown projection.");
    return {markdown: save(Buffer.from(value.markdown)), editorText: save(Buffer.from(value.editorText)), viewText: save(Buffer.from(value.viewText))};
  }
  function generate(doc: Y.Doc, step: Step, clientId: number) {
    requireValue(Boolean("source" in step) !== Boolean("recipe" in step), "Each update requires exactly one source or recipe.");
    if ("source" in step) return source(step.source);
    const draft = clone(Y.encodeStateAsUpdate(doc));
    try {
      draft.clientID = clientId; const vector = Y.encodeStateVector(draft); append(draft, step.recipe);
      const update = Y.encodeStateAsUpdate(draft, vector), decoded = Y.decodeUpdate(update);
      requireValue(decoded.structs.length && decoded.structs.every(item => item.id.client === clientId), "Recipe reused source writer structs.");
      derivations.push({deliveryId: step.deliveryId, recipe: step.recipe, clientId, startStateVectorSha256: hash(vector), updateSha256: hash(update)});
      return update;
    } finally {draft.destroy();}
  }
  const wireCheckpoint = baseline(selected.wire.baselineCase), wireDoc = clone(wireCheckpoint), wireSuffix: Uint8Array[] = [], clients = Array.from({length: selected.concurrency}, writer);
  const wire = {version: 1, concurrency: selected.concurrency, baseline: {checkpoint: save(wireCheckpoint), markdown: save(Buffer.from(yDocToMarkdown(wireDoc)))}, rounds: [] as {updates: {client: number; deliveryId: string; bytes: WorkloadPin}[]; markdown: WorkloadPin}[]};
  try {
    for (const round of selected.wire.rounds) {
      requireValue(round.updates.length === selected.concurrency && new Set(round.updates.map(item => item.client)).size === selected.concurrency, "Round needs every independent writer.");
      const updates = round.updates.map(step => {
        requireValue("recipe" in step && !("source" in step), "Wire updates require recipes, not source updates.");
        requireValue(Number.isSafeInteger(step.client) && step.client >= 0 && step.client < clients.length, "Invalid writer index.");
        return {step, bytes: generate(wireDoc, step, clients[step.client]!)};
      });
      for (const update of updates) {
        // Check both first delivery and delivery after every other concurrent writer.
        admit(wireCheckpoint, wireSuffix, update.bytes);
        admit(wireCheckpoint, [...wireSuffix, ...updates.filter(other => other !== update).map(other => other.bytes)], update.bytes);
      }
      for (const update of updates) {Y.applyUpdate(wireDoc, update.bytes); wireSuffix.push(update.bytes);}
      wire.rounds.push({updates: updates.map(({step, bytes}) => ({client: step.client, deliveryId: step.deliveryId, bytes: save(bytes)})), markdown: save(Buffer.from(yDocToMarkdown(wireDoc)))});
    }
  } finally {wireDoc.destroy();}
  requireValue(Object.keys(selected.transitions).sort().join() === [...transitionNames, "view"].sort().join(), "All transitions require explicit mappings.");
  const transitions: Record<string, OutputTransition> = {};
  for (const name of [...transitionNames, "view"] as const) {
    const input = selected.transitions[name], checkpoint = baseline(input.baselineCase), doc = clone(checkpoint), suffix: Uint8Array[] = [], clientId = writer();
    try {
      requireValue(input.updates.length, "Transition requires accepted updates.");
      requireValue(name === "view" ? !input.interrupted : Boolean(input.interrupted), "Explicit interrupted coverage required.");
      requireValue(["restart", "staleFrame"].includes(name) === Boolean(input.resumed) && (name === "restore") === Boolean(input.continuation), "Invalid continuation mapping.");
      const item: OutputTransition = {baseline: {...projection(doc), checkpoint: save(checkpoint)}, updates: []};
      function apply(step: Step) {
        const update = generate(doc, step, clientId); admit(checkpoint, suffix, update); Y.applyUpdate(doc, update); suffix.push(update);
        return {deliveryId: step.deliveryId, bytes: save(update), expected: projection(doc)};
      }
      item.updates = input.updates.map(apply);
      if (input.interrupted) {const update = generate(doc, input.interrupted, writer()); admit(checkpoint, suffix, update); item.interrupted = {deliveryId: input.interrupted.deliveryId, bytes: save(update)};}
      if (input.resumed) item.resumed = apply(input.resumed);
      if (input.continuation) {
        const restored = clone(checkpoint);
        try {
          restored.clientID = writer(); append(restored, input.continuation.recipe);
          item.continuation = {deliveryId: input.continuation.deliveryId, recipe: json(input.continuation.recipe), expected: projection(restored)};
          derivations.push({deliveryId: input.continuation.deliveryId, kind: "recipe-only-awaiting-native-restore", recipe: item.continuation.recipe, submittedCandidate: null});
        } finally {restored.destroy();}
      }
      transitions[name] = item;
    } finally {doc.destroy();}
  }
  const absolute = (pin: WorkloadPin) => ({...pin, path: resolve(output, pin.path)});
  const wirePin = absolute(json(wire)), transitionPin = absolute(json({version: 1, concurrency: selected.concurrency, cases: transitions}));
  readPublicWorkload(wirePin, selected.concurrency); readPublicTransitionWorkload(transitionPin, selected.concurrency);
  const receipt = absolute(json({version: 1, status: "fixtures-prepared", purpose: selected.purpose, releaseAccepted: false, browserProofComplete: false,
    selectionPin, selection: selected, renderingContext: context, sourceAssets, admissions, derivations, wirePin, transitionPin, assets: [...assets.values()]}));
  writeFileSync(resolve(output, "result.json"), JSON.stringify({wirePin, transitionPin, receipt}, null, 2) + "\n", {flag: "wx"});
  return {wirePin, transitionPin, receipt};
}
