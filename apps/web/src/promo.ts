/**
 * The promo funnel, seen from the page (`packages/shared/src/promo.ts` has the
 * steps): each step a visitor from a promo takes here is reported once to
 * `POST /api/promo-event`. The tracker comes from @martinezharo/promo-funnel;
 * it never throws, and browsers driven by automation report nothing.
 */
import { createPromoTracker } from "@martinezharo/promo-funnel/page";
import { type PromoEventName, promoFunnel } from "@sendself/shared";

const tracker = createPromoTracker(promoFunnel);

/** Run on every page load, before anything rewrites the URL. */
export function startPromoTracking(): void {
  tracker.start();
}

/**
 * Report a step of the funnel, once per arrival. A no-op for a visitor who
 * did not come from a promo, or came more than seven days ago. Safe to call
 * from anywhere, any number of times.
 */
export function trackPromoStep(step: PromoEventName): void {
  tracker.track(step);
}
