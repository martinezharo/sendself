import type { Page } from "@playwright/test";
import { createSpace, expect, test } from "./device";

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder("Write a message");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test("finds messages ignoring case and accents, and steps between them", async ({ device }) => {
  const page = await device.launch();
  await createSpace(page, "Casa", "Portátil");
  await send(page, "Primera canción");
  await send(page, "Nada que ver");
  await send(page, "Otra CANCIÓN más");

  await page.getByRole("button", { name: "Search messages" }).first().click();
  const field = page.getByRole("searchbox", { name: "Search messages" });
  await expect(field).toBeFocused();

  await field.fill("cancion");
  // Starts on the newest hit.
  await expect(page.getByRole("status").filter({ hasText: "2 of 2" })).toBeVisible();
  await expect(page.locator("mark.search-hit")).toHaveCount(2);

  await field.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 of 2" })).toBeVisible();
  await field.press("Shift+Enter");
  await expect(page.getByRole("status").filter({ hasText: "2 of 2" })).toBeVisible();

  await field.fill("zzz");
  await expect(page.getByRole("status").filter({ hasText: "No results" })).toBeVisible();
  await expect(page.locator("mark.search-hit")).toHaveCount(0);

  await field.press("Escape");
  await expect(field).toBeHidden();
  await expect(page.locator("mark.search-hit")).toHaveCount(0);
});
