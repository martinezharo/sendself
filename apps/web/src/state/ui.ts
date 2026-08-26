import { computed, signal } from "@preact/signals";
import { realtimeState } from "../sync/realtime";

/** Whether the browser believes it has a network at all. */
export const online = signal(typeof navigator === "undefined" ? true : navigator.onLine);

export type ConnectionState = "connected" | "connecting" | "offline";

/**
 * What the app can honestly claim about its link to the other devices.
 *
 * `navigator.onLine` alone only ever rules connectivity *out*: it is true on a
 * captive-portal Wi-Fi and on a laptop whose server is down. So "connected" is
 * reserved for the one thing that proves the round trip — an open realtime
 * socket — and everything between the two is "connecting", which is what a
 * device falling back to the polling loop is actually doing.
 */
export const connection = computed<ConnectionState>(() => {
  if (!online.value) return "offline";
  return realtimeState.value === "open" ? "connected" : "connecting";
});

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export const toasts = signal<Toast[]>([]);

let toastId = 0;

export function showToast(message: string, kind: Toast["kind"] = "info"): void {
  const toast: Toast = { id: ++toastId, message, kind };
  toasts.value = [...toasts.value, toast];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== toast.id);
  }, 4000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => (online.value = true));
  window.addEventListener("offline", () => (online.value = false));
}
