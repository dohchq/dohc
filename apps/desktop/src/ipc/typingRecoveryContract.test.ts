import {expect,it} from "vitest";
import {liveDraftRecoveryOperations} from "./bridgeContract";
const result=liveDraftRecoveryOperations.typingRecovery.result;
it.each(["replayed","covered","imported"] as const)("carries the real %s decision across the renderer boundary",outcome=>{
 const reply={failures:[],outcome,momentId:outcome === "imported" ? "recovery-moment" : null};
 expect(result.parse(reply)).toEqual(reply);
});
it("requires a change identity for History-only typing and rejects a file outcome naming a moment",()=>{
 expect(result.safeParse({failures:[],outcome:"imported"}).success).toBe(false);
 expect(result.safeParse({failures:[],outcome:"imported",momentId:null}).success).toBe(false);
 expect(result.safeParse({failures:[],outcome:"replayed",momentId:"recovery-moment"}).success).toBe(false);
});
