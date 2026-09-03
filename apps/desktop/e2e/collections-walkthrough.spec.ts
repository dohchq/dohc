import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
} from "./helpers/workspace";

// The Phase 2 collections gate walkthrough (docs/plans/collections.md),
// driven through the REAL app: create two collections from the File menu's
// New Collection command, add a field of every v1 type through the Fields
// dialog, create records with New record, edit every field type inline in
// the table, drag a board card and read the write back from the record's
// file on disk, and rekey the calendar to a second date field — all without
// collection.yaml ever opening on screen. A board drag must not open the
// record's tab (the pickers-lane watch item).

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

const PROJECTS_TAB = "tab-dohc://collection/projects";
const CLIENTS_TAB = "tab-dohc://collection/clients";

// Calendar month view opens on today, so the walkthrough's dates must land
// in the current month. One clock read: deriving both dates from separate
// reads could straddle a month boundary at midnight.
const NOW = new Date();

function currentMonthDay(day: number): string {
  const month = String(NOW.getMonth() + 1).padStart(2, "0");
  return `${NOW.getFullYear()}-${month}-${String(day).padStart(2, "0")}`;
}

// The application menu's New Collection… item sends this exact command over
// the menu channel; driving the channel is driving the File menu without a
// native-menu robot.
async function newCollectionFromFileMenu(desktop: Desktop): Promise<void> {
  await desktop.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window to send the menu command to.");
    win.webContents.send("desktop:menu-command", "new-collection");
  });
}

async function closeTab(page: Page, path: string): Promise<void> {
  const tab = page.getByTestId(`tab-${path}`);
  await tab.hover();
  await tab.getByRole("button", { name: /^Close / }).click();
  await expect(tab).toHaveCount(0);
}

// A data row in the table view (the header row carries no data-index).
function recordRows(page: Page): Locator {
  return page.locator('[role="row"][data-index]');
}

// The table's first gridcell is the Open column; field cells follow in
// schema order.
function fieldCell(row: Locator, fieldIndex: number): Locator {
  return row.locator('[role="gridcell"]').nth(fieldIndex + 1);
}

// Inline edit of a plain-input cell (text, number, date, person, url):
// click the cell's display button, type into the editor, commit with Enter,
// then wait for the settled value to come back from the index.
async function editInputCell(
  row: Locator,
  fieldIndex: number,
  value: string,
): Promise<void> {
  const cell = fieldCell(row, fieldIndex);
  await cell.getByRole("button").click();
  // Cell editors render in the table-owned overlay, not inside the row.
  const input = row.page().locator("[data-cell-editor] input");
  await input.fill(value);
  await input.press("Enter");
  await expect(cell).toContainText(value, { timeout: 30_000 });
}

async function editSelectCell(
  row: Locator,
  fieldIndex: number,
  option: string,
): Promise<void> {
  const cell = fieldCell(row, fieldIndex);
  await cell.getByRole("button").click();
  await row.page().locator("[data-cell-editor] select").selectOption(option);
  await expect(cell).toContainText(option, { timeout: 30_000 });
}

interface FieldSpec {
  name: string;
  type: string;
  options?: string;
  relation?: string;
}

