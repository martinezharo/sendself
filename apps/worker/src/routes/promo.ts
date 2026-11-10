import { readPromoEvent, writePromoEvent } from "@martinezharo/promo-funnel/worker";
import { type ApiErrorCode, promoFunnel } from "@sendself/shared";
import { ApiError } from "../errors";
import type { RouteContext } from "../router";
import { clientIp, rateLimit } from "../security";

/** The API's error code for each way the shared checks refuse an event. */
const CODES: Record<number, ApiErrorCode> = { 403: "forbidden", 413: "payload_too_large" };

/**
 * `POST /api/promo-event`: a step of the promo funnel
 * (`packages/shared/src/promo.ts`), counted into the `promo_events` dataset
 * the author's other sites also write. Unauthenticated and anonymous: nothing
 * about the visitor is kept, not even the country. The checks and the schema
 * are shared with the other promoted sites (@martinezharo/promo-funnel).
 */
export async function promoEvent(c: RouteContext): Promise<Response> {
  await rateLimit(c.env, "RL_PROMO", clientIp(c.request));
  const result = await readPromoEvent(c.request, promoFunnel);
  if (!result.ok) throw new ApiError(CODES[result.status] ?? "bad_request", result.message);
  writePromoEvent(c.env.PROMO_ANALYTICS, result.event);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
