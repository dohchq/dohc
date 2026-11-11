import {createHash} from "node:crypto";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {encodeLiveFrameSync} from "@dohc/live-session-contract/live-frame";
import {createLiveMarkdownRegistrationValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {markdownToYDoc, yDocToMarkdown} from "../../../packages/ydoc-projection/src/import-export";
import {parseNamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import {parseNamedLiveConfig} from "./namedLiveConfig";
import {parseNamedLiveBrowserHttpLimits} from "./namedLiveBrowserHttp";
import {parseLiveRestoreConfig} from "./liveRestorePreparation";
import {parseNativeLiveSyncConfig} from "./liveSyncConfig";
import {parseServiceActivationConfig} from "./serviceActivationDriver";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {parseLiveGatewayLimits} from "../../share-web/src/liveGateway";
import {parseNamedLiveBrowserClientLimits} from "../../share-web/src/namedLiveBrowserClient";

it("uses mutually compatible browser, relay, native and owner limits", () => {
  const profile = selfHostLiveProfile();
  const relay = parseNamedLiveConfig(profile.namedLive);
  const editor = parseNamedLiveBrowserLimits(profile.editor);
  const gateway = parseLiveGatewayLimits(profile.gateway);
  expect(parseNamedLiveBrowserHttpLimits(profile.browserSessions)).toEqual(profile.browserSessions);
  expect(parseNamedLiveBrowserClientLimits(profile.requests)).toEqual(profile.requests);
  expect(editor.provider.frames.receive.maxFrameBytes).toBeLessThanOrEqual(gateway.maxFrameBytes);
  expect(gateway.maxFrameBytes).toBeLessThanOrEqual(relay.frames.receive.maxFrameBytes);
  expect(parseNativeLiveSyncConfig(profile.service.sync, profile.service.ingress.aggregateBytes)).toEqual(profile.service.sync);
  expect(parseServiceActivationConfig({...profile.service.activation, targets: [{workspaceId: "workspace", shareId: "share", path: "doc.md"}]})).toMatchObject({maxCaptureBytes: profile.service.activation.maxCaptureBytes});
  expect(profile.service.activation.maxCaptureBytes).toBeLessThanOrEqual(profile.nativeIngress.sync.policy.maxOutputBytes);
  // The supported server offers the owner's stop-access restore.
  expect(parseLiveRestoreConfig(profile.service.restore)).toMatchObject({maxBytes: profile.service.restore.maxBytes, maxEvents: profile.service.restore.maxEvents});
});

it("returns independent capacity profiles so one caller cannot change another", () => {
  const first = selfHostLiveProfile(), second = selfHostLiveProfile();
  first.frames.receive.maxFrameBytes = 1;
  first.nativeIngress.ingress.aggregateBytes = 1;
  expect(second.frames.receive.maxFrameBytes).toBe(64 * 1024);
  expect(second.nativeIngress.ingress.aggregateBytes).toBe(512 * 1024 * 1024);
});

it("uses one policy for journal admission, activation and restores", () => {
  const profile = selfHostLiveProfile();
  expect(profile.service.activation.validation).toEqual(profile.namedLive.validation);
  expect(profile.service.restore.validation).toEqual(profile.namedLive.validation);
  expect(profile.validation).toMatchObject({maxStructVisits: 400_000, maxIndexOperations: 100_000_000});
  profile.validation.maxIndexOperations = 1;
  expect(selfHostLiveProfile().validation.maxIndexOperations).toBe(100_000_000);
});

// The largest state the live bound admits is a note carrying a copy of its source, as the source editor
// writes for Markdown dohc reads differently. The edge note travels as one update, one sync, one capture and
// one restore; one paragraph more is refused as too dense, never by a transfer limit. Run it after changing
// the bound or a transfer limit.
it("carries the largest note the live bound admits through every transfer limit", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const paragraph = "Measured text café 日本語 مرحبا with _soft_ emphasis. ".repeat(20) + "\n\n";
  const note = (paragraphs: number) => {
    const markdown = paragraph.repeat(paragraphs), doc = markdownToYDoc(markdown, {clientID: 101});
    try {
      const canonical = yDocToMarkdown(doc);
      expect(canonical).not.toBe(markdown);
      doc.transact(() => {
        const meta = doc.getMap("meta");
        meta.set("dohcMarkdownSource", markdown); meta.set("dohcMarkdownSourceSha256", sha(markdown));
        meta.set("dohcMarkdownSourceProjectionSha256", sha(canonical));
      });
      return {state: Y.encodeStateAsUpdate(doc), vector: Y.encodeStateVector(doc)};
    } finally {doc.destroy();}
  };
  const profile = selfHostLiveProfile(), validate = createLiveMarkdownRegistrationValidator(profile.validation);
  const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)};
  const edge = note(1204), over = note(1205);
  expect(validate({document, currentPath: "a.md", checkpoint: edge.state}).kind).toBe("accepted");
  expect(validate({document, currentPath: "a.md", checkpoint: over.state})).toMatchObject({kind: "refused", reason: "document-too-dense"});
  const size = edge.state.byteLength;
  expect(size).toBeGreaterThan(3.85 * 1024 * 1024);
  for (const limit of [profile.frames.receive.maxUpdateBytes, profile.editor.provider.maxPendingUpdateBytes,
    profile.namedLive.host.maxAppliedUpdateBytes, profile.namedLive.host.maxSyncOutputBytes, profile.nativeIngress.sync.policy.maxOutputBytes,
    profile.service.activation.maxCaptureBytes, profile.service.restore.maxBytes]) expect(size).toBeLessThanOrEqual(limit);
  const sync = encodeLiveFrameSync({binding: {...document, currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1},
    hostVector: edge.vector, missingStateUpdate: edge.state}, profile.frames.receive);
  expect(sync.byteLength).toBeLessThanOrEqual(profile.frames.maxAssemblyBytes);
  expect(over.state.byteLength).toBeLessThanOrEqual(profile.frames.receive.maxUpdateBytes);
}, 120_000);
