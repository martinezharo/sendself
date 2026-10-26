/**
 * Android launcher assets and the Play Store icon.
 *
 * The brand mark lives in apps/web/public; this script only rasterises it into
 * the density buckets Android expects. Run it after changing the web icons:
 *
 *   pnpm android:icons
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webPublic = resolve(root, "apps/web/public");
const res = resolve(root, "apps/android/app/src/main/res");
const play = resolve(root, "apps/android/play");

const boxedIcon = resolve(webPublic, "icon-512.png");
const maskableIcon = resolve(webPublic, "icon-maskable-512.png");
const masterLogo = await readFile(resolve(webPublic, "sendself-logo.svg"), "utf8");

/** Densities from Android's mipmap buckets; sizes are in dp times this. */
const densities = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

await mkdir(play, { recursive: true });

// minSdk 26 means every supported launcher reads the adaptive icon, so there
// are no legacy 48dp bitmaps or a separate round icon to keep in sync.
for (const [bucket, scale] of densities) {
  const dir = resolve(res, `mipmap-${bucket}`);
  await mkdir(dir, { recursive: true });

  // The full-bleed gradient is the foreground: the launcher's mask shapes the
  // icon and the mark keeps its maskable safe-zone padding.
  const adaptive = Math.round(108 * scale);
  await sharp(maskableIcon)
    .resize(adaptive, adaptive)
    .png()
    .toFile(resolve(dir, "ic_launcher_foreground.png"));

  // Themed (monochrome) icons: Android tints this alpha mask itself.
  const markSize = Math.round(adaptive * 0.55);
  const mark = await sharp(Buffer.from(masterLogo))
    .resize(markSize, markSize, { fit: "contain" })
    .toBuffer();
  await sharp({
    create: {
      width: adaptive,
      height: adaptive,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(resolve(dir, "ic_launcher_monochrome.png"));
}

await mkdir(resolve(res, "drawable-nodpi"), { recursive: true });
await sharp(boxedIcon).resize(256, 256).png().toFile(resolve(res, "drawable-nodpi/splash.png"));

await copyFile(maskableIcon, resolve(play, "icon-512.png"));

console.log("Generated Android launcher icons and the 512px Play Store icon");
