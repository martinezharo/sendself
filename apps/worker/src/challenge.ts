import { CREATE_SPACE_CHALLENGE_ACTION } from "@sendself/shared";
import type { Env } from "./env";
import { ApiError } from "./errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Turnstile tokens are at most 2048 characters; anything longer is not one. */
const MAX_TOKEN_LENGTH = 2048;

/**
 * The site key clients must solve a challenge for before creating a space, or
 * null when this deployment does not ask for one. Both halves are required: a
 * site key without its secret could not be verified, and a secret without a
 * site key would refuse every client.
 */
export function spaceChallengeSiteKey(env: Env): string | null {
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
}

interface SiteverifyResponse {
  success: boolean;
  action?: string;
  "error-codes"?: string[];
}

/**
 * Prove a space is being created by a person, not a script. Creating a space is
 * the one write that needs no prior trust, so it is where an abuser would mint
 * the identities every other limit is keyed on.
 *
 * Fails closed: if Siteverify cannot be reached, nobody creates a space until
 * it can. A no-op when the deployment has no challenge configured.
 */
export async function verifySpaceChallenge(
  env: Env,
  token: unknown,
  remoteIp: string | null,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!spaceChallengeSiteKey(env)) return;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new ApiError("challenge_failed", "Complete the verification to create a space");
  }

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY as string);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  let outcome: SiteverifyResponse;
  try {
    const response = await fetcher(SITEVERIFY_URL, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Siteverify answered ${response.status}`);
    outcome = (await response.json()) as SiteverifyResponse;
  } catch (error) {
    console.error("Turnstile verification unavailable:", error);
    throw new ApiError("internal", "Could not verify the challenge, try again");
  }

  // The action check binds the token to this one purpose: a token solved for
  // anything else on the same site key cannot be spent here.
  if (!outcome.success || outcome.action !== CREATE_SPACE_CHALLENGE_ACTION) {
    throw new ApiError("challenge_failed", "Verification failed, please try again");
  }
}
