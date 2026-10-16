import {expect,it} from "vitest";
import {accountDeletionKey,presentsAccountDeletionKey} from "./accountDeletion";
it("requires the exact domain-separated internal bearer",()=>{
  const key=accountDeletionKey("a".repeat(32));
  expect(presentsAccountDeletionKey(key,key)).toBe(true);
  for(const value of [null,"", "wrong",accountDeletionKey("b".repeat(32))]) expect(presentsAccountDeletionKey(value,key)).toBe(false);
});
