import {expect,it} from "vitest";
import {OPERATION_ID_PREFIX,refuseCallerOperationId} from "./engine";
it("reserves operation IDs while ordinary caller IDs remain usable",()=>{
 expect(OPERATION_ID_PREFIX).toBe("dohc-operation:");
 expect(()=>refuseCallerOperationId(OPERATION_ID_PREFIX+"forged")).toThrow("Reserved operation id.");
 expect(()=>refuseCallerOperationId("ordinary-request")).not.toThrow();
});
