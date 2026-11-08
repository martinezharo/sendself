import type { Env, RateLimit } from "./env";
import { ApiError } from "./errors";

/**
 * Content-Security-Policy and friends. Because this is an end-to-end-encrypted
 * app, an XSS would defeat the entire crypto model, so the policy is strict:
 *  - `script-src 'self'`: no inline JS (JSON-LD data blocks are not executed and
 *    are unaffected; the build is configured to emit no inline scripts). The
 *    one other origin is Turnstile's, loaded only while creating a space when
 *    the deployment asks for a challenge. It is Cloudflare, which already
 *    serves every byte of this app, so it widens no trust (see security.md).
 *  - `style-src` allows inline styles (Tailwind + a couple of inline style attrs).
 *  - `img-src`/`media-src` allow blob:/data: for decrypted previews & QR canvas.
 *  - everything else is locked down to same-origin.
 */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  // Vite inlines Fontsource's smallest woff2 subsets as data: URLs.
  "font-src 'self' data:",
  // Covers the real-time WebSocket too: CSP3 makes 'self' match the ws:/wss:
  // variants of the page's own origin, so this stays as tight as it looks and
  // an XSS still has nowhere to send anything.
  "connect-src 'self'",
  "worker-src 'self'",
  // Turnstile renders its challenge in its own iframe.
  `frame-src ${TURNSTILE_ORIGIN}`,
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

interface SecurityHeaderOptions {
  /** Prevent previews and indexing on non-canonical or error responses. */
  noIndex?: boolean;
}

/** Return a copy of `response` with the security headers applied. */
export function withSecurityHeaders(
  response: Response,
  options: SecurityHeaderOptions = {},
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (options.noIndex || response.status >= 400) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Best-effort client identifier for IP-based rate limiting. */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Enforce a rate limit, throwing `rate_limited` (429) when exceeded. The binding
 * is a no-op in environments where it is not provisioned, so callers stay safe.
 */
export async function enforceRateLimit(limiter: RateLimit | undefined, key: string): Promise<void> {
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new ApiError("rate_limited", "Too many requests, slow down");
  }
}

/** Convenience overload taking the env + binding name. */
export function rateLimit(
  env: Env,
  binding: "RL_PUBLIC" | "RL_WRITE" | "RL_UPLOAD" | "RL_PROMO",
  key: string,
): Promise<void> {
  return enforceRateLimit(env[binding], key);
}