async function addField(page: Page, field: FieldSpec): Promise<void> {
  const dialog = page.getByTestId("collection-fields-dialog");
  await dialog.getByLabel("Field name").fill(field.name);
  await dialog.getByLabel("Field type").selectOption(field.type);
  if (field.options !== undefined) {
    await dialog.getByLabel("Options").fill(field.options);
  }
  if (field.relation !== undefined) {
    const target = dialog.getByLabel("Related collection");
    // The relation-target list loads async; the option must exist before
    // selectOption can land on it.
    await expect(
      target.locator(`option[value="${field.relation}"]`),
    ).toHaveCount(1, { timeout: 15_000 });
    await target.selectOption(field.relation);
  }
  await dialog.getByTestId("collection-add-field").click();
  // The add settles as one schema rewrite; the new field's list row is the
  // settled signal (and the form reset for the next add).
  await expect(
    dialog.getByText(field.name, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

interface ViewSpec {
  name: string;
  kind: "table" | "board" | "calendar";
  groupBy?: string;
  dateField?: string;
}

async function addView(page: Page, view: ViewSpec): Promise<void> {
  const dialog = page.getByTestId("collection-views-dialog");
  // The New view form's name input is the last "View name" on the surface
  // (rename rows only exist while renaming, but stay defensive).
  await dialog.getByLabel("View name").last().fill(view.name);
  await dialog.getByLabel("View kind").selectOption(view.kind);
  if (view.groupBy !== undefined) {
    await dialog.getByLabel("Group by").selectOption(view.groupBy);
  }
  if (view.dateField !== undefined) {
    await dialog.getByLabel("Date field").selectOption(view.dateField);
  }
  await dialog.getByTestId("collection-add-view").click();
  // The rename button's label is unique per view row; the bare view name can
  // collide with the kind label and the create form's controls.
  await expect(
    dialog.getByLabel(`Rename view ${view.name}`),
  ).toBeVisible({ timeout: 30_000 });
}

async function switchView(page: Page, name: string): Promise<void> {
  await page
    .getByTestId("collection-view-switcher")
    .getByRole("button", { name, exact: true })
    .click();
}

function boardCard(page: Page, title: string): Locator {
  return page.locator(`[role="listitem"][aria-label="${title}"]`);
}

function boardColumn(page: Page, label: string): Locator {
  return page.locator(`section[aria-label="${label}"]`);
}

// @dnd-kit's drag is pointer-based: press on the card, move across in real
// steps so the sensor sees the motion, release over the target column.
async function dragCardToColumn(
  page: Page,
  card: Locator,
  column: Locator,
): Promise<void> {
  const cardBox = await card.boundingBox();
  const columnBox = await column.boundingBox();
  if (!cardBox || !columnBox) {
    throw new Error("Drag geometry unavailable: card or column not visible.");
  }
  const fromX = cardBox.x + cardBox.width / 2;
  const fromY = cardBox.y + cardBox.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 8, fromY + 8, { steps: 4 });
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    columnBox.y + columnBox.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();
}

test("collections walkthrough: create, shape, edit, drag, and rekey without the schema on screen", async () => {
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;
  const dueDate = currentMonthDay(10);
  const startedDate = currentMonthDay(20);

  try {
    await seedWorkspaceManifest(temp, "collections-walkthrough-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // --- The relation target: a small "clients" collection with one record.
    await newCollectionFromFileMenu(desktop);
    const newCollection = page.getByTestId("new-collection-dialog");
    await expect(newCollection).toBeVisible();
    await newCollection.getByLabel("Collection name").fill("clients");
    // The dialog's first field draft is Name (text) — exactly what clients
    // needs.
    await newCollection.getByTestId("new-collection-create").click();
    await expect(page.getByTestId(CLIENTS_TAB)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("collection-empty")).toBeVisible({
      timeout: 30_000,
    });

    // New record creates and opens the record's file tab; the walkthrough
    // returns to the collection to edit it inline.
    await page.getByTestId("collection-new-record").click();
    await expect(page.getByTestId("tab-clients/Untitled.md")).toBeVisible({
      timeout: 15_000,
    });
    await closeTab(page, "clients/Untitled.md");
    await page.getByTestId(CLIENTS_TAB).click();
    await expect(recordRows(page)).toHaveCount(1, { timeout: 30_000 });
    await editInputCell(recordRows(page).first(), 0, "Acme");

    // --- The main "projects" collection.
    await newCollectionFromFileMenu(desktop);
    await expect(newCollection).toBeVisible();
    await newCollection.getByLabel("Collection name").fill("projects");
    await newCollection.getByTestId("new-collection-create").click();
    await expect(page.getByTestId(PROJECTS_TAB)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("collection-empty")).toBeVisible({
      timeout: 30_000,
    });

    // The Fields button lives on the populated collection header, so the
    // first record comes before the schema takes shape.
    await page.getByTestId("collection-new-record").click();
    await expect(page.getByTestId("tab-projects/Untitled.md")).toBeVisible({
      timeout: 15_000,
    });
    await closeTab(page, "projects/Untitled.md");
    await page.getByTestId(PROJECTS_TAB).click();
    await expect(recordRows(page)).toHaveCount(1, { timeout: 30_000 });

    // --- Every v1 field type, added through the Fields dialog (Name/text
    // came from the New collection dialog).
    await page.getByTestId("collection-fields-button").click();
    await expect(page.getByTestId("collection-fields-dialog")).toBeVisible();
    await addField(page, { name: "Effort", type: "number" });
    await addField(page, { name: "Done", type: "checkbox" });
    await addField(page, { name: "Due", type: "date" });
    await addField(page, { name: "Started", type: "date" });
    await addField(page, { name: "Status", type: "select", options: "Todo, Doing, Done" });
    await addField(page, { name: "Tags", type: "multi-select", options: "Design, Build" });
    await addField(page, { name: "Owner", type: "person" });
    await addField(page, { name: "Client", type: "relation", relation: "clients" });
    await addField(page, { name: "Site", type: "url" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("collection-fields-dialog")).toHaveCount(0);
    // The table re-reads the schema: the last-added column arrives.
    await expect(
      page.getByRole("columnheader").filter({ hasText: "Site" }),
    ).toBeVisible({ timeout: 30_000 });

    // --- Inline cell edits in the table, one per field type.
    // Field order = schema order: Name 0, Effort 1, Done 2, Due 3,
    // Started 4, Status 5, Tags 6, Owner 7, Client 8, Site 9.
    const row1 = recordRows(page).first();
    await editInputCell(row1, 0, "Website");
    const websiteRow = recordRows(page).filter({ hasText: "Website" });
    await editInputCell(websiteRow, 1, "3");
    // Checkbox cells edit in place — no editor to open.
    const doneBox = fieldCell(websiteRow, 2).locator('input[type="checkbox"]');
    await doneBox.click();
    await expect(doneBox).toBeChecked({ timeout: 30_000 });
    await editInputCell(websiteRow, 3, dueDate);
    await editSelectCell(websiteRow, 5, "Todo");
    // Multi-select: toggle an option inside the editor, then close it.
    const overlay = page.locator("[data-cell-editor]");
    const tagsCell = fieldCell(websiteRow, 6);
    await tagsCell.getByRole("button").click();
    const designOption = overlay
      .getByRole("listbox")
      .locator("label")
      .filter({ hasText: "Design" })
      .locator("input");
    await designOption.click();
    await expect(designOption).toBeChecked({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(tagsCell).toContainText("Design", { timeout: 30_000 });
    await editInputCell(websiteRow, 7, "ice");
    // Relation: the picker lists the clients records by label in the overlay.
    const clientCell = fieldCell(websiteRow, 8);
    await clientCell.getByRole("button").click();
    await overlay.getByRole("option", { name: "Acme" }).click();
    await expect(clientCell).toContainText("Acme", { timeout: 30_000 });
    await editInputCell(websiteRow, 9, "https://website.example");

    // --- A second record: the board's target column and the calendar's
    // second-date-field proof.
    await page.getByTestId("collection-new-record").click();
    await expect(page.getByTestId("tab-projects/Untitled 2.md")).toBeVisible({
      timeout: 15_000,
    });
    await closeTab(page, "projects/Untitled 2.md");
    await page.getByTestId(PROJECTS_TAB).click();
    await expect(recordRows(page)).toHaveCount(2, { timeout: 30_000 });
    const row2 = recordRows(page).filter({ hasNotText: "Website" });
    await editInputCell(row2, 0, "Launch");
    const launchRow = recordRows(page).filter({ hasText: "Launch" });
    await editSelectCell(launchRow, 5, "Doing");
    await editInputCell(launchRow, 4, startedDate);

    // --- Views: table, board grouped by Status, and two calendars — the
    // second keyed to the other date field IS the rekey (a view's key is
    // set at creation; switching views switches the key).
    await page.getByTestId("collection-views-button").click();
    await expect(page.getByTestId("collection-views-dialog")).toBeVisible();
    await addView(page, { name: "All", kind: "table" });
    await addView(page, { name: "Board", kind: "board", groupBy: "Status" });
    await addView(page, { name: "Due dates", kind: "calendar", dateField: "Due" });
    await addView(page, { name: "Start dates", kind: "calendar", dateField: "Started" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("collection-views-dialog")).toHaveCount(0);
    await expect(page.getByTestId("collection-view-switcher")).toBeVisible({
      timeout: 30_000,
    });

    // --- Board drag: Website moves Todo → Doing, and the write LANDS IN
    // THE RECORD'S FILE.
    await switchView(page, "Board");
    await expect(
      boardColumn(page, "Todo").locator('[role="listitem"][aria-label="Website"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      boardColumn(page, "Doing").locator('[role="listitem"][aria-label="Launch"]'),
    ).toBeVisible();
    await dragCardToColumn(
      page,
      boardCard(page, "Website"),
      boardColumn(page, "Doing"),
    );
    await expect(
      boardColumn(page, "Doing").locator('[role="listitem"][aria-label="Website"]'),
    ).toBeVisible({ timeout: 30_000 });
    // A virtualized column mounts only the cards near its viewport; the
    // header count is what tells the user the rest exist. After the drag
    // the Doing column holds both records.
    await expect(boardColumn(page, "Doing").locator("span.font-mono")).toHaveText(
      "2",
    );
    // The md file IS the record: the grouped-field write settles into its
    // frontmatter on disk.
    await expect
      .poll(
        async () => {
          try {
            const text = await readFile(
              join(temp.rootPath, "projects", "Untitled.md"),
              "utf8",
            );
            return /Status:\s*Doing/.test(text);
          } catch {
            return false;
          }
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
    // A completed drag is not a click: the record tab must NOT have opened.
    await expect(page.getByTestId("tab-projects/Untitled.md")).toHaveCount(0);

    // --- Calendar rekey: keyed to Due only Website renders (day 10); keyed
    // to Started only Launch renders (day 20). The events moved with the key.
    await switchView(page, "Due dates");
    await expect(
      page.locator(".rbc-event").filter({ hasText: "Website" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".rbc-event").filter({ hasText: "Launch" }),
    ).toHaveCount(0);
    await switchView(page, "Start dates");
    await expect(
      page.locator(".rbc-event").filter({ hasText: "Launch" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".rbc-event").filter({ hasText: "Website" }),
    ).toHaveCount(0);

    // --- The whole walkthrough ran without the schema file on screen: no
    // editor tab for either collection.yaml ever opened (a tab is the only
    // way file content reaches the screen, and nothing closed one).
    await expect(page.getByTestId("tab-projects/collection.yaml")).toHaveCount(0);
    await expect(page.getByTestId("tab-clients/collection.yaml")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
