import { cpus } from "node:os";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { afterEach, expect, it } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import type { SyncRelayHandler } from "./server";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  json,
  jsonBody,
  logOp,
  request,
  resetOpSeq,
  testHandler,
  testStorage,
} from "./testing";

// Run with DOHC_HELD_PULL_MEASURE=1. Each case prints one line and fails
// above its limits.
//
// 100 members of one workspace each hold a pull on its log while the owner
// posts 2 messages a second for 60 s. Every post wakes every held pull.
// - In a Group they all reach, each woken pull filters one page near the
//   head and answers. Wake-to-response is the time from the owner's post to
//   a member's answer carrying it.
// - In General, which no member reaches, each woken pull filters, finds
//   nothing and waits again. This is the work design section 8 would save
//   by waking only the waiters whose selector admits the op.
// Relay CPU is this process's user and system time over the posting period,
// as a share of one core. The members' requests run in the same process, so
// it counts their client work too.
//
// First run, 2026-11-13, Windows 11, Node 24, 32 cores, in-process relay
// with SQLite:
// - Group: p50 113.7 ms, p95 393.8 ms, max 1120 ms, CPU 0.330 of one core.
//   A second run: p50 85.5 ms, p95 125.4 ms, max 303 ms, CPU 0.258.
// - General: CPU 0.094 of one core, about 0.5 ms for each woken pull.
// The limits are about twice the first run.

const MEMBERS = 100;
const POSTS_PER_SECOND = 2;
const SECONDS = 60;
const LIMITS = {
  group: { wakeP50Ms: 250, wakeP95Ms: 800, cpuShareOfOneCore: 0.66 },
  general: { cpuShareOfOneCore: 0.25 },
};

const OWNER = "owner";
const WORKSPACE = "held-pulls";
const GROUP = "wire-team";

afterEach(closeTestStorages);

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]): Promise<void> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })));
  expect(response.status, await response.clone().text()).toBe(200);
}

function channel(wireId: string, slug: string) {
  return [
    logOp("chat.channel.create", chatChannelCreate(wireId, {
      channelId: `chan-${slug}`, name: slug, slug, kind: "channel", type: "both", purpose: "", folderPath: slug,
    }).payload),
    logOp("chat.thread.create", chatThreadCreate(`t-${slug}`, wireId, { slug }).payload),
  ];
}

const message = (messageId: string, threadId: string) =>
  logOp("chat.message.append", chatMessageAppend(messageId, threadId, `post ${messageId}`, { authorUserId: OWNER }).payload);

