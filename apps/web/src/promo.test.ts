import { promoFunnel } from "@sendself/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPromoTracking, trackPromoStep } from "./promo";

// The funnel's contract and tracker are tested in @martinezharo/promo-funnel;
// these cover SendSelf's own steps and its wiring.

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

function page(href: string, webdriver = false) {
  const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { webdriver });
  vi.stubGlobal("location", { href });
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  vi.stubGlobal("document", {
    documentElement: { lang: "en" },
    visibilityState: "hidden",
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("addEventListener", vi.fn());
  return () =>
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body as string) as Record<string, string>,
    );
}

const ARRIVAL =
  "https://sendself.4oli.com/?utm_source=backrooms&utm_medium=promo&utm_content=pause&utm_term=no-account&promo_lang=es";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("promoFunnel", () => {
  it("counts the visit, then opening the app, a space, a second device and a message", () => {
    expect(promoFunnel.promo).toBe("sendself");
    expect(promoFunnel.steps).toEqual([
      "arrive",
      "stay-10s",
      "stay-1m",
      "stay-3m",
      "open-app",
      "create-space",
      "add-device",
      "send-message",
    ]);
  });
});

describe("the page", () => {
  it("reports the arrival and each step once, as SendSelf", () => {
    const sent = page(ARRIVAL);
    startPromoTracking();
    trackPromoStep("create-space");
    trackPromoStep("create-space");
    const base = {
      promo: "sendself",
      source: "backrooms",
      placement: "pause",
      locale: "es",
      variant: "no-account",
    };
    expect(sent()).toEqual([
      { event: "arrive", ...base },
      { event: "create-space", ...base },
    ]);
  });

  it("sends nothing without an arrival, or from an automated browser", () => {
    const sent = page("https://sendself.4oli.com/app");
    startPromoTracking();
    trackPromoStep("open-app");
    expect(sent()).toEqual([]);

    const automated = page(ARRIVAL, true);
    startPromoTracking();
    expect(automated()).toEqual([]);
  });
});
