import {expect,it} from "vitest";
import {datasetNumberText,losslessDatasetNumber} from "./datasetConversion";

it.each(["0","-0","0.1","12.5","-12.5","1.25e2","12.5000"," 12.5 ","1e-5","9007199254740992","1.2345678901234567"])("converts a round-trip decimal: %s",value=>{
  expect(losslessDatasetNumber(value)).toBe(Number(value));
});
it.each(["pay later","","true","01","9007199254740993","1e-999","1e999","0.10000000000000001","1.234567890123456789","1e9999999999999"])("refuses invalid or lossy decimals: %s",value=>{
  expect(losslessDatasetNumber(value)).toBeNull();
});
it("bounds input size and renders finite doubles without losing significant digits",()=>{
  expect(losslessDatasetNumber("1".repeat(65537))).toBeNull();
  for(const value of [0.1,-12.5,1.2345678901234567,Number.MIN_VALUE,Number.MAX_VALUE]) expect(Number(datasetNumberText(value))).toBe(value);
  expect(()=>datasetNumberText(Infinity)).toThrow(/finite/);
});
