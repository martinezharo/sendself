import { parsePromoEvent } from "@sendself/shared";
import { ApiError } from "../errors";
import { readJsonObject } from "../http";
import type { RouteContext } from "../router";
import { clientIp, rateLimit } from "../security";

/** A promo event is six short fields; anything bigger is not one. */
const MAX_PROMO_EVENT_BYTES = 256;

/**
 * `POST /api/promo-event`: a step of the promo funnel (see
 * `packages/shared/src/promo.ts`), counted into the `promo_events` dataset the
 * author's other sites also write. Unauthenticated and anonymous: nothing
 * about the visitor is kept, not even the country.
 */
export async function promoEvent(c: RouteContext): Promise<Response> {
  // Only this site's own pages: another one must not add to the counts.
  const origin = c.request.headers.get("Origin");
  if (origin !== null && origin !== c.url.origin) {
    throw new ApiError("forbidden", "Cross-origin promo events are not accepted");
  }
  const contentType = c.request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json") {
    throw new ApiError("bad_request", "Expected application/json");
  }
  await rateLimit(c.env, "RL_PROMO", clientIp(c.request));

  const event = parsePromoEvent(await readJsonObject(c.request, MAX_PROMO_EVENT_BYTES));
  if (!event) throw new ApiError("bad_request", "Invalid promo event");

  // Schema shared with the other sites: event, source, promo, placement,
  // language, wording.
  c.env.PROMO_ANALYTICS.writeDataPoint({
    blobs: [event.event, event.source, event.promo, event.placement, event.locale, event.variant],
    doubles: [1],
    indexes: [event.promo],
  });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
