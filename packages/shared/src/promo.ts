/**
 * The promo funnel: what a visitor who arrived from a promo for SendSelf on
 * one of the author's other sites (RANKMAKER, Backrooms) went on to do here.
 *
 * The contract, the page tracker (apps/web/src/promo.ts) and the Worker's
 * checks (apps/worker/src/routes/promo.ts) are shared with the other promoted
 * sites (@martinezharo/promo-funnel); this names SendSelf's own steps.
 * Nothing identifies the visitor: an event names the step, where the promo
 * was shown and in which language, never who followed it.
 */
import { definePromoFunnel } from "@martinezharo/promo-funnel";

export const promoFunnel = definePromoFunnel("sendself", [
  "open-app",
  "create-space",
  "add-device",
  "send-message",
]);

export type PromoEventName = (typeof promoFunnel.steps)[number];
