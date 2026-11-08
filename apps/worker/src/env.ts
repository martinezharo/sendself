/** Cloudflare Rate Limiting binding (the `ratelimit` unsafe binding). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** D1 database holding groups, devices, message metadata and delivery status. */
  DB: D1Database;
  /** R2 bucket holding encrypted file blobs. */
  FILES: R2Bucket;
  /**
   * R2 bucket holding the vault's encrypted notes and files. A bucket of its
   * own because FILES carries a lifecycle rule that expires everything after a
   * day, which is exactly what vault content must never be subject to.
   */
  VAULT: R2Bucket;
  /** Static assets binding serving the built PWA. */
  ASSETS: Fetcher;
  /** One Durable Object per space, fanning delivery notifications out to its devices. */
  SPACE_HUB: DurableObjectNamespace;
  /** Rate limit for unauthenticated endpoints (keyed by client IP). */
  RL_PUBLIC: RateLimit;
  /** Rate limit for authenticated writes (keyed by device id). */
  RL_WRITE: RateLimit;
  /** Rate limit for file uploads (keyed by device id). */
  RL_UPLOAD: RateLimit;
  /**
   * Rate limit for promo funnel events (keyed by client IP). Its own, so a
   * visitor's events never eat into the public limit pairing polls against.
   */
  RL_PROMO: RateLimit;
  /**
   * The `promo_events` dataset shared with the author's other sites, counting
   * what visitors who followed a promo for SendSelf went on to do here.
   */
  PROMO_ANALYTICS: AnalyticsEngineDataset;
  /**
   * Web Push (VAPID) identity: an uncompressed P-256 public key and its private
   * scalar, both base64url (`scripts/generate-vapid-keys.mts`). Secrets, so
   * optional: without them the server sends no pushes and the app offers none.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Contact the push services may use (mailto: or https:). Defaults to the site. */
  VAPID_SUBJECT?: string;
  /**
   * Turnstile widget keys guarding space creation (see `challenge.ts`). Both
   * secrets, so optional: without them anyone can create a space unchallenged,
   * which is what local development and the tests do.
   */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}
