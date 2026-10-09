import {expect,it,vi} from "vitest";
import {createTypingQuitRecovery} from "./typingQuitRecovery";
import {createQuitGuard} from "../quitGuard";
it("finishes a no-window quit when the downstream guard re-enters before promise cleanup",async()=>{
 const flush=vi.fn(async()=>{});const proceeded=vi.fn();const event={preventDefault:vi.fn()};
 let guard:ReturnType<typeof createTypingQuitRecovery>;
 const quit=()=>guard.beforeQuit(event);
 const downstream=createQuitGuard({ask:()=>queueMicrotask(()=>downstream.resume()),quit,forceQuit:vi.fn()});
 guard=createTypingQuitRecovery({hasWindows:()=>false,unresolved:()=>true,flush,confirmLoss:vi.fn(),quit,beforeQuit:entry=>{if(downstream.beforeQuit(entry) === "proceed")proceeded();}});
 guard.beforeQuit(event);await vi.waitFor(()=>expect(proceeded).toHaveBeenCalledOnce());
 expect(flush).toHaveBeenCalledTimes(2);
});
it("consumes approval once so a later quit still checks new checkpoint debt",async()=>{
 const flush=vi.fn(async()=>{throw Error("disk full");});const confirmLoss=vi.fn(async()=>true);const beforeQuit=vi.fn();const quit=vi.fn();
 const guard=createTypingQuitRecovery({hasWindows:()=>false,unresolved:()=>true,flush,confirmLoss,beforeQuit,quit});const event={preventDefault:vi.fn()};
 guard.beforeQuit(event);await vi.waitFor(()=>expect(quit).toHaveBeenCalledOnce());guard.beforeQuit(event);expect(beforeQuit).toHaveBeenCalledOnce();
 guard.beforeQuit(event);await vi.waitFor(()=>expect(quit).toHaveBeenCalledTimes(2));expect(confirmLoss).toHaveBeenCalledTimes(2);
});
it("cancelled loss confirmation leaves the next quit guarded",async()=>{
 const confirmLoss=vi.fn(async()=>false);const quit=vi.fn();const flush=vi.fn(async()=>{throw Error("disk full");});const guard=createTypingQuitRecovery({hasWindows:()=>false,unresolved:()=>true,flush,confirmLoss,quit,beforeQuit:vi.fn()});
 guard.beforeQuit({preventDefault:vi.fn()});await vi.waitFor(()=>expect(confirmLoss).toHaveBeenCalledOnce());await Promise.resolve();guard.beforeQuit({preventDefault:vi.fn()});await vi.waitFor(()=>expect(confirmLoss).toHaveBeenCalledTimes(2));expect(quit).not.toHaveBeenCalled();
});
