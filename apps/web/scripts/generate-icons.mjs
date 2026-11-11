import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import sharp from "sharp";
import {
  MASKABLE_COVERAGE,
  boxedIconSvg,
  faviconSvg,
  fullBleedIconSvg,
  publicDir,
} from "./brand.mjs";

const out = (name) => resolve(publicDir, name);

/** Vector sources, all derived from public/sendself-logo.svg. */
const sources = {
  "favicon.svg": faviconSvg(),
  "icon.svg": boxedIconSvg(),
  "icon-maskable.svg": fullBleedIconSvg({ coverage: MASKABLE_COVERAGE }),
};

// iOS masks the corners itself and ignores transparency, so the home screen
// icon needs its own opaque, square-cornered source. Only the PNG ships.
const appleTouchSource = Buffer.from(fullBleedIconSvg({ coverage: 0.66 }));

for (const [name, svg] of Object.entries(sources)) {
  await writeFile(out(name), svg);
}

/** Raster fallbacks. Android needs PNGs to mint a WebAPK; iOS can't read SVG. */
const rasters = [
  { from: "icon.svg", to: "icon-192.png", size: 192 },
  { from: "icon.svg", to: "icon-512.png", size: 512 },
  { from: "icon-maskable.svg", to: "icon-maskable-192.png", size: 192 },
  { from: "icon-maskable.svg", to: "icon-maskable-512.png", size: 512 },
  { from: appleTouchSource, to: "apple-touch-icon.png", size: 180 },
];

for (const { from, to, size } of rasters) {
  const input = Buffer.isBuffer(from) ? from : out(from);
  const pipeline = sharp(input, size ? { density: (72 * size) / 512 } : undefined);
  if (size) pipeline.resize(size, size);
  await pipeline.png({ compressionLevel: 9 }).toFile(out(to));
}

// WASM and explicit font buffers keep text independent of host fonts and native libraries.
await initWasm(await readFile(new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
const fontBuffers = await Promise.all(
  ["bricolage-grotesque", "hanken-grotesk", "jetbrains-mono"].map((name) =>
    readFile(
      new URL(
        import.meta.resolve(`@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`),
      ),
    ),
  ),
);
const renderer = new Resvg(await readFile(out("og.svg")), {
  font: { fontBuffers, defaultFontFamily: "Hanken Grotesk" },
});
const rendered = renderer.render();
try {
  await writeFile(out("og.png"), rendered.asPng());
} finally {
  rendered.free();
  renderer.free();
}

console.log(`Generated ${Object.keys(sources).length} SVG + ${rasters.length + 1} PNG assets`);
