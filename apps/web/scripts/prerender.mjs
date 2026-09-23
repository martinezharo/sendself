import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Prerendering: every document the site is served from, out of one build.
 *
 * `dist/index.html` is the public page, with the marketing page rendered into
 * it for crawlers and no-JS clients. `dist/app.html` is what `/app` and every
 * space under it are served, with the app's loading screen rendered into it
 * instead — the installed app must never paint the landing page while its
 * bundle is still loading.
 *
 * The static pages (security, privacy, 404) are poured into `page.html`, a
 * template that loads the site's styles and nothing of the app, and written
 * where they are served from. The template itself is not a page and is
 * removed.
 *
 * This runs as part of the client build rather than after it so that every
 * document exists, in its final form, before vite-plugin-pwa globs `dist` for
 * the service worker's precache manifest. Otherwise the app shell would not be
 * precached at all (and `index.html` would be precached under the revision of
 * its pre-render content).
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(webRoot, "dist");
const serverDist = resolve(webRoot, "dist-server");

const MOUNT = '<div id="app"></div>';
const PAGE_HEAD = "<!-- prerender:head -->";
const FAQ_SCHEMA = "<!-- prerender:faq-schema -->";
/** Head content that belongs to the public page only (see index.html). */
const LANDING_ONLY =
  /[ \t]*<!-- prerender:landing-only:start -->[\s\S]*?<!-- prerender:landing-only:end -->\n/g;
/** What the app shell says about itself instead. */
const APP_HEAD = `    <title>SendSelf</title>
    <meta name="robots" content="noindex" />
`;

function replaceOnce(html, marker, content, template) {
  if (!html.includes(marker)) {
    throw new Error(`Could not find ${marker} in the built ${template}`);
  }
  return html.replace(marker, () => content);
}

function mount(html, markup, template) {
  return replaceOnce(html, MOUNT, `<div id="app">${markup}</div>`, template);
}

/**
 * A static page in the `page.html` template. Shared with the dev server
 * (scripts/dev-static-pages.mjs), so a page looks the same before a build as
 * after one.
 */
export function fillPageTemplate(template, { head, body }) {
  const indented = head
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
    .trimStart();
  return mount(replaceOnce(template, PAGE_HEAD, indented, "page.html"), body, "page.html");
}

/** Turn the built index into the two documents the app is served from. */
function prerenderAppDocuments(html, { landing, appShell, faqSchema }) {
  if (!html.includes("<!-- prerender:landing-only:start -->")) {
    throw new Error("Could not find the landing-only head region in the built index.html");
  }
  const publicHtml = replaceOnce(html, FAQ_SCHEMA, faqSchema, "index.html");

  // The public head is marked up in several regions; the app says what it is
  // once, where the first of them was.
  let said = false;
  const appHead = html.replace(LANDING_ONLY, () => {
    if (said) return "";
    said = true;
    return APP_HEAD;
  });

  return {
    "index.html": mount(publicHtml, landing, "index.html"),
    "app.html": mount(appHead, appShell, "index.html"),
  };
}

/**
 * Render every document at the end of the client build.
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
        const [server, indexHtml, pageHtml] = await Promise.all([
          import(entry),
          readFile(resolve(dist, "index.html"), "utf8"),
          readFile(resolve(dist, "page.html"), "utf8"),
        ]);

        const documents = prerenderAppDocuments(indexHtml, {
          landing: server.renderLanding(),
          appShell: server.renderAppShell(),
          faqSchema: server.renderFaqSchema(),
        });
        for (const page of server.renderStaticPages()) {
          documents[page.file] = fillPageTemplate(pageHtml, page);
        }

        for (const [name, content] of Object.entries(documents)) {
          const file = resolve(dist, name);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content);
        }

        await rm(resolve(dist, "page.html"));
        await rm(serverDist, { recursive: true, force: true });
        console.log(`Prerendered ${Object.keys(documents).join(", ")}`);
      },
    },
  };
}
