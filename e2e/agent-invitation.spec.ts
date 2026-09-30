import { createSpace, expect, test } from "./device";

test("keeps a copied agent invitation when switching pairing tabs", async ({ device }) => {
  const page = await device.launch();
  await createSpace(page, "Agent invitation", "Owner");
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByRole("button", { name: "Add device", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const command = page.locator("[role=dialog] code");
  const original = await command.innerText();
  expect(original).toContain("npx -y sendself link ");
  await page.getByRole("button", { name: "Paste code", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(command).toHaveText(original);
});
