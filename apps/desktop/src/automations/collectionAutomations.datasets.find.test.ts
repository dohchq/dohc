import { describe, expect, it } from "vitest";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { PAID, NOTES, closePaid, world } = datasetAutomationFixture();

describe("Collection automations on a dataset", () => {
  it.each([499, 500])("reads a Find of %i other records in pages through the generated operation, and refuses one more", async (others) => {
    const f = await world();
    await f.writeAutomations(closePaid(`      - find: record.Status == "Open"
        as: open
        operation: invoices.list
      - set:
          Notes: '="Open " + open.length'
        operation: invoices.edit
`));
    await f.executor.open();
    // The paid invoice is open too, so the Find matches others + 1 records.
    for (let index = 0; index < others; index++) await f.create({ [NOTES]: `open ${index}` });
    const paid = await f.create({ [NOTES]: "paid" });
    await f.edit(paid.id, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
    const claim = f.claims()[0]!;
    if (others === 499) {
      expect({ state: claim.state, error: claim.error }).toEqual({ state: "done", error: null });
      expect((await f.record(paid.id))?.values[NOTES]).toBe("Open 500");
    } else {
      expect(claim.state).toBe("failed");
      expect(claim.error).toBe("The Find in step 1 matched more than 500 records. Narrow its condition, then try again.");
      expect((await f.record(paid.id))?.values[NOTES]).toBe("paid");
    }
    await f.executor.dispose();
  }, 120_000);
});
