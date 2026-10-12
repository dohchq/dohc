import { expect, it } from "vitest";
import { hasPendingYDocDeliveries, registerYDocDelivery, settleYDocDeliveries } from "./pendingYDocDeliveries";
it("drains again when edits arrive during the existing unload hold", async () => {
 let pending = true; let calls = 0;
 const unregister = registerYDocDelivery({pending: () => pending, flush: async () => {calls++; pending = calls < 2;}});
 try {expect(hasPendingYDocDeliveries()).toBe(true); expect(await settleYDocDeliveries()).toBe(true); expect(calls).toBe(2); expect(hasPendingYDocDeliveries()).toBe(false);} finally {unregister();}
});
it("holds exit when a checkpoint cannot land", async () => {
 const unregister = registerYDocDelivery({pending: () => true, flush: async () => {throw Error("disk full");}});
 try {expect(await settleYDocDeliveries()).toBe(false); expect(hasPendingYDocDeliveries()).toBe(true);} finally {unregister();}
});
