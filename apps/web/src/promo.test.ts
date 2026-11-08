import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMO_ATTRIBUTION_TTL_MS,
  type PromoAttribution,
  parsePromoArrival,
  parseStoredAttribution,
  stripPromoParams,
  trackPromoStep,
} from "./promo";

const NOW = 1_800_000_000_000;

function arrival(query: string, pageLang = "en"): PromoAttribution | null {
  return parsePromoArrival(new URL(`https://sendself.4oli.com/${query}`), pageLang, NOW);
}

describe("parsePromoArrival", () => {
  it("reads a full promo link", () => {
    expect(
      arrival(
        "?utm_source=rankmaker&utm_medium=promo&utm_content=end-card&utm_term=short-1&promo_lang=es",
      ),
    ).toEqual({
      promo: "sendself",
      source: "rankmaker",
      placement: "end-card",
      locale: "es",
      variant: "short-1",
      at: NOW,
      sent: [],
    });
  });

  it("falls back to the page's base language and an empty variant", () => {
    const parsed = arrival(
      "?utm_source=backrooms&utm_medium=promo&utm_content=menu&utm_term=Bad_Term&promo_lang=spanish",
      "pt-BR",
    );
    expect(parsed).toMatchObject({ locale: "pt", variant: "" });
  });

  it("ignores links that are not a promo for a known source", () => {
    expect(arrival("?utm_source=rankmaker&utm_medium=email&utm_content=x")).toBeNull();
    expect(arrival("?utm_source=elsewhere&utm_medium=promo&utm_content=x")).toBeNull();
    expect(arrival("?utm_source=rankmaker&utm_medium=promo")).toBeNull();
    expect(arrival("?utm_source=rankmaker&utm_medium=promo&utm_content=-bad")).toBeNull();
    expect(arrival(`?utm_source=rankmaker&utm_medium=promo&utm_content=${"a".repeat(33)}`)).toBe(
      null,
    );
    expect(arrival("")).toBeNull();
  });
});

describe("stripPromoParams", () => {
  it("removes only the promo parameters, keeping the rest and the hash", () => {
    const url = new URL(
      "https://sendself.4oli.com/app?a=1&utm_source=rankmaker&utm_medium=promo&utm_content=x&utm_term=y&promo_lang=es&b=2#faq",
    );
    expect(stripPromoParams(url)).toBe("/app?a=1&b=2#faq");
  });

  it("leaves no dangling question mark", () => {
    const url = new URL("https://sendself.4oli.com/?utm_source=backrooms&utm_medium=promo#how");
    expect(stripPromoParams(url)).toBe("/#how");
  });
});

describe("parseStoredAttribution", () => {
  const stored: PromoAttribution = {
    promo: "sendself",
    source: "backrooms",
    placement: "menu",
    locale: "en",
    variant: "",
    at: NOW,
    sent: ["arrive"],
  };

  it("accepts a well-formed attribution within its seven days", () => {
    expect(parseStoredAttribution(JSON.stringify(stored), NOW + PROMO_ATTRIBUTION_TTL_MS)).toEqual(
      stored,
    );
  });

  it("expires after seven days", () => {
    expect(
      parseStoredAttribution(JSON.stringify(stored), NOW + PROMO_ATTRIBUTION_TTL_MS + 1),
    ).toBeNull();
  });

  it("rejects anything malformed", () => {
    expect(parseStoredAttribution(null, NOW)).toBeNull();
    expect(parseStoredAttribution("{", NOW)).toBeNull();
    expect(parseStoredAttribution(JSON.stringify({ ...stored, promo: "other" }), NOW)).toBeNull();
    expect(parseStoredAttribution(JSON.stringify({ ...stored, sent: "arrive" }), NOW)).toBeNull();
    expect(parseStoredAttribution(JSON.stringify({ ...stored, locale: "EN" }), NOW)).toBeNull();
  });
});

/** A Storage backed by a Map, as the browser's would be. */
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

describe("trackPromoStep", () => {
  let storage: Storage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = memoryStorage();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function attribute(overrides: Partial<PromoAttribution> = {}): void {
    const attribution: PromoAttribution = {
      promo: "sendself",
      source: "rankmaker",
      placement: "end-card",
      locale: "es",
      variant: "short-1",
      at: Date.now(),
      sent: [],
      ...overrides,
    };
    storage.setItem("promo-attribution", JSON.stringify(attribution));
  }

  it("sends a step once per attribution, with the contract's body", () => {
    attribute();
    trackPromoStep("create-space");
    trackPromoStep("create-space");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/promo-event");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(init.body)).toEqual({
      event: "create-space",
      promo: "sendself",
      source: "rankmaker",
      placement: "end-card",
      locale: "es",
      variant: "short-1",
    });
    expect(JSON.parse(storage.getItem("promo-attribution")!).sent).toEqual(["create-space"]);
  });

  it("sends nothing without an attribution", () => {
    trackPromoStep("open-app");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops an expired attribution and sends nothing", () => {
    attribute({ at: Date.now() - PROMO_ATTRIBUTION_TTL_MS - 1 });
    trackPromoStep("open-app");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem("promo-attribution")).toBeNull();
  });

  it("never throws when storage or fetch refuse", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => trackPromoStep("open-app")).not.toThrow();

    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", () => {
      throw new Error("no fetch");
    });
    attribute();
    expect(() => trackPromoStep("open-app")).not.toThrow();
  });
});
