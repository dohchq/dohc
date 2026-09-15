import {expect as browserExpect} from "@playwright/test";
import {expect} from "vitest";
import type {PublicProofPage, PublicTransitionFixture, PublicTransitionHarness} from "./publicTransitionRuntime.integration-helper.js";
import type {LoadedPublicTransitions} from "./publicTransitionWorkload.integration-helper.js";

export async function runPublicMixedPresence(h: PublicTransitionHarness, workload: LoadedPublicTransitions,
  openNamed: (fixture: PublicTransitionFixture) => Promise<Omit<PublicProofPage, "discriminator">>) {
  const fixture = await h.register("mixed-presence", workload.cases.restart.baseline.checkpoint, workload.cases.restart.baseline.markdown);
  const peers = [];
  for (let index = 0; index < h.concurrency - 1; index++) peers.push(await h.openLink(fixture.link.url, index));
  let named = await openNamed(fixture);
  await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency);
  const writer = peers.pop()!;
  await writer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
  await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency - 1);
  const socket = await h.wire.connect(writer.context, await h.wire.ticket(writer.context, writer.discriminator, fixture.document.objectId), "anonymous-mixed-membership");
  try {
    await socket.sync();
    await socket.until(() => socket.membership?.members.length === h.concurrency);
    const before = socket.membership!;
    expect(Object.keys(before).sort()).toEqual(["kind", "members", "overflow", "revision"]);
    expect(before.overflow).toBe(false); expect(new Set(before.members).size).toBe(h.concurrency);
    for (const member of before.members) expect(member).toMatch(/^[0-9a-f]{32}$/);
    await named.context.close();
    await socket.until(() => socket.membership?.members.length === h.concurrency - 1);
    const absent = socket.membership!, removed = before.members.filter(id => !absent.members.includes(id)); expect(removed).toHaveLength(1);
    named = await openNamed(fixture);
    await socket.until(() => socket.membership?.members.length === h.concurrency);
    const rejoined = socket.membership!;
    expect(rejoined.members).not.toContain(removed[0]);
    expect(Object.keys(rejoined).sort()).toEqual(["kind", "members", "overflow", "revision"]);
    return {verdict: "PASS", concurrency: h.concurrency, anonymousReceiver: true, namedCollaborator: true, before, absent, rejoined};
  } finally {
    await socket.close(); await writer.context.close(); await named.context.close(); for (const peer of peers) await peer.context.close();
  }
}
