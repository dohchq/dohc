import { expect, type Locator } from "@playwright/test";

// A Data Collection's table, as a person works it. It is the shared grid:
// each record's row starts with its Open control, and its field cells follow
// in the order of the column headers.

/** The cells under the column named `field`, one for each record on the page. */
export async function fieldCells(collection: Locator, field: string): Promise<Locator> {
  const header = collection.getByRole("columnheader").filter({ has: collection.page().getByText(field, { exact: true }) });
  await expect(header).toHaveCount(1, { timeout: 30_000 });
  const column = await header.evaluate(element => [...element.parentElement!.children].indexOf(element));
  return collection.locator(`[role="row"][data-index] > [role="gridcell"]:nth-child(${column + 1})`);
}

/**
 * A command in a Data Collection's actions menu, such as Refresh, Views or
 * Create form, once it can run. The menu opens first when it is closed.
 */
export async function collectionCommand(collection: Locator, name: string): Promise<Locator> {
  const trigger = collection.getByRole("button", { name: "Manage Collection", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const command = collection.getByRole("menuitem", { name, exact: true });
  // A command that waits for a read is marked aria-disabled, which a click does not wait out.
  await expect(command).not.toHaveAttribute("aria-disabled", "true");
  return command;
}

/**
 * Types a value into one text cell and saves it with Enter. A click opens
 * the cell's editor in the table's overlay, and there is no Save step. The
 * cell shows the value at once, and marks it until the Collection confirms it.
 */
export async function editCell(collection: Locator, cell: Locator, value: string): Promise<void> {
  await cell.click();
  const input = collection.locator("[data-cell-editor] input");
  await input.fill(value);
  await input.press("Enter");
}
