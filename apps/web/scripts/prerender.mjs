import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Prerendering: one build, two documents.
 *
 * `dist/index.html` is the public page, with the marketing page rendered into
 * it for crawlers and no-JS clients. `dist/app.html` is what `/app` and every
 * space under it are served, with the app's loading screen rendered into it
 * instead — the installed app must never paint the landing page while its
 * bundle is still loading.
 *
 * This runs as part of the client build rather than after it so that both
 * documents exist, in their final form, before vite-plugin-pwa globs `dist`
 * for the service worker's precache manifest. Otherwise the app shell would
 * not be precached at all (and `index.html` would be precached under the
 * revision of its pre-render content).
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(webRoot, "dist");
const serverDist = resolve(webRoot, "dist-server");

const MOUNT = '<div id="app"></div>';
/** Head content that belongs to the public page only (see index.html). */
const LANDING_ONLY =
  /[ \t]*<!-- prerender:landing-only:start -->[\s\S]*?<!-- prerender:landing-only:end -->\n/g;
/** What the app shell says about itself instead. */
const APP_HEAD = `    <title>SendSelf</title>
    <meta name="robots" content="noindex" />
`;

function mount(html, markup) {
  return html.replace(MOUNT, `<div id="app">${markup}</div>`);
}

/** Turn the built index into the two documents the site is served from. */
function prerenderDocuments(html, { landing, appShell }) {
  if (!html.includes(MOUNT)) {
    throw new Error("Could not find the app mount point in the built index.html");
  }
  if (!html.includes("<!-- prerender:landing-only:start -->")) {
    throw new Error("Could not find the landing-only head region in the built index.html");
  }

  // The public head is marked up in several regions; the app says what it is
  // once, where the first of them was.
  let said = false;
  const appHead = html.replace(LANDING_ONLY, () => {
    if (said) return "";
    said = true;
    return APP_HEAD;
  });

  return {
    "index.html": mount(html, landing),
    "app.html": mount(appHead, appShell),
  };
}

/**
 * Render both documents at the end of the client build.
 *
 * It reads the SSR bundle built beforehand (`vite build --ssr`), so the markup
 * comes from the very components the app renders rather than from a copy of
 * them kept in sync by hand.
 */
export function prerender() {
  return {
    name: "sendself:prerender",
    apply: "build",
    closeBundle: {
      sequential: true,
      order: "pre",
      async handler() {
        const entry = pathToFileURL(resolve(serverDist, "entry-server.js")).href;
        const [{ renderLanding, renderAppShell }, html] = await Promise.all([
          import(entry),
          readFile(resolve(dist, "index.html"), "utf8"),
        ]);

        const documents = prerenderDocuments(html, {
          landing: renderLanding(),
          appShell: renderAppShell(),
        });
        for (const [name, content] of Object.entries(documents)) {
          await writeFile(resolve(dist, name), content);
        }

        await rm(serverDist, { recursive: true, force: true });
        console.log(`Prerendered ${Object.keys(documents).join(", ")}`);
      },
    },
  };
}
