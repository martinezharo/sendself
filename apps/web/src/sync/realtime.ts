/**
 * The real-time connection: one WebSocket per device, telling it when to sync.
 *
 * It carries no content. The server pushes `{ type: "sync" }` and the client
 * runs the same authenticated pass polling ran, so nothing about what is
 * delivered — or what the server could learn from it — changes. What changes is
 * that a message arrives in well under a second instead of up to eight, and
 * that an idle device stops waking its radio every 8 s to be told nothing
 * happened.
 *
 * The connection is treated as a hint throughout: `sync/sync.ts` keeps polling
 * on a slow interval while it is up, so a dropped notification, a frozen tab or
 * a proxy that quietly killed the socket costs latency and never a message.
 */

import {
  REALTIME_AUTH_PROTOCOL_PREFIX,
  REALTIME_PATH,
  REALTIME_PING_INTERVAL_MS,
  type RealtimeEvent,
} from "@sendself/shared";
import type { Auth } from "../api/client";

/** Backoff bounds for reconnecting. Jittered, so devices don't retry in step. */
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** A ping unanswered for this long means the socket is dead, close frame or not. */
const PONG_TIMEOUT_MS = 10_000;

type Listener = () => void;

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let wanted = false;
let currentAuth: Auth | null = null;
let onEvent: Listener = () => {};

/** True while a socket is open, which is what lets sync.ts slow its polling. */
export function realtimeConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

function clearTimers(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

function scheduleRetry(): void {
  if (!wanted || retryTimer) return;
  // Exponential with full jitter: a Worker deploy disconnects every device in a
  // space at once, and retrying in lockstep would just reproduce the stampede.
  const ceiling = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** attempt);
  attempt += 1;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      open();
    },
    MIN_RETRY_MS + Math.random() * (ceiling - MIN_RETRY_MS),
  );
}

function teardown(): void {
  clearTimers();
  const dying = socket;
  socket = null;
  if (dying) {
    dying.onopen = null;
    dying.onmessage = null;
    dying.onclose = null;
    dying.onerror = null;
    try {
      dying.close();
    } catch {
      // Already closing; nothing to do.
    }
  }
}

function heartbeat(): void {
  clearTimers();
  pingTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send("ping");
    // A phone that loses its network often gets no close frame at all: the
    // socket just stops delivering. The unanswered ping is how we find out.
    if (!pongTimer) {
      pongTimer = setTimeout(() => {
        teardown();
        scheduleRetry();
      }, PONG_TIMEOUT_MS);
    }
  }, REALTIME_PING_INTERVAL_MS);
}

function open(): void {
  if (!wanted || !currentAuth || socket) return;
  const url = new URL(REALTIME_PATH, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let next: WebSocket;
  try {
    // The token rides in the subprotocol: the browser API cannot set headers,
    // and a query parameter would put the credential in access logs.
    next = new WebSocket(url, [`${REALTIME_AUTH_PROTOCOL_PREFIX}${currentAuth.token}`]);
  } catch {
    scheduleRetry();
    return;
  }
  socket = next;

  next.onopen = () => {
    attempt = 0;
    heartbeat();
    // Anything that happened while this device was disconnected is waiting in
    // the same place a notification would have pointed it to.
    onEvent();
  };

  next.onmessage = (message: MessageEvent) => {
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
    if (message.data === "pong") return;
    try {
      const event = JSON.parse(String(message.data)) as RealtimeEvent;
      if (event.type === "sync") onEvent();
    } catch {
      // An unparseable frame is a server we don't understand, not a reason to
      // drop a connection that is otherwise delivering.
    }
  };

  next.onclose = () => {
    if (socket !== next) return;
    teardown();
    scheduleRetry();
  };

  next.onerror = () => {
    if (socket !== next) return;
    teardown();
    scheduleRetry();
  };
}

/**
 * Start (or restart) the connection. Safe to call repeatedly: reconnecting is
 * driven from here, so a `focus`/`online` event can simply ask again.
 */
export function startRealtime(auth: Auth, listener: Listener): void {
  currentAuth = auth;
  onEvent = listener;
  wanted = true;
  if (!socket) open();
}

export function stopRealtime(): void {
  wanted = false;
  currentAuth = null;
  attempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  teardown();
}

/**
 * Reconnect immediately if the socket is gone. Called when the app regains
 * focus or the network comes back — both are moments where the browser has
 * usually killed a backgrounded socket without telling us.
 */
export function ensureRealtime(): void {
  if (!wanted || socket) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  attempt = 0;
  open();
}
