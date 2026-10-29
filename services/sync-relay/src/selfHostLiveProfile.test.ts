import {expect, it} from "vitest";
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
