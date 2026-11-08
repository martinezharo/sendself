/**
 * The promo funnel, seen from the page: a visitor arrives from a promo for
 * SendSelf on one of the author's other sites, and each step they go on to
 * take here is reported once to `POST /api/promo-event` (see
 * `packages/shared/src/promo.ts` for the steps and the Worker's checks).
 *
 * The contract is the same on every site of the funnel:
 *
 *  - The promo link's `utm_*` and `promo_lang` parameters become an
 *    attribution in localStorage, replacing any older one, and are taken out
 *    of the URL so a bookmark or a shared link does not count again.
 *  - An attribution lives seven days, and reports each step at most once.
 *  - Time on the site is only counted in the tab the visitor arrived in, and
 *    only while it is visible.
 *
 * Nothing here may break or slow the app: every storage access tolerates a
 * browser that refuses it, and a failed report is simply lost.
 */

import {
  PROMO_ID,
  PROMO_LOCALE,
  PROMO_NAME,
  PROMO_SOURCES,
  type PromoEvent,
  type PromoEventName,
  type PromoSource,
} from "@sendself/shared";

export interface PromoAttribution {
  promo: typeof PROMO_NAME;
  source: PromoSource;
  placement: string;
  locale: string;
  variant: string;
  /** When the visitor arrived (ms since the epoch). */
  at: number;
  /** The steps already reported for this attribution. */
  sent: PromoEventName[];
}

const ATTRIBUTION_KEY = "promo-attribution";
/** Marks the tab the visitor arrived in: only its time on the site counts. */
const VISIT_KEY = "promo-visit";
/** Visible time accumulated across the page loads of the arrival tab. */
const VISIBLE_KEY = "promo-visible-ms";

export const PROMO_ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The URL parameters a promo link carries, all removed on arrival. */
const PROMO_PARAMS = ["utm_source", "utm_medium", "utm_content", "utm_term", "promo_lang"];

/** Time-on-site steps, by the visible time that earns them. */
const STAY_STEPS: ReadonlyArray<readonly [number, PromoEventName]> = [
  [10_000, "stay-10s"],
  [60_000, "stay-1m"],
  [180_000, "stay-3m"],
];

/** How often visible time is saved while the tab is in view. */
const TICK_MS = 5_000;

function isSource(value: unknown): value is PromoSource {
  return typeof value === "string" && (PROMO_SOURCES as readonly string[]).includes(value);
}

/** The two-letter base language of a BCP 47 tag, if it has one. */
function baseLanguage(tag: string): string | undefined {
  const base = tag.split("-", 1)[0]?.toLowerCase() ?? "";
  return PROMO_LOCALE.test(base) ? base : undefined;
}

/**
 * The attribution a promo link carries, or null when the URL is not one.
 * `pageLang` is the page's own language, used when the link names none.
 */
export function parsePromoArrival(
  url: URL,
  pageLang: string,
  now: number,
): PromoAttribution | null {
  const params = url.searchParams;
  if (params.get("utm_medium") !== "promo") return null;
  const source = params.get("utm_source");
  const placement = params.get("utm_content") ?? "";
  if (!isSource(source) || !PROMO_ID.test(placement)) return null;
  const promoLang = params.get("promo_lang") ?? "";
  const term = params.get("utm_term") ?? "";
  return {
    promo: PROMO_NAME,
    source,
    placement,
    locale: PROMO_LOCALE.test(promoLang) ? promoLang : (baseLanguage(pageLang) ?? "en"),
    variant: PROMO_ID.test(term) ? term : "",
    at: now,
    sent: [],
  };
}

/** The URL without the promo parameters, as a path for `history.replaceState`. */
export function stripPromoParams(url: URL): string {
  const clean = new URL(url);
  for (const name of PROMO_PARAMS) clean.searchParams.delete(name);
  return `${clean.pathname}${clean.search}${clean.hash}`;
}

/**
 * A stored attribution, if it is well-formed and still within its seven days.
 * Anything else is as good as none.
 */
export function parseStoredAttribution(raw: string | null, now: number): PromoAttribution | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { promo, source, placement, locale, variant, at, sent } = value as Record<string, unknown>;
  if (promo !== PROMO_NAME || !isSource(source)) return null;
  if (typeof placement !== "string" || !PROMO_ID.test(placement)) return null;
  if (typeof locale !== "string" || !PROMO_LOCALE.test(locale)) return null;
  if (typeof variant !== "string" || (variant !== "" && !PROMO_ID.test(variant))) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || now - at > PROMO_ATTRIBUTION_TTL_MS) {
    return null;
  }
  if (!Array.isArray(sent) || !sent.every((step) => typeof step === "string")) return null;
  return { promo, source, placement, locale, variant, at, sent: sent as PromoEventName[] };
}

