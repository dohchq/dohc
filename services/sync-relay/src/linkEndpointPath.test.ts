import {expect, it} from "vitest";
import {isLinkEndpointPath} from "./linkEndpointPath";

it.each([
  "/sync/link/keys", "/sync/link/bootstrap", "/sync/link/log/owner/0",
  "/sync/link/collection-writes/grant", "/sync/link/shares/links",
  "/sync/link-lane-owner/keys", "/sync/linkx/keys", "/sync/link-owner/log",
  "/sync/link-exchange-owner/keys", "/sync/link-refresh/keys",
  "/sync/link-handoff/keys", "/sync/link-redeem/keys", "/sync/link-tickets/keys",
  "/sync/link%2Dlane-owner/keys", "/sync/link-exchange/extra",
  "/sync/live/link-document-owner/keys",
])("classifies %s as a workspace route", path => {
  expect(isLinkEndpointPath(path)).toBe(false);
});

it("classifies every served link route, including decoded route segments", () => {
  const publication = "a".repeat(64);
  const blob = "b".repeat(64);
  const paths = [
    "/sync/link-exchange", "/sync/link-refresh", "/sync/link-handoff", "/sync/link-redeem",
    "/sync/link/share", "/sync/link/current", "/sync/link/log", "/sync/link/discussion",
    "/sync/link/discussion/activity", "/sync/link/collection-writes", `/sync/link/blobs/${blob}`,
    "/sync/link/app-publications", `/sync/link/app-publications/${publication}`,
    `/sync/link/app-publications/${publication}/collection`,
    `/sync/link/app-publications/${publication}/blobs/${blob}`,
    ...["invoke", "upload", "file", "attempt"].map(action => `/sync/link/app-publications/${publication}/backend/${action}`),
    "/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document",
    "/sync/%6cink/share", "/sync/link%2Dexchange", "/sync/link-refresh/", "/sync//link/current",
  ];
  for (const path of paths) expect(isLinkEndpointPath(path), path).toBe(true);
});
