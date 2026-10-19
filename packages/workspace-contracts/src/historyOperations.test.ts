import {expect,it} from "vitest";
import {OPERATION_ID_PREFIX,refuseCallerOperationId} from "./engine";
it("reserves operation IDs while ordinary caller IDs remain usable",()=>{
 expect(OPERATION_ID_PREFIX).toBe("dohc-operation:");
 expect(()=>refuseCallerOperationId(OPERATION_ID_PREFIX+"forged")).toThrow("Reserved operation id.");
 expect(()=>refuseCallerOperationId("ordinary-request")).not.toThrow();
});

import { HistoryOperationId } from "./historyOperation";
it("accepts only the advertised lowercase operation UUID", () => {
  const id = "dohc-operation:abcdef01-2345-6789-abcd-0123456789ab";
  expect(HistoryOperationId.safeParse(id).success).toBe(true);
  expect(HistoryOperationId.safeParse(id.toUpperCase()).success).toBe(false);
  expect(HistoryOperationId.safeParse(id.replace("abcdef", "ABCDEF")).success).toBe(false);
  expect(HistoryOperationId.safeParse("dohc-operation:undo:hash").success).toBe(false);
});
