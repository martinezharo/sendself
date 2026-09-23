import type { JSX } from "preact";
import { NotFoundPage } from "./NotFoundPage";
import { PrivacyPage } from "./PrivacyPage";
import { SecurityPage } from "./SecurityPage";
import type { PageMeta } from "./head";

/**
 * The static pages of the site: prerendered to plain HTML at build time
 * (scripts/prerender.mjs) and rendered on request by the dev server
 * (scripts/dev-static-pages.mjs), both from this one list.
 *
 * The landing page is not here: it is the app's own document, and it is
 * rendered by the app bundle as well as prerendered.
 */
export interface StaticPage extends PageMeta {
  /** Where the page is written in `dist`. */
  file: string;
  render: () => JSX.Element;
}

export const STATIC_PAGES: StaticPage[] = [
  {
    path: "/security/",
    file: "security/index.html",
    name: "Security model",
    title: "Security model — SendSelf",
    description:
      "How SendSelf encrypts what you share on your own devices, what the server can and cannot see, and where the protection ends.",
    render: () => <SecurityPage />,
  },
  {
    path: "/privacy/",
    file: "privacy/index.html",
    name: "Privacy policy",
    title: "Privacy policy — SendSelf",
    description:
      "What SendSelf stores, why and for how long: no account, no tracking, and end-to-end encrypted content that the service cannot read.",
    render: () => <PrivacyPage />,
  },
  {
    path: "/404.html",
    file: "404.html",
    name: "Page not found",
    title: "Page not found — SendSelf",
    description: "The SendSelf page you requested could not be found.",
    noIndex: true,
    render: () => <NotFoundPage />,
  },
];