// ---------------------------------------------------------------------------
// Storage (each access may throw: private modes, blocked site data)
// ---------------------------------------------------------------------------

function storageGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Nowhere to keep it: the funnel loses this visitor, the app does not care.
  }
}

function storageRemove(storage: () => Storage, key: string): void {
  try {
    storage().removeItem(key);
  } catch {
    // As above.
  }
}

const local = (): Storage => localStorage;
const session = (): Storage => sessionStorage;

/** The live attribution, dropping one that expired or cannot be read. */
function loadAttribution(): PromoAttribution | null {
  const raw = storageGet(local, ATTRIBUTION_KEY);
  const attribution = parseStoredAttribution(raw, Date.now());
  if (!attribution && raw !== null) storageRemove(local, ATTRIBUTION_KEY);
  return attribution;
}

function post(event: PromoEventName, attribution: PromoAttribution): void {
  const body: PromoEvent = {
    event,
    promo: attribution.promo,
    source: attribution.source,
    placement: attribution.placement,
    locale: attribution.locale,
    variant: attribution.variant,
  };
  try {
    void fetch("/api/promo-event", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // A missing or refusing fetch costs the event, nothing else.
  }
}

/**
 * Report a step of the funnel, once per attribution. A no-op for a visitor who
 * did not come from a promo, or came more than seven days ago. Safe to call
 * from anywhere, any number of times.
 */
export function trackPromoStep(step: PromoEventName): void {
  try {
    const attribution = loadAttribution();
    if (!attribution || attribution.sent.includes(step)) return;
    // Recorded before sending: a step is better lost than counted twice.
    attribution.sent.push(step);
    storageSet(local, ATTRIBUTION_KEY, JSON.stringify(attribution));
    post(step, attribution);
  } catch {
    // Never let the funnel get in the app's way.
  }
}

// ---------------------------------------------------------------------------
// Page script
// ---------------------------------------------------------------------------

/** Turn a promo link's parameters into an attribution, then clean the URL. */
function recordArrival(): void {
  const url = new URL(location.href);
  const attribution = parsePromoArrival(url, document.documentElement.lang, Date.now());
  if (!attribution) return;
  storageSet(local, ATTRIBUTION_KEY, JSON.stringify(attribution));
  trackPromoStep("arrive");
  history.replaceState(history.state, "", stripPromoParams(url));
  storageSet(session, VISIT_KEY, "1");
  // A new arrival starts its own clock, even in a tab that came before.
  storageSet(session, VISIBLE_KEY, "0");
}

/**
 * Count the visible time of the arrival tab, reporting each stay step as it is
 * crossed. Saved on every tick, when the tab is hidden and when it unloads, so
 * the next page load of the same tab picks up where this one left off.
 */
function trackVisibleTime(): void {
  if (storageGet(session, VISIT_KEY) !== "1") return;
  const pending = (attribution: PromoAttribution | null) =>
    attribution ? STAY_STEPS.filter(([, step]) => !attribution.sent.includes(step)) : [];
  if (pending(loadAttribution()).length === 0) return;

  let total = Number(storageGet(session, VISIBLE_KEY)) || 0;
  let since: number | null = document.visibilityState === "visible" ? performance.now() : null;

  const save = (): void => {
    const now = performance.now();
    if (since !== null) {
      total += now - since;
      since = document.visibilityState === "visible" ? now : null;
    }
    storageSet(session, VISIBLE_KEY, String(Math.round(total)));
    const left = pending(loadAttribution());
    for (const [threshold, step] of left) {
      if (total >= threshold) trackPromoStep(step);
    }
    if (left.every(([threshold]) => total >= threshold)) stop();
  };
  const onVisibility = (): void => {
    save();
    if (document.visibilityState === "visible") since ??= performance.now();
  };
  const stop = (): void => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("pagehide", save);
  };

  const timer = setInterval(() => {
    if (since !== null) save();
  }, TICK_MS);
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("pagehide", save);
}

/** Run on every page load, before anything rewrites the URL. */
export function startPromoTracking(): void {
  try {
    recordArrival();
    trackVisibleTime();
  } catch {
    // As everywhere here: the funnel is never worth an error in the app.
  }
}
