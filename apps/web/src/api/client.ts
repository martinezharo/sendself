/**
 * The PWA's instance of the shared API client (@sendself/client/api): same
 * origin, and a dead session reported to whoever registered for it.
 */

import { type ApiError, createApi } from "@sendself/client/api";

export { ApiError, type Auth, NetworkError, isAuthFailure } from "@sendself/client/api";

type AuthFailureHandler = (error: ApiError) => void;

let authFailureHandler: AuthFailureHandler | null = null;

/**
 * Register what to do when an authenticated request is rejected for good.
 *
 * It stays a callback because this module also runs inside the service worker,
 * which has no UI to send the user back to.
 */
export function setAuthFailureHandler(handler: AuthFailureHandler | null): void {
  authFailureHandler = handler;
}

export const api = createApi({
  baseUrl: "/api",
  onAuthFailure: (error) => authFailureHandler?.(error),
});
