import { SITE_ORIGIN } from "./facts";

/**
 * The `<head>` of a prerendered site page, as HTML.
 *
 * Written out at build time by `scripts/prerender.mjs`, so it is the page's
 * one description of itself: the title, the search snippet, the social card
 * and the breadcrumb all come from the same `PageMeta` rather than being
 * repeated per file.
 */

export interface PageMeta {
  /** Path the page is served at, e.g. `/security/`. */
  path: string;
  /** Document title, brand included. */
  title: string;
  /** Search snippet and social card text. */
  description: string;
  /** Short name used in the breadcrumb and on social cards. */
  name: string;
  /** Kept out of search results (the 404 page). */
  noIndex?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A JSON-LD block. `<` is escaped so no string inside it can close the script
 * element early; JSON parsers read `<` back as the same character.
 */
export function jsonLd(data: unknown): string {
  const json = JSON.stringify(data, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

export function renderPageHead(meta: PageMeta): string {
  const url = `${SITE_ORIGIN}${meta.path}`;
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);

  if (meta.noIndex) {
    return [
      `<title>${title}</title>`,
      `<meta name="description" content="${description}" />`,
      `<meta name="robots" content="noindex, nofollow" />`,
    ].join("\n");
  }

  const image = `${SITE_ORIGIN}/og.png`;
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    `<link rel="canonical" href="${url}" />`,
    `<link rel="describedby" href="${SITE_ORIGIN}/llms.txt" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="SendSelf" />`,
    `<meta property="og:title" content="${escapeHtml(meta.name)} — SendSelf" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:alt" content="SendSelf — end-to-end encrypted sharing across your devices" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.name)} — SendSelf" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "SendSelf", item: `${SITE_ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: meta.name, item: url },
      ],
    }),
  ].join("\n");
}
