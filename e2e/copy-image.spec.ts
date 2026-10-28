import sharp from "sharp";
import { createSpace, expect, settle, test } from "./device";

/** A gradient JPEG: a type the clipboard refuses as-is, so the PNG conversion is exercised. */
async function sampleJpeg(): Promise<Buffer> {
  const width = 480;
  const height = 320;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#6366f1"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="340" cy="110" r="52" fill="#fde68a"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

test("copies an image from the message menu as a PNG", async ({ device }) => {
  const page = await device.launch();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await createSpace(page, "Casa", "Portátil");

  await page.locator("input[type=file]").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: await sampleJpeg(),
  });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("img").first()).toBeVisible();
  await settle(page);

  await page.getByRole("button", { name: "Message actions" }).first().click({ force: true });
  const copy = page.getByRole("menuitem", { name: "Copy image" });
  await expect(copy).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/menu.png` : undefined,
  });

  await copy.click();
  await expect(page.getByText("Image copied to clipboard")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/copied.png` : undefined,
  });

  const types = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return items.flatMap((item) => item.types);
  });
  expect(types).toEqual(["image/png"]);
});
