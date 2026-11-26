import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SafeOutboundError,
  type SafeOutboundDestination,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
} from "@dohc/service-http";
import type { TokenCipher } from "./cloudCredentialStore";
import { createLocalWorkspaceSecretStore } from "./localWorkspaceSecretStore";
import { createLocalOutboundWebhookExecutor } from "./localOutboundWebhookExecutor";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeCipher(): TokenCipher {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`sealed:${plain}`, "utf8").toString("base64"),
    decrypt: (cipher) => Buffer.from(cipher, "base64").toString("utf8").slice("sealed:".length),
  };
}

function fakeDestination(rawUrl: string): SafeOutboundDestination {
  const url = new URL(rawUrl);
  return {
    href: url.href,
    url,
    canonicalHost: url.hostname.toLowerCase(),
    address: "93.184.216.34",
    family: 4,
  };
}

const baseEffect = {
  kind: "http" as const,
  deliveryId: "a".repeat(64),
  collectionPath: "Tasks",
  automationId: "notify",
  stepOrdinal: 0,
  targetLabel: "api.resend.com",
  url: { kind: "literal" as const, url: "https://api.resend.com/emails" },
  headers: [{ name: "X-Event", value: "record-added" }],
  secretHeaders: [{ name: "Authorization", secret: "RESEND_API_KEY", prefix: "Bearer " }],
  body: JSON.stringify({ subject: "Hello" }),
  defaultContentType: "application/json" as const,
};

const dummyAutomation = {
  id: "notify",
  name: "Notify",
  enabled: true,
  when: { kind: "record-added" as const, table: null },
  if: null,
  do: [],
};

