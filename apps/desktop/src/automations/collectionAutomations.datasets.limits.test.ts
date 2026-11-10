import { describe, expect, it } from "vitest";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { PAID, NOTES, closePaid, world } = datasetAutomationFixture();

describe("Collection automations on a dataset", () => {
  it("refuses a dataset Find of 300 records that sets a field on each, before writing anything", async () => {
    const f = await world();
    await f.writeAutomations(closePaid(`      - find: record.Status == "Open"
        as: open
        operation: invoices.list
      - set:
          Notes: reminded
        records: open
        operation: invoices.edit
`));
    await f.executor.open();
    for (let index = 0; index < 299; index++) await f.create({ [NOTES]: `open ${index}` });
    const paid = await f.create({ [NOTES]: "paid" });
    await f.edit(paid.id, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]!.error).toBe("Step 2 would make this run change more than 200 fields. Narrow its Find steps, or split it into smaller automations.");
    expect((await f.records()).filter((row) => row.values[NOTES] === "reminded")).toEqual([]);
    await f.executor.dispose();
  }, 120_000);
});
