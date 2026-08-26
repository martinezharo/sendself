import { registerSW } from "virtual:pwa-register";
import { render } from "preact";
import { bootstrap } from "./bootstrap";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";
import { redirectInstalledAppFromLanding } from "./pwa";
import { ready, startupError } from "./state/session";
import { App } from "./ui/App";

/**
 * Register the service worker with `autoUpdate`: a new deploy is detected,
 * activated (skipWaiting + clientsClaim) and the page auto-reloads — no manual
 * cache clearing. We also re-check on an interval and whenever the app regains
 * focus so an already-open tab picks up a new version on its own.
 */
function registerServiceWorker(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const update = (): void => void registration.update();
      setInterval(update, 60_000);
      window.addEventListener("focus", update);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") update();
      });
    },
  });
}

registerServiceWorker();
redirectInstalledAppFromLanding();

const root = document.getElementById("app");
if (root) {
  // Replace the prerendered landing page before reading IndexedDB. The app's
  // loading state prevents a returning session from briefly seeing marketing
  // content, while the prerender remains available to crawlers and no-JS
  // clients.
  render(<App />, root);
  void bootstrap().catch((error: unknown) => {
    console.error("Could not start SendSelf", error);
    startupError.value = error instanceof Error ? error.message : "Could not start SendSelf";
    ready.value = true;
  });
}
