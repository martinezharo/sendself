import { createSpace, expect, test } from "./device";

test("keeps folders, notes and files across launches, with a trash to restore from", async ({
  device,
}) => {
  let page = await device.launch();
  const spaceId = await createSpace(page, "Casa", "Portátil");

  await page.getByRole("link", { name: "Vault" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/${spaceId}/vault$`));
  await expect(page.getByRole("heading", { name: "Keep things here" })).toBeVisible();

  // A folder, and a note inside it.
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Taxes");
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: /^Taxes/ }).click();
  await expect(page).toHaveURL(/\/vault\/[^/]+$/);

  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
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
  await expect(page.getByRole("button", { name: /^receipt\.txt/ })).toBeVisible();

  // Closing the app and coming back reads it all from this device and the server.
  await device.close();
  page = await device.launch(`/app/${spaceId}`);
  await page.getByRole("link", { name: "Vault" }).first().click();
  await page.getByRole("button", { name: /^Taxes/ }).click();
  await page.getByRole("button", { name: /^Accountant/ }).click();
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

  // Trash and restore.
  await page.getByRole("button", { name: "Options for receipt.txt" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("button", { name: /^receipt\.txt/ })).toBeHidden();
  await page.getByRole("link", { name: /Trash/ }).click();
  await page.getByRole("button", { name: "Options for receipt.txt" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("button", { name: /^receipt\.txt/ })).toBeVisible();
});
