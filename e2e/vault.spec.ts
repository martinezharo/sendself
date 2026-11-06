import type { Page } from "@playwright/test";
import { createSpace, expect, test } from "./device";

/** Drag one tree row onto another with the mouse, the way a person would. */
async function dragRow(page: Page, from: string, to: string): Promise<void> {
  const source = await page.getByRole("treeitem", { name: from }).boundingBox();
  const target = await page.getByRole("treeitem", { name: to }).boundingBox();
  if (!source || !target) throw new Error("Both rows must be on screen");
  await page.mouse.move(source.x + 60, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 60, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("keeps folders, notes and files across launches, with a trash to restore from", async ({
  device,
}) => {
  let page = await device.launch();
  const spaceId = await createSpace(page, "Casa", "Portátil");

  await page.getByRole("link", { name: "Vault" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/${spaceId}/vault$`));
  await expect(page.getByRole("heading", { name: "Nothing in the vault yet" })).toBeVisible();

  // A folder opens in place, as part of the tree.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Taxes");
  await page.getByRole("button", { name: "Create folder" }).click();
  const taxes = page.getByRole("treeitem", { name: "Taxes" });
  await taxes.click();
  await expect(taxes).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Nothing here yet")).toBeVisible();

  // And can be opened as a page of its own, with a URL.
  await page.getByRole("button", { name: "Options for Taxes" }).click();
  await page.getByRole("menuitem", { name: "Open as page" }).click();
  await expect(page).toHaveURL(/\/vault\/[^/]+$/);

  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Accountant");
  await page
    .getByRole("textbox", { name: "Note" })
    .fill("Call Marta before the 30th\nShe has the 2025 receipts");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Call Marta before the 30th She has the 2025 receipts"),
  ).toBeVisible();

  // A file, uploaded through the picker.
  await page.locator('input[type="file"]').setInputFiles({
    name: "receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("total: 42"),
  });
  await expect(page.getByRole("treeitem", { name: "receipt.txt" })).toBeVisible();

  // Closing the app and coming back reads it all from this device and the server.
  await device.close();
  page = await device.launch(`/app/${spaceId}`);
  await page.getByRole("link", { name: "Vault" }).first().click();
  await page.getByRole("treeitem", { name: "Taxes" }).click();
  // Opened from the keyboard, the note takes the focus: Tab and Delete act in
  // it, not on the row behind (which Delete would send to the trash).
  await page.getByRole("treeitem", { name: "Accountant" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Note: Accountant" })).toBeFocused();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Note" })).toHaveValue(
    "Call Marta before the 30th\nShe has the 2025 receipts",
  );
  await page
    .getByRole("textbox", { name: "Note" })
    .fill("Call Marta before the 30th\nReceipts are in the blue folder");
  // Back with unsaved changes asks instead of dropping them.
  await page.goBack();
  await expect(page.getByText("Save your changes to this note?")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note" })).toHaveValue(
    "Call Marta before the 30th\nReceipts are in the blue folder",
  );
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Receipts are in the blue folder")).toBeVisible();

  // Dragging a row onto a folder moves it there.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Archive");
  await page.getByRole("button", { name: "Create folder" }).click();
  // Measured once the new folder is in: its row shifts the ones below it.
  await expect(page.getByRole("treeitem", { name: "Archive" })).toBeVisible();
  await dragRow(page, "receipt.txt", "Archive");
  await expect(page.getByText("Moved receipt.txt to Archive")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "receipt.txt" })).toHaveAttribute(
    "aria-level",
    "2",
  );
  await expect(page.getByRole("treeitem", { name: "Archive" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  // Trash and restore.
  await page.getByRole("button", { name: "Options for receipt.txt" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("treeitem", { name: "receipt.txt" })).toBeHidden();
  await page.getByRole("link", { name: /Trash/ }).click();
  await page.getByRole("button", { name: "Options for receipt.txt" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("treeitem", { name: "receipt.txt" })).toBeVisible();
});

/**
 * Drag with a finger: hold the row until it lifts, then carry it. Sent as real
 * touches through the browser's input pipeline, so scrolling, long-press and
 * pointer cancellation all behave as they would on a phone.
 */
async function touchDragRow(page: Page, from: string, to: string): Promise<void> {
  const source = await page.getByRole("treeitem", { name: from }).boundingBox();
  const target = await page.getByRole("treeitem", { name: to }).boundingBox();
  if (!source || !target) throw new Error("Both rows must be on screen");
  const cdp = await page.context().newCDPSession(page);
  const start = { x: source.x + 60, y: source.y + source.height / 2 };
  const end = { x: target.x + 60, y: target.y + target.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await page.waitForTimeout(600);
  for (let step = 1; step <= 12; step++) {
    const x = start.x + ((end.x - start.x) * step) / 12;
    const y = start.y + ((end.y - start.y) * step) / 12;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("moves items by touch, and offers adding and copying from a right-click", async ({
  device,
}) => {
  const page = await device.launch();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const spaceId = await createSpace(page, "Móvil", "Teléfono");
  await page.goto(`/app/${spaceId}/vault`);
  await expect(page.getByRole("heading", { name: "Nothing in the vault yet" })).toBeVisible();

  // A right-click on the empty page adds at the top level.
  await page.mouse.click(640, 420, { button: "right" });
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Inbox");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByRole("treeitem", { name: "Inbox" })).toBeVisible();

  await page.mouse.click(640, 500, { button: "right" });
  await page.getByRole("menuitem", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Wifi");
  await page.getByRole("textbox", { name: "Note" }).fill("casa-5G / hunter2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Wifi" })).toBeVisible();

  // A right-click on a note copies what it says.
  await page.getByRole("treeitem", { name: "Wifi" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy text" }).click();
  await expect(page.getByText("Note copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("casa-5G / hunter2");

  // And a finger carries it into the folder.
  await touchDragRow(page, "Wifi", "Inbox");
  await expect(page.getByText("Moved Wifi to Inbox")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Wifi" })).toHaveAttribute("aria-level", "2");
});
