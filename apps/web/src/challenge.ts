/**
 * The anti-abuse challenge (Cloudflare Turnstile) a deployment may require
 * before a space is created. The server decides: it hands out a site key when
 * it wants a challenge, and none otherwise, so local development and
 * self-hosted deployments without Turnstile never load a third-party script.
 *
 * The script is loaded only on demand, when a space is actually being created.
 */

import { CREATE_SPACE_CHALLENGE_ACTION } from "@sendself/shared";
import { api } from "./api/client";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  appearance: "always" | "execute" | "interaction-only";
  size: "normal" | "flexible" | "compact";
  theme: "auto" | "light" | "dark";
  callback: (token: string) => void;
  "error-callback": (code: string) => boolean;
  "timeout-callback": () => void;
}

interface Turnstile {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Verification is unavailable"));
    script.onerror = () => {
      // Let the next attempt try again instead of replaying this failure.
      loading = null;
      script.remove();
      reject(new Error("Could not load the verification, check your connection"));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Solve the space-creation challenge inside `container`, or resolve undefined
 * when the server asks for none. Most people never see it: the widget shows
 * itself only when Turnstile needs an interaction.
 */
export async function solveSpaceChallenge(container: HTMLElement): Promise<string | undefined> {
  const { siteKey } = await api.spaceChallenge();
  if (!siteKey) return undefined;
  const turnstile = await loadTurnstile();

  return new Promise<string>((resolve, reject) => {
    // Deferred: removing a widget from inside its own callback is unsupported,
    // and the timeout also guarantees `widgetId` is assigned by then.
    const done = (): void => {
      setTimeout(() => {
        if (widgetId) turnstile.remove(widgetId);
      });
    };
    const widgetId = turnstile.render(container, {
      sitekey: siteKey,
      action: CREATE_SPACE_CHALLENGE_ACTION,
      appearance: "interaction-only",
      size: "flexible",
      theme: "auto",
      callback: (token) => {
        done();
        resolve(token);
      },
      "error-callback": () => {
        done();
        reject(new Error("Verification failed, please try again"));
        return true;
      },
      "timeout-callback": () => {
        done();
        reject(new Error("Verification timed out, please try again"));
      },
    });
  });
}
