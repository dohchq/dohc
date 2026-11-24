import { expect, it } from "vitest";
import { parseNamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import { parseNamedLiveRouteLimits } from "./namedLiveRoutes";
import { parseNamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import { parseNativeLiveSyncConfig } from "./liveSyncConfig";
import { parseServiceActivationConfig } from "./serviceActivationDriver";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { parseLiveGatewayLimits } from "../../share-web/src/liveGateway";
import { parseNamedLiveBrowserClientLimits } from "../../share-web/src/namedLiveBrowserClient";

it("uses mutually compatible browser, relay, native and owner limits", () => {
  const profile = selfHostLiveProfile();
  const relay = parseNamedLiveConfig(profile.namedLive);
  const editor = parseNamedLiveBrowserLimits(profile.editor);
  const gateway = parseLiveGatewayLimits(profile.gateway);
  expect(parseNamedLiveBrowserHttpLimits(profile.browserSessions)).toEqual(profile.browserSessions);
  expect(parseNamedLiveBrowserClientLimits(profile.requests)).toEqual(profile.requests);
  expect(editor.provider.frames.receive.maxFrameBytes).toBeLessThanOrEqual(gateway.maxFrameBytes);
  expect(gateway.maxFrameBytes).toBeLessThanOrEqual(relay.frames.receive.maxFrameBytes);
  expect(
    parseNativeLiveSyncConfig(profile.service.sync, profile.service.ingress.aggregateBytes),
  ).toEqual(profile.service.sync);
  expect(
    parseServiceActivationConfig({
      ...profile.service.activation,
      targets: [{ workspaceId: "workspace", path: "doc.md" }],
    }),
  ).toMatchObject({ maxCaptureBytes: profile.service.activation.maxCaptureBytes });
  expect(profile.service.activation.maxCaptureBytes).toBeLessThanOrEqual(
    profile.nativeIngress.sync.policy.maxOutputBytes,
  );
});

it("returns independent capacity profiles so one caller cannot change another", () => {
  const first = selfHostLiveProfile(),
    second = selfHostLiveProfile();
  first.frames.receive.maxFrameBytes = 1;
  first.nativeIngress.ingress.aggregateBytes = 1;
  expect(second.frames.receive.maxFrameBytes).toBe(64 * 1024);
  expect(second.nativeIngress.ingress.aggregateBytes).toBe(512 * 1024 * 1024);
});

it("uses one policy for journal admission and activation", () => {
  const profile = selfHostLiveProfile();
  expect(profile.service.activation.validation).toEqual(profile.namedLive.validation);
  expect(profile.validation).toMatchObject({
    maxStructVisits: 400_000,
    maxIndexOperations: 100_000_000,
  });
  profile.validation.maxIndexOperations = 1;
  expect(selfHostLiveProfile().validation.maxIndexOperations).toBe(100_000_000);
});

it("holds live connections for a community of 100 members, and keeps 16 for the owner", () => {
  const { namedLive, gateway } = selfHostLiveProfile();
  const transport = parseNamedLiveRouteLimits({ ...namedLive.transport });
  expect(transport).toMatchObject({
    maxConnections: 384,
    maxConnectionsPerWorkspace: 192,
    reservedOwnerConnections: 16,
    maxConnectionsPerGrant: 80,
    maxConnectionsPerPrincipal: 12,
    maxBufferedBytes: 128 * 1024 * 1024,
  });
  // Members and other recipients share what the owner's 16 leave.
  expect(transport.maxConnectionsPerWorkspace - transport.reservedOwnerConnections).toBe(176);
  expect(gateway).toMatchObject({
    maxConnections: 384,
    maxConnectionsPerWorkspace: 192,
    reservedOwnerConnections: 16,
  });
  // Each connection holds two frame listeners; the rest serve desktop opens and readiness waits.
  expect(namedLive.maxListeners).toBeGreaterThanOrEqual(2 * transport.maxConnections);
  expect(parseNamedLiveConfig(namedLive).maxListeners).toBe(namedLive.maxListeners);
});

it("keeps each byte portion when the connection caps rise", () => {
  const { namedLive, gateway } = selfHostLiveProfile(),
    MiB = 1024 * 1024;
  // A person still takes three 4 MiB syncs, and a share or a workspace's
  // recipients still leave 48 MiB for other workspaces.
  const portions = {
    maxBufferedBytes: 128 * MiB,
    maxBufferedBytesPerPrincipal: 12 * MiB,
    maxBufferedBytesPerShare: 80 * MiB,
    maxBufferedBytesPerWorkspace: 80 * MiB,
  };
  expect(parseNamedLiveRouteLimits({ ...namedLive.transport })).toMatchObject(portions);
  expect(parseLiveGatewayLimits({ ...gateway })).toMatchObject(portions);
  for (const name of [
    "maxBufferedBytesPerPrincipal",
    "maxBufferedBytesPerShare",
    "maxBufferedBytesPerWorkspace",
  ] as const) {
    expect(() =>
      parseNamedLiveRouteLimits({
        ...namedLive.transport,
        [name]: namedLive.transport.maxBufferedBytes + 1,
      }),
    ).toThrow("Invalid named route limits");
    expect(() =>
      parseLiveGatewayLimits({ ...gateway, [name]: gateway.maxBufferedBytes + 1 }),
    ).toThrow("Invalid live gateway limits");
  }
});
