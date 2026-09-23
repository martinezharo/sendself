import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fillPageTemplate } from "./prerender.mjs";

/**
 * Serve the site's static pages in development, the way production does.
 *
 * In a build, `/security/`, `/privacy/` and the 404 page are prerendered into
 * `page.html` (scripts/prerender.mjs). The dev server has no build to read, so
 * without this every one of those URLs falls through to the SPA history
 * fallback and answers with the app instead: the pages would only exist once
 * built, and dev would silently disagree with production about what the site
 * is. Here they are rendered on request from the same components and the same
 * template, through Vite's module graph, so an edit shows on reload.
 *
 * A page named without its trailing slash redirects to the canonical form,
 * which is what the production assets binding does too.
 *
 * `apply: "serve"` — in a build, the pages are files.
 */

const TEMPLATE = fileURLToPath(new URL("../page.html", import.meta.url));
const ENTRY = "/src/entry-server.tsx";
/**
 * In dev, Vite injects CSS from JavaScript, after the document has painted.
 * The app never notices (its content is rendered by that same JavaScript),
 * but these pages arrive already rendered, so they would paint unstyled first:
 * an unsized logo in the default link colour. A build links the stylesheet
 * from the head, where it blocks the first paint; this does the same in dev.
 * The duplicate styles the script injects later are identical, so harmless.
 */
const DEV_STYLESHEET = '<link rel="stylesheet" href="/src/styles.css" />\n  ';

/** @returns {import("vite").Plugin} */
export function devStaticPages() {
  return {
    name: "sendself:dev-static-pages",
    apply: "serve",

    configureServer(server) {
      // Registered from the hook body rather than a returned callback: this has
      // to run before Vite's SPA history fallback, which would otherwise answer
      // these URLs with the app.
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        // Only navigations: every script, style and asset request passes by.
        if (!req.headers.accept?.includes("text/html")) return next();

        const url = req.url ?? "/";
        const [pathname, query = ""] = url.split(/(?=\?)/, 2);

        try {
          const { renderStaticPage } = await server.ssrLoadModule(ENTRY);

          if (!pathname.endsWith("/") && renderStaticPage(`${pathname}/`)) {
            res.statusCode = 301;
            res.setHeader("location", `${pathname}/${query}`);
            return res.end();
          }

          const page = renderStaticPage(pathname);
          if (!page) return next();

          const template = await readFile(TEMPLATE, "utf8");
          const html = await server.transformIndexHtml(
            url,
            fillPageTemplate(template, page).replace("</head>", `${DEV_STYLESHEET}</head>`),
          );
          res.setHeader("content-type", "text/html; charset=utf-8");
          // Rendered from source on every request; never let the browser keep
          // a copy from before the last edit.
          res.setHeader("cache-control", "no-store");
          res.end(req.method === "HEAD" ? "" : html);
        } catch (error) {
          server.ssrFixStacktrace(error);
          next(error);
        }
      });
    },
  };
}