for (const where of ["group", "general"] as const) {
  it.skipIf(process.env.DOHC_HELD_PULL_MEASURE !== "1")(
    `measures ${MEMBERS} held pulls on one workspace while the owner posts ${POSTS_PER_SECOND} messages a second for ${SECONDS} s in ${where === "group" ? "a Group they reach" : "General"}`,
    async () => {
      resetOpSeq();
      const activity = new DiscussionActivityHub();
      const storage = await testStorage();
      const h = testHandler(storage, { discussionActivity: activity, lookupUserDisplayName: (userId: string) => `Name ${userId}` });
      expect((await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status).toBe(200);
      await ownerAppend(h, [...channel(GROUP, "team"), ...channel(GENERAL_CHANNEL_WIRE_ID, "general")]);

      const members = Array.from({ length: MEMBERS }, (_, index) => `member-${index}`);
      for (const member of members) {
        const invited = await h(request(OWNER, `/sync/${WORKSPACE}/members/invites`,
          jsonBody({ email: `${member}@dohc.test`, workspaceName: "Community" })));
        expect(invited.status, await invited.clone().text()).toBe(200);
      }
      const shares = new Map<string, { shareId: string; cursor: number }>();
      for (const member of members) {
        const listed = await json(await h(request(member, "/sync/shares")));
        const shareId = (listed.received as Array<{ shareId: string; selector: { kind?: string } }>)
          .find((row) => row.selector.kind === "workspace")!.shareId;
        const first = await json(await h(request(member, `/sync/shares/${shareId}/log?since=0&limit=500`)));
        shares.set(member, { shareId, cursor: first.nextCursor as number });
      }

      const sentAt = new Map<string, number>();
      const wakes: number[] = [];
      const total = POSTS_PER_SECOND * SECONDS;
      // The last message is always in the Group, so every member's pull ends.
      const lastMessage = "msg-last";
      const controller = new AbortController();

      // Each member holds a pull, reads the answer, and holds again from its cursor.
      async function follow(member: string): Promise<void> {
        const state = shares.get(member)!;
        for (;;) {
          const response = await h(request(member,
            `/sync/shares/${state.shareId}/log?since=${state.cursor}&limit=500&hold=30000&level=comment`,
            { signal: controller.signal }));
          const answeredAt = performance.now();
          expect(response.status).toBe(200);
          const page = await json(response);
          state.cursor = page.nextCursor as number;
          let done = false;
          for (const op of page.ops as Array<{ opKind: string; payload: { messageId?: string } }>) {
            if (op.opKind !== "chat.message.append" || !op.payload.messageId) continue;
            const sent = sentAt.get(op.payload.messageId);
            if (sent !== undefined && op.payload.messageId !== lastMessage) wakes.push(answeredAt - sent);
            if (op.payload.messageId === lastMessage) done = true;
          }
          if (done) return;
        }
      }

      const followers = members.map(follow);
      await expect.poll(() => activity.stats().waiters, { timeout: 30_000 }).toBe(MEMBERS);

      const cpuBefore = process.cpuUsage();
      const wallBefore = performance.now();
      for (let index = 0; index < total; index++) {
        const due = wallBefore + (index * 1000) / POSTS_PER_SECOND;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const messageId = `msg-${index}`;
        sentAt.set(messageId, performance.now());
        await ownerAppend(h, [message(messageId, where === "group" ? "t-team" : "t-general")]);
      }
      // Every pull has answered, or is waiting again, before the period ends.
      if (where === "group") await expect.poll(() => wakes.length, { timeout: 30_000 }).toBe(MEMBERS * total);
      await expect.poll(() => activity.stats().waiters, { timeout: 30_000 }).toBe(MEMBERS);
      const wallMs = performance.now() - wallBefore;
      const cpu = process.cpuUsage(cpuBefore);
      await ownerAppend(h, [message(lastMessage, "t-team")]);
      await Promise.all(followers);
      controller.abort();

      const cpuShare = (cpu.user + cpu.system) / 1000 / wallMs;
      const cpuText = `cpu-user-ms=${(cpu.user / 1000).toFixed(0)} cpu-system-ms=${(cpu.system / 1000).toFixed(0)} ` +
        `wall-ms=${wallMs.toFixed(0)} cpu-share-of-one-core=${cpuShare.toFixed(3)} cores=${cpus().length}`;
      if (where === "general") {
        expect(wakes).toHaveLength(0);
        console.log(`HELD_PULL_UNADMITTED members=${MEMBERS} posts=${total} rate=${POSTS_PER_SECOND}/s channel=general ${cpuText}`);
        expect(cpuShare).toBeLessThan(LIMITS.general.cpuShareOfOneCore);
        return;
      }
      expect(wakes).toHaveLength(MEMBERS * total);
      const sorted = [...wakes].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      console.log(`HELD_PULL_WAKE_MS members=${MEMBERS} posts=${total} rate=${POSTS_PER_SECOND}/s channel=group ` +
        `p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} max=${sorted[sorted.length - 1]!.toFixed(2)} samples=${sorted.length} ${cpuText}`);
      expect(p50).toBeLessThan(LIMITS.group.wakeP50Ms);
      expect(p95).toBeLessThan(LIMITS.group.wakeP95Ms);
      expect(cpuShare).toBeLessThan(LIMITS.group.cpuShareOfOneCore);
    },
    600_000,
  );
}
