import { expect, it } from "vitest";
import { parseLiveSettlementConfig } from "./liveSettlementConfig.js";

it("leaves settlement disabled without an operator value and rejects malformed limits",()=>{
  expect(parseLiveSettlementConfig(undefined)).toBeUndefined();
  expect(parseLiveSettlementConfig({maxApplicationsPerSettlement:8})).toEqual({maxApplicationsPerSettlement:8});
  for(const value of [null,{}, {maxApplicationsPerSettlement:0},{maxApplicationsPerSettlement:1.5},{maxApplicationsPerSettlement:Number.MAX_SAFE_INTEGER+1},{maxApplicationsPerSettlement:8,default:true}]) expect(()=>parseLiveSettlementConfig(value)).toThrow();
});
