import {afterEach, expect, it, vi} from "vitest";
import {LiveAuthorityUnavailableError} from "@dohc/ydoc-projection/named-live-browser-transport";
import {LINK_REFUSALS, linkRefusalBody, type LinkRefusalCode} from "@dohc/security-contract/link-refusal";
import {namedRequest, ShareAccessRemovedError} from "./namedRecipient";

afterEach(() => vi.unstubAllGlobals());

it.each(Object.keys(LINK_REFUSALS) as LinkRefusalCode[])("preserves the verified link refusal %s", async code => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(linkRefusalBody(code), {status: LINK_REFUSALS[code].status})));
  await expect(namedRequest("/api/live/link-document", new AbortController().signal)).rejects.toThrow(LINK_REFUSALS[code].error);
});

it.each(["link_unavailable", "link_live_unavailable"] as const)("keeps the verified 503 refusal %s retryable", async code => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(linkRefusalBody(code), {status: 503})));
  const error = await namedRequest("/api/live/link-document", new AbortController().signal).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty("message", LINK_REFUSALS[code].error);
  expect(error).not.toBeInstanceOf(LiveAuthorityUnavailableError);
  expect(error).not.toBeInstanceOf(ShareAccessRemovedError);
});

it("shows removal for the verified named recipient", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ok: false, code: "share_access_removed", error: "The owner removed your access."}, {status: 404})));
  await expect(namedRequest("/api/live/named-documents", new AbortController().signal)).rejects.toBeInstanceOf(ShareAccessRemovedError);
});

it.each(["/api/live/link-document", "/api/live/named-documents"])("keeps an unverified refusal opaque on %s", async path => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ok: false, error: "not found"}, {status: 404})));
  await expect(namedRequest(path, new AbortController().signal)).rejects.toThrow("Unavailable");
  await expect(namedRequest(path, new AbortController().signal)).rejects.toBeInstanceOf(LiveAuthorityUnavailableError);
});

it.each(["/api/live/link-document", "/api/live/named-documents"])("keeps transient 503s retryable on %s", async path => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ok: false, error: "temporarily unavailable"}, {status: 503})));
  const error = await namedRequest(path, new AbortController().signal).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(LiveAuthorityUnavailableError);
  expect(error).not.toBeInstanceOf(ShareAccessRemovedError);
});
