import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const publicDir = resolve(webRoot, "public");

/**
 * Single source of truth for the brand mark. Every icon is derived from the
 * master logo, so the outline only ever lives in one file.
 */
const master = readFileSync(resolve(publicDir, "sendself-logo.svg"), "utf8");
export const MARK_PATH = /\sd="([^"]+)"/.exec(master)[1];

/**
 * Tight bounding box of the outline (flattened curves), *not* the master
 * viewBox: the artwork sits off-centre inside its own canvas and is wider than
 * it is tall, so laying it out by viewBox leaves dead space and a visible
 * vertical offset.
 */
const MARK = { x: 83.91, y: 123.16, width: 927.15, height: 828.35 };
const MARK_CX = MARK.x + MARK.width / 2;
const MARK_CY = MARK.y + MARK.height / 2;

const round = (n) => Number(n.toFixed(2));

export const BRAND = {
  /** Light end of the brand gradient: legible on dark backgrounds. */
  light: "#ff7a45",
  /** Dark end: legible on light backgrounds. */
  dark: "#c2410c",
};

/**
 * Centres the mark on a `size`×`size` canvas, scaled so its widest dimension
 * covers `coverage` of the canvas.
 */
export function markGroup({ size, coverage, fill, className }) {
  const scale = (coverage * size) / MARK.width;
  const tx = size / 2 - scale * MARK_CX;
  const ty = size / 2 - scale * MARK_CY;
  return [
    `  <g transform="translate(${round(tx)} ${round(ty)}) scale(${scale.toFixed(5)})">`,
    `    <path${className ? ` class="${className}"` : ""} fill-rule="evenodd" fill="${fill}" d="${MARK_PATH}"/>`,
    "  </g>",
  ].join("\n");
}

const gradient = (id) =>
  [
    "  <defs>",
    `    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`,
    `      <stop offset="0" stop-color="${BRAND.light}"/>`,
    `      <stop offset="1" stop-color="${BRAND.dark}"/>`,
    "    </linearGradient>",
    "  </defs>",
  ].join("\n");

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="SendSelf">\n${body}\n</svg>\n`;

/**
 * Tab favicon: no container, mark near full-bleed so it survives 16px, and a
 * flat brand colour that flips with the browser chrome's colour scheme —
 * #c2410c is 5.2:1 on a light tab strip but only 3.2:1 on a dark one, and
 * #ff7a45 is the mirror image.
 */
export function faviconSvg() {
  const size = 512;
  return svg(
    size,
    [
      "  <style>",
      `    .mark { fill: ${BRAND.dark} }`,
      `    @media (prefers-color-scheme: dark) { .mark { fill: ${BRAND.light} } }`,
      "  </style>",
      markGroup({ size, coverage: 0.98, fill: BRAND.dark, className: "mark" }),
    ].join("\n"),
  );
}

/** Boxed icon on the brand gradient, with the platform's usual squircle radius. */
export function boxedIconSvg({ size = 512, radius = 0.21875, coverage = 0.66 } = {}) {
  return svg(
    size,
    [
      gradient("g"),
      `  <rect width="${size}" height="${size}" rx="${round(radius * size)}" fill="url(#g)"/>`,
      markGroup({ size, coverage, fill: "#fff" }),
    ].join("\n"),
  );
}

/**
 * Full-bleed variants for surfaces that apply their own mask (Android maskable
 * icons, iOS home screen). Maskable keeps the mark inside the 80% safe circle;
 * iOS only rounds the corners, so it can breathe more.
 */
export function fullBleedIconSvg({ size = 512, coverage } = {}) {
  return svg(
    size,
    [
      gradient("gm"),
      `  <rect width="${size}" height="${size}" fill="url(#gm)"/>`,
      markGroup({ size, coverage, fill: "#fff" }),
    ].join("\n"),
  );
}

/** Largest coverage whose bounding box still fits inside the maskable safe circle. */
export const MASKABLE_COVERAGE = (0.8 * MARK.width) / Math.hypot(MARK.width, MARK.height);
