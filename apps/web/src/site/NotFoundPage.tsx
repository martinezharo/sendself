import { ArrowRight } from "lucide-preact";
import type { JSX } from "preact";
import {
  Kicker,
  OpenAppLink,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SiteFooter,
  SiteHeader,
} from "./chrome";

/** Served for any URL the site does not have (`not_found_handling` in wrangler.jsonc). */
export function NotFoundPage(): JSX.Element {
  return (
    <div class="bg-grad flex min-h-full flex-col">
      <SiteHeader page="other" solid />
      <main class="grid flex-1 place-items-center px-6 py-24 max-md:px-4 max-md:py-16">
        <div class="max-w-xl text-center">
          <Kicker>404</Kicker>
          <h1 class="mt-4 text-[clamp(2.1rem,4.6vw,3.25rem)] font-semibold leading-[1.06] tracking-[-0.035em]">
            That page is not here
          </h1>
          <p class="mt-5 text-lead leading-relaxed text-subtle">
            The link may be out of date, or the page may have moved. Your spaces are in the app,
            exactly where you left them.
          </p>
          <div class="mt-8 flex flex-wrap justify-center gap-3 max-sm:flex-col max-sm:items-stretch">
            <OpenAppLink class={PRIMARY_BUTTON}>
              Open the app
              <ArrowRight />
            </OpenAppLink>
            <a href="/" class={SECONDARY_BUTTON}>
              Back to the home page
            </a>
          </div>
        </div>
      </main>
      <SiteFooter page="other" />
    </div>
  );
}