describe("localOutboundWebhookExecutor", () => {
  it("injects pinned header secret, standard headers, and returns status without leaking secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-local-webhook-"));
    dirs.push(dir);
    let clock = 1000;
    const secrets = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(),
      nowMs: () => (clock += 1),
    });
    await secrets.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_live_secret_xyz",
      allowedHosts: ["api.resend.com"],
    });

    const sent: Array<{ headers: Readonly<Record<string, string>>; body?: Buffer }> = [];
    const executor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async (raw) => fakeDestination(raw),
      sendRequest: async (request) => {
        sent.push({ headers: request.headers, body: request.body });
        return 202;
      },
    });

    const result = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: await secrets.list("ws-1"),
      effect: baseEffect,
      method: "POST",
      readResponse: false,
      depth: 1,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ ok: true, status: 202 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["Authorization"]).toBe("Bearer re_live_secret_xyz");
    expect(sent[0]!.headers["X-Event"]).toBe("record-added");
    expect(sent[0]!.headers["User-Agent"]).toBe("dohc-automation/1");
    expect(sent[0]!.headers["X-Dohc-Delivery-Id"]).toBe("a".repeat(64));
    expect(sent[0]!.headers["X-Dohc-Chain-Depth"]).toBe("2");
    expect(sent[0]!.headers["Content-Type"]).toBe("application/json");

    const approvedSecrets = await secrets.list("ws-1");
    await secrets.remove("ws-1", "RESEND_API_KEY");
    await secrets.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_live_secret_new",
      allowedHosts: ["api.resend.com"],
    });
    const recreated = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: approvedSecrets,
      effect: baseEffect,
      method: "POST",
      readResponse: false,
      depth: 1,
      signal: new AbortController().signal,
    });
    expect(recreated).toEqual({
      ok: false,
      reason: 'Secret "RESEND_API_KEY" changed while dohc was sending. Try again.',
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);
  });

  it("refuses a webhook link replaced while dohc looked up its address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-local-webhook-"));
    dirs.push(dir);
    let clock = 1000;
    const secrets = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(),
      nowMs: () => (clock += 1),
    });
    await secrets.set("ws-1", {
      name: "SLACK_HOOK",
      mode: "create",
      usage: "http-url",
      value: "https://hooks.example.com/old",
    });
    const approved = await secrets.list("ws-1");
    const sendRequest = vi.fn(async () => 200);
    const executor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async (raw) => {
        await secrets.set("ws-1", {
          name: "SLACK_HOOK",
          mode: "replace",
          usage: "http-url",
          value: "https://hooks.example.com/new",
        });
        return fakeDestination(raw);
      },
      sendRequest,
    });

    const result = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: approved,
      effect: { ...baseEffect, url: { kind: "secret", secret: "SLACK_HOOK" }, secretHeaders: [] },
      method: "POST",
      readResponse: false,
      depth: 0,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'Secret "SLACK_HOOK" changed while dohc was sending. Try again.',
      beforeSend: true,
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("refuses sending a header secret to a non-pinned host and enforces chain depth cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-local-webhook-"));
    dirs.push(dir);
    const secrets = createLocalWorkspaceSecretStore({ dir, cipher: fakeCipher() });
    await secrets.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_live_secret_xyz",
      allowedHosts: ["api.resend.com"],
    });
    const sendRequest = vi.fn(async () => 200);
    const executor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async (raw) => fakeDestination(raw),
      sendRequest,
    });

    const hostDenied = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: await secrets.list("ws-1"),
      effect: {
        ...baseEffect,
        url: { kind: "literal", url: "https://evil.example.com/steal" },
      },
      method: "POST",
      readResponse: false,
      depth: 0,
      signal: new AbortController().signal,
    });
    expect(hostDenied.ok).toBe(false);
    if (!hostDenied.ok) {
      expect(hostDenied.reason).toContain("not allowed for host");
      expect(hostDenied.reason).not.toContain("re_live_secret_xyz");
      expect(hostDenied.beforeSend).toBe(true);
    }
    expect(sendRequest).not.toHaveBeenCalled();

    const depthDenied = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: await secrets.list("ws-1"),
      effect: baseEffect,
      method: "POST",
      readResponse: false,
      depth: 4,
      signal: new AbortController().signal,
    });
    expect(depthDenied.ok).toBe(false);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("uses http-url secrets without exposing the secret URL or hostname in error messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-local-webhook-"));
    dirs.push(dir);
    const secrets = createLocalWorkspaceSecretStore({ dir, cipher: fakeCipher() });
    await secrets.set("ws-1", {
      name: "SLACK_HOOK",
      mode: "create",
      usage: "http-url",
      value: "https://hooks.slack.com/services/T1/B2/SUPERSECRET999",
    });
    await secrets.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_live_secret_xyz",
      allowedHosts: ["api.resend.com"],
    });
    const executor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async () => {
        throw new SafeOutboundError("unsafe_address", "blocked");
      },
      sendRequest: async () => 200,
    });

    const result = await executor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: await secrets.list("ws-1"),
      effect: {
        ...baseEffect,
        url: { kind: "secret", secret: "SLACK_HOOK" },
        secretHeaders: [],
      },
      method: "POST",
      readResponse: false,
      depth: 0,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("SUPERSECRET999");
      expect(result.reason).not.toContain("hooks.slack.com");
      expect(result.beforeSend).toBe(true);
    }

    const hostPinExecutor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async (raw) => fakeDestination(raw),
      sendRequest: async () => 200,
    });
    const secretUrlHostDenied = await hostPinExecutor.execute({
      collectionId: "col-1",
      collectionPath: "Tasks",
      automation: dummyAutomation,
      definitionDigest: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      codeFileHashes: [],
      secrets: await secrets.list("ws-1"),
      effect: {
        ...baseEffect,
        url: { kind: "secret", secret: "SLACK_HOOK" },
      },
      method: "POST",
      readResponse: false,
      depth: 0,
      signal: new AbortController().signal,
    });
    expect(secretUrlHostDenied.ok).toBe(false);
    if (!secretUrlHostDenied.ok) {
      expect(secretUrlHostDenied.reason).toContain("webhook destination host");
      expect(secretUrlHostDenied.reason).not.toContain("hooks.slack.com");
      expect(secretUrlHostDenied.reason).not.toContain("SUPERSECRET999");
      expect(secretUrlHostDenied.beforeSend).toBe(true);
    }
  });
  it("fetches JSON with GET under the fetch cap, scrubs echoed secrets, and refuses a non-JSON answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-local-fetch-"));
    dirs.push(dir);
    const secrets = createLocalWorkspaceSecretStore({ dir, cipher: fakeCipher() });
    await secrets.set("ws-1", {
      name: "STATS_KEY",
      mode: "create",
      usage: "http-header",
      value: "phx_live_secret_abc",
      allowedHosts: ["api.example.com"],
    });
    const requests: SafeOutboundRequest[] = [];
    let answer: SafeOutboundResponse = {
      status: 200,
      contentType: "application/json; charset=utf-8",
      contentEncoding: null,
      body: Buffer.from(
        JSON.stringify({ count: 7, echoed: { authorization: "Bearer phx_live_secret_abc" } }),
      ),
    };
    const executor = createLocalOutboundWebhookExecutor({
      workspaceId: "ws-1",
      secrets,
      resolveDestination: async (raw) => fakeDestination(raw),
      sendRequest: async () => {
        throw new Error("a fetch must read its response");
      },
      readRequest: async (request) => {
        requests.push(request);
        return answer;
      },
    });
    const approved = await secrets.list("ws-1");
    const fetch = () =>
      executor.execute({
        collectionId: "col-1",
        collectionPath: "Tasks",
        automation: dummyAutomation,
        definitionDigest: "b".repeat(64),
        approvalDigest: "c".repeat(64),
        codeFileHashes: [],
        secrets: approved,
        effect: {
          ...baseEffect,
          targetLabel: "api.example.com",
          url: { kind: "literal", url: "https://api.example.com/stats" },
          headers: [],
          secretHeaders: [{ name: "Authorization", secret: "STATS_KEY", prefix: "Bearer " }],
          body: null,
          defaultContentType: null,
        },
        method: "GET",
        readResponse: true,
        depth: 0,
        signal: new AbortController().signal,
      });

    expect(await fetch()).toEqual({
      ok: true,
      status: 200,
      response: { count: 7, echoed: { authorization: "Bearer [redacted]" } },
    });
    expect(requests[0]).toMatchObject({
      method: "GET",
      body: undefined,
      maxResponseBytes: 192 * 1024,
    });
    expect(requests[0]?.headers.Authorization).toBe("Bearer phx_live_secret_abc");

    answer = { ...answer, contentType: "text/html" };
    const html = await fetch();
    expect(html).toMatchObject({ ok: false });
    if (!html.ok) expect(html.reason).toContain("JSON");

    answer = { ...answer, status: 401, contentType: "application/json", body: Buffer.from("{}") };
    expect(await fetch()).toMatchObject({ ok: false, status: 401 });
  });
});
