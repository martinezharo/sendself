import { ArrowRight, ShieldCheck } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { APP_PATH, followLink } from "../state/route";
import { Logo, cx } from "../ui/components";
import { REPO_URL } from "./facts";

/**
 * The frame every page of the public site shares: header, footer, and the few
 * typographic pieces (kickers, section headings, feature cards) the pages are
 * composed from.
 *
 * The landing page and the static pages (security, privacy, 404) are rendered
 * from these same components, so a page added to the site looks like the rest
 * of it by construction rather than by a stylesheet kept in step by hand.
 */

/** Where a page sits on the site: the home page links to its sections in place. */
export type SitePage = "home" | "security" | "privacy" | "other";

/**
 * The single way into the app. A real link: it is what a crawler follows, what
 * "open in a new tab" opens, and — on the landing page, once the bundle is
 * running — a client-side navigation rather than a reload. The static pages
 * are never hydrated, so there it stays a plain link.
 */
export function OpenAppLink({
  children,
  class: cls,
}: { children: ComponentChildren; class?: string }): JSX.Element {
  return (
    <a href={APP_PATH} onClick={(event) => followLink(event as MouseEvent, APP_PATH)} class={cls}>
      {children}
    </a>
  );
}

export const PRIMARY_BUTTON =
  "inline-flex h-12 items-center justify-center gap-2 rounded-card bg-accent px-5 text-body-lg font-semibold text-on-accent shadow-accent transition hover:bg-accent-hover active:scale-[0.98] [&_svg]:size-[18px]";
export const SECONDARY_BUTTON =
  "surface-card inline-flex h-12 items-center justify-center rounded-card px-5 text-body-lg font-semibold text-ink transition hover:bg-surface-3";

const NAV_LINK = "rounded-lg px-3 py-2 transition hover:bg-surface-3 hover:text-ink";

/** A section of the landing page, linked in place from home and across pages elsewhere. */
function homeSection(page: SitePage, id: string): string {
  return page === "home" ? `#${id}` : `/#${id}`;
}

export function SiteHeader({
  page,
  solid,
}: {
  page: SitePage;
  /**
   * Painted as a bar rather than floating over the page. The landing page
   * starts transparent over its hero and turns solid as it scrolls; the static
   * pages run none of that script, so they are solid from the start. The
   * call to action comes with it: on the landing page the hero has its own,
   * so the header's only appears once that one has scrolled away.
   */
  solid: boolean;
}): JSX.Element {
  const current = (target: SitePage) => (page === target ? "page" : undefined);

  return (
    <header
      class={cx(
        "sticky top-0 z-30 transition-[background-color,border-color,box-shadow] duration-300",
        solid
          ? "border-b border-line bg-[color-mix(in_srgb,var(--c-surface)_72%,transparent)] backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 max-md:px-4">
        <a
          href={page === "home" ? "#top" : "/"}
          class="flex items-center"
          aria-label="SendSelf home"
        >
          <Logo />
        </a>
        <nav
          aria-label="Primary"
          class="flex items-center gap-1 text-note font-medium text-subtle max-md:hidden"
        >
          <a class={NAV_LINK} href={homeSection(page, "features")}>
            Features
          </a>
          <a class={NAV_LINK} href={homeSection(page, "how")}>
            How it works
          </a>
          <a
            class={cx(NAV_LINK, page === "security" && "text-ink")}
            href="/security/"
            aria-current={current("security")}
          >
            Security
          </a>
          <a
            class={cx(NAV_LINK, page === "privacy" && "text-ink")}
            href="/privacy/"
            aria-current={current("privacy")}
          >
            Privacy
          </a>
        </nav>
        <OpenAppLink
          class={cx(
            "inline-flex h-10 items-center gap-2 rounded-card bg-accent px-4 text-body font-semibold text-on-accent shadow-accent transition-[opacity,transform] duration-300 hover:bg-accent-hover active:scale-[0.98] [&_svg]:size-[17px]",
            solid ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
          )}
        >
          Open the app
          <ArrowRight />
        </OpenAppLink>
      </div>
    </header>
  );
}

export function SiteFooter({ page }: { page: SitePage }): JSX.Element {
  const link = "transition hover:text-ink";
  return (
    <footer class="border-t border-line px-6 py-12 max-md:px-4">
      <div class="mx-auto flex max-w-6xl flex-col items-center gap-6 text-center">
        <Logo />
        <p class="max-w-md text-body leading-relaxed text-muted">
          A private, end-to-end encrypted space for text and files across your devices.
        </p>
        <div class="flex items-center gap-2 font-mono text-meta uppercase tracking-[0.14em] text-muted [&_svg]:size-3.5">
          <ShieldCheck class="text-accent" />
          End-to-end encryption
        </div>
        <nav
          aria-label="Resources"
          class="flex flex-wrap justify-center gap-x-5 gap-y-2 text-note text-muted"
        >
          <a class={link} href={homeSection(page, "how")}>
            How it works
          </a>
          <a class={link} href="/security/" aria-current={page === "security" ? "page" : undefined}>
            Security
          </a>
          <a class={link} href="/privacy/" aria-current={page === "privacy" ? "page" : undefined}>
            Privacy
          </a>
          <a class={link} href={REPO_URL} rel="noopener">
            Source code
          </a>
        </nav>
        <p class="text-caption text-muted">© {new Date().getFullYear()} SendSelf</p>
      </div>
    </footer>
  );
}

/** The small mono label above a heading. */
export function Kicker({ children }: { children: ComponentChildren }): JSX.Element {
  return (
    <div class="font-mono text-meta font-medium uppercase tracking-[0.18em] text-accent">
      {children}
    </div>
  );
}

export function SectionHeading({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <div class="mx-auto max-w-2xl text-center">
      <Kicker>{kicker}</Kicker>
      <h2 class="mt-3 text-[clamp(1.6rem,3.5vw,2.25rem)] font-semibold tracking-[-0.03em]">
        {title}
      </h2>
      {subtitle && <p class="mt-3 text-body-lg leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}

export interface Feature {
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}

/** An icon, a title and a sentence or two: the site's unit of "one point". */
export function FeatureCard({ icon: Icon, title, body }: Feature): JSX.Element {
  return (
    <article class="surface-card rounded-xl2 p-6 transition hover:shadow-pop">
      <div class="grid size-11 place-items-center rounded-[12px] bg-accent-soft text-accent [&_svg]:size-[22px]">
        <Icon />
      </div>
      <h3 class="mt-4 text-lead font-semibold tracking-[-0.01em]">{title}</h3>
      <p class="mt-2 text-body leading-relaxed text-muted">{body}</p>
    </article>
  );
}
