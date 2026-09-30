import { createSpace, expect, test } from "./device";

test("starts an agent invitation on first visit and preserves it across tabs", async ({
  device,
}) => {
  const page = await device.launch();
  await createSpace(page, "Agent invitation", "Owner");
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.clock.install();
  await page.getByRole("button", { name: "Add device", exact: true }).click();
  await page.clock.fastForward(11 * 60_000);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.clock.fastForward(2500);
  await expect(page.getByText("Waiting for it to connect · expires in 10 min")).toBeVisible();
  const command = page.locator("[role=dialog] code");
  const original = await command.innerText();
  expect(original).toContain("npx -y sendself link ");
  await page.getByRole("button", { name: "Paste code", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(command).toHaveText(original);
});
