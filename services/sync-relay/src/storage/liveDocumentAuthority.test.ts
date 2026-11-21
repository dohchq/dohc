import { afterEach, expect, it, vi } from "vitest";
import { scope } from "../liveTickets.test-helper";
import { personalRouteFixture } from "../personalLiveDocumentRoutes.test-helper";
import type { StorageContext } from "./context";
import { baselineRecord, ticketScopeIsCurrent } from "./liveDocumentAuthority";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("captures only required data fields when extra fields are allowed", () => {
  const getter = vi.fn(() => {
    throw new Error("extra field was read");
  });
  const input = Object.assign(Object.create(null), { required: "captured" });
  Object.defineProperty(input, "extra", { enumerable: true, get: getter });
  Object.defineProperty(input, Symbol("extra"), { value: 1 });
  const captured = baselineRecord(input, ["required"], true);
  input.required = "changed";
  expect(captured).toEqual({ required: "captured" });
  expect(getter).not.toHaveBeenCalled();
  expect(() => baselineRecord(input, ["required"])).toThrow("Invalid baseline fields.");
  expect(getter).not.toHaveBeenCalled();
});

it.each(["inherited", "accessor", "non-enumerable", "symbol", "proxy", "array"])(
  "refuses a %s record without executing caller code",
  (kind) => {
    const trap = vi.fn(() => {
      throw new Error("caller code ran");
    });
    let input: unknown = { required: "value" };
    if (kind === "inherited") input = Object.create({ required: "value" });
    if (kind === "accessor")
      Object.defineProperty(input, "required", { enumerable: true, get: trap });
    if (kind === "non-enumerable") Object.defineProperty(input, "required", { enumerable: false });
    if (kind === "symbol") Object.defineProperty(input, Symbol("extra"), { value: 1 });
    if (kind === "proxy")
      input = new Proxy(input as object, {
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      });
    if (kind === "array") input = Object.assign([], { required: "value" });
    expect(() => baselineRecord(input, ["required"])).toThrow(/Invalid baseline/);
    expect(trap).not.toHaveBeenCalled();
  },
);

// Live documents stay owned only (22A): a member's agent at Edit, in a
// workspace its person joined at Edit, holds no current live binding.
it("keeps a live ticket current for the owner's agent at Edit, never for a member's agent", async () => {
  const f = await personalRouteFixture((close) => {
    cleanup.push(close);
  });
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      workspaceName: "Plans",
      email: "sam@example.test",
      recipientUserId: "member-1",
      newMemberId: () => "member-entry",
      newGrantId: () => "member-grant",
      newShareId: () => "members-share",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  expect(
    f.storage.setWorkspaceMemberLevel({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      level: "edit",
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 6,
    }),
  ).toEqual({ ok: true });
  expect(
    ticketScopeIsCurrent(f.storage as StorageContext, f.agent("owner-helper").ticketScope),
  ).toBe(true);
  expect(
    ticketScopeIsCurrent(
      f.storage as StorageContext,
      f.agent("member-helper", "edit", "member-1").ticketScope,
    ),
  ).toBe(false);
});
