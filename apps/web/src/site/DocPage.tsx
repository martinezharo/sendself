import { AlertTriangle, Check, Eye, EyeOff, Info } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { cx } from "../ui/components";
import { type Feature, FeatureCard, Kicker, type SitePage, SiteFooter, SiteHeader } from "./chrome";

/**
 * The long-form pages of the site (security, privacy): a hero, an optional
 * row of highlights, and an article with its own table of contents.
 *
 * Sections are data rather than free markup so the contents list and the
 * article cannot disagree about what the page contains or what it links to.
 * The blocks below are what a section is written with; plain paragraphs and
 * lists are styled by `.site-prose` in styles.css.
 */

export interface DocSection {
  /** Anchor id, stable: other pages and the contents list link to it. */
  id: string;
  title: string;
  body: ComponentChildren;
}

export interface DocPageProps {
  page: SitePage;
  kicker: string;
  title: string;
  lead: string;
  /** ISO date (YYYY-MM-DD) the content was last checked against the product. */
  updated: string;
  highlights?: Feature[];
  sections: DocSection[];
}

function formatDate(iso: string): string {
  // Pinned to UTC: the date is a calendar day, not an instant, and a build in
  // a timezone west of UTC would otherwise print the day before.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function DocPage({
  page,
  kicker,
  title,
  lead,
  updated,
  highlights,
  sections,
}: DocPageProps): JSX.Element {
  return (
    <div class="bg-grad min-h-full">
      <SiteHeader page={page} solid />
      <main>
        <header class="px-6 pb-12 pt-16 max-md:px-4 max-md:pt-10 md:pt-24">
          <div class="mx-auto max-w-6xl">
            <div class="max-w-3xl">
              <Kicker>{kicker}</Kicker>
              <h1 class="mt-4 text-[clamp(2.1rem,4.6vw,3.25rem)] font-semibold leading-[1.06] tracking-[-0.035em]">
                {title}
              </h1>
              <p class="mt-5 text-lead leading-relaxed text-subtle md:text-[1.125rem]">{lead}</p>
              <p class="mt-6 font-mono text-meta uppercase tracking-[0.12em] text-muted">
                Last updated <time dateTime={updated}>{formatDate(updated)}</time>
              </p>
            </div>
          </div>
        </header>

        {highlights && (
          <section aria-label="Highlights" class="px-6 max-md:px-4">
            <div class="mx-auto grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {highlights.map((feature) => (
                <FeatureCard key={feature.title} {...feature} />
              ))}
            </div>
          </section>
        )}

        <div class="px-6 py-16 max-md:px-4 md:py-24">
          <div class="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16">
            <nav aria-label="On this page" class="max-lg:hidden">
              <div class="sticky top-24">
                <div class="font-mono text-meta font-medium uppercase tracking-[0.14em] text-muted">
                  On this page
                </div>
                <ol class="mt-4 flex flex-col border-l border-line">
                  {sections.map(({ id, title: label }) => (
                    <li key={id}>
                      <a
                        href={`#${id}`}
                        class="-ml-px block border-l border-transparent py-1.5 pl-4 text-note leading-snug text-muted transition hover:border-accent hover:text-ink"
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            </nav>

            <article class="site-prose max-w-[72ch]">
              {sections.map(({ id, title: heading, body }) => (
                <section key={id} id={id} aria-labelledby={`${id}-title`}>
                  <h2 id={`${id}-title`}>
                    <a href={`#${id}`}>{heading}</a>
                  </h2>
                  {body}
                </section>
              ))}
            </article>
          </div>
        </div>
      </main>
      <SiteFooter page={page} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** An aside that must not be skimmed past: a caveat, or a warning. */
export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn";
  title: string;
  children: ComponentChildren;
}): JSX.Element {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <aside
      class={cx(
        "my-6 flex gap-3.5 rounded-xl2 p-5",
        tone === "warn"
          ? "bg-[color-mix(in_srgb,var(--c-warning)_14%,transparent)]"
          : "bg-accent-soft",
      )}
    >
      <Icon
        class={cx(
          "mt-0.5 size-5 flex-none",
          tone === "warn"
            ? "text-[color-mix(in_srgb,var(--c-warning)_70%,var(--c-ink))]"
            : "text-accent",
        )}
      />
      <div class="min-w-0">
        <p class="font-semibold text-ink">{title}</p>
        <div class="mt-1 text-body leading-relaxed text-subtle [&_a]:font-medium [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2">
          {children}
        </div>
      </div>
    </aside>
  );
}

/** A numbered sequence, drawn like the landing page's steps. */
export function Steps({ items }: { items: ComponentChildren[] }): JSX.Element {
  return (
    <ol class="my-6 flex flex-col gap-3">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list, rendered once.
        <li key={index} class="surface-card flex gap-4 rounded-xl2 p-4">
          <span class="grid size-8 flex-none place-items-center rounded-[10px] bg-accent font-mono text-caption font-semibold text-on-accent">
            {index + 1}
          </span>
          <div class="min-w-0 self-center text-body leading-relaxed text-subtle">{item}</div>
        </li>
      ))}
    </ol>
  );
}

/**
 * A table that stays readable on a phone: from `md` up it is a table; below,
 * each row becomes a card with its column names written in (see
 * `.site-table` in styles.css).
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: ComponentChildren[][];
}): JSX.Element {
  return (
    <div class="surface-card my-6 overflow-hidden rounded-xl2">
      <table class="site-table">
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static table, rendered once.
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={columns[cellIndex]} data-label={columns[cellIndex]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two lists set side by side: what is protected, and what is not. */
export function Contrast({
  hidden,
  visible,
}: {
  hidden: { title: string; items: ComponentChildren[] };
  visible: { title: string; items: ComponentChildren[] };
}): JSX.Element {
  const column = (
    { title, items }: { title: string; items: ComponentChildren[] },
    tone: "hidden" | "visible",
  ): JSX.Element => {
    const Icon = tone === "hidden" ? EyeOff : Eye;
    return (
      <div class="surface-card rounded-xl2 p-5">
        <p class="flex items-center gap-2.5 font-semibold text-ink">
          <span
            class={cx(
              "grid size-8 place-items-center rounded-[10px] [&_svg]:size-[17px]",
              tone === "hidden" ? "bg-accent-soft text-accent" : "bg-surface-3 text-subtle",
            )}
          >
            <Icon />
          </span>
          {title}
        </p>
        <ul class="mt-4 flex flex-col gap-2.5">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list, rendered once.
            <li key={index} class="flex gap-2.5 text-body leading-relaxed text-subtle">
              <Check
                class={cx(
                  "mt-[3px] size-4 flex-none",
                  tone === "hidden" ? "text-accent" : "text-muted",
                )}
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div class="my-6 grid gap-4 md:grid-cols-2">
      {column(hidden, "hidden")}
      {column(visible, "visible")}
    </div>
  );
}
