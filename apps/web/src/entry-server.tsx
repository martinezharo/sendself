import render from "preact-render-to-string";
import { FAQS, Landing } from "./site/Landing";
import { jsonLd, renderPageHead } from "./site/head";
import { STATIC_PAGES, type StaticPage } from "./site/pages";
import { Loading } from "./ui/components";

/**
 * Every document this site is built from.
 *
 * `/` is the public marketing page, prerendered so crawlers and no-JS clients
 * get real HTML. `/app` is the application, and it is prerendered as the
 * app's own loading screen — never as the marketing page. Serving one document
 * for both is what used to make the installed app flash the landing page on
 * every launch: the shell painted before the bundle had booted, and the shell
 * was the landing.
 *
 * The static pages (security, privacy, 404) are neither: they are rendered
 * once, here, and never run the app at all.
 */

/** The public marketing page, as served at `/`. */
export function renderLanding(): string {
  return render(<Landing prerendered />);
}

/** The FAQ's structured data, written from the same questions the page shows. */
export function renderFaqSchema(): string {
  return jsonLd({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  });
}

/** The app's first paint, as served at `/app` and everything under it. */
export function renderAppShell(): string {
  return render(<Loading />);
}

export interface RenderedPage {
  path: string;
  /** Where the page is written in `dist`. */
  file: string;
  head: string;
  body: string;
}

function renderPage(page: StaticPage): RenderedPage {
  return {
    path: page.path,
    file: page.file,
    head: renderPageHead(page),
    body: render(page.render()),
  };
}

/** A static page, ready to be poured into `page.html`; `undefined` if `path` is not one. */
export function renderStaticPage(path: string): RenderedPage | undefined {
  const page = STATIC_PAGES.find((candidate) => candidate.path === path);
  return page && renderPage(page);
}

export function renderStaticPages(): RenderedPage[] {
  return STATIC_PAGES.map(renderPage);
}
