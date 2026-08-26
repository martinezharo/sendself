import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve `public/<dir>/index.html` in development, the way production does.
 *
 * Vite hands `publicDir` to sirv with extension fallback disabled, so it
 * resolves files but never directory indexes. Every static page in `public/`
 * — `/install/`, `/security/`, `/privacy/`, `/how-it-works/` — therefore misses
 * and falls through to the SPA history fallback, which answers with the app
 * shell. The pages exist and are correct; they are simply unreachable until a
 * build runs, so dev silently disagrees with production about what the site is.
 *
 * This restores the missing step: a directory request looks for `index.html`
 * inside it, and a directory named without its trailing slash redirects to the
 * canonical form first (relative asset URLs inside the page depend on it).
 *
 * `apply: "serve"` — the production server resolves these itself.
 */

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

/** @returns {import("vite").Plugin} */
export function devStaticPages() {
  return {
    name: "sendself:dev-static-pages",
    apply: "serve",

    configureServer(server) {
      // Registered from the hook body rather than a returned callback: this has
      // to run before Vite's SPA history fallback, which is what currently
      // swallows these URLs.
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();

        const url = req.url ?? "/";
        const [pathname, query = ""] = url.split(/(?=\?)/, 2);
        // Reject traversal before touching the filesystem: `resolve` collapses
        // `..` segments, so anything landing outside `public/` is not ours.
        const target = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(pathname)}`);
        if (!target.startsWith(PUBLIC_DIR)) return next();

        // The root is the app itself, never a static page.
        if (pathname === "/") return next();

        if (!pathname.endsWith("/")) {
          if (!existsSync(target) || !statSync(target).isDirectory()) return next();
          if (!existsSync(path.join(target, "index.html"))) return next();
          res.statusCode = 301;
          res.setHeader("location", `${pathname}/${query}`);
          return res.end();
        }

        const file = path.join(target, "index.html");
        if (!existsSync(file)) return next();

        res.setHeader("content-type", "text/html; charset=utf-8");
        // These are edited by hand while being looked at; never let the browser
        // hold a stale copy in dev.
        res.setHeader("cache-control", "no-store");
        res.end(req.method === "HEAD" ? "" : readFileSync(file));
      });
    },
  };
}
