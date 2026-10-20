import { describe, expect, it } from "vitest";
import type { LocalMessage } from "../types";
import { chatEntries } from "./grouping";
import { findRanges, fold, matchesText, resolveCurrent, searchEntries, stepMatch } from "./search";

function message(id: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    direction: "in",
    senderDeviceId: "device-a",
    createdAt: 1_000,
    status: "sent",
    ...overrides,
  };
}

function file(name: string): NonNullable<LocalMessage["file"]> {
  return { r2Key: name, iv: "", name, size: 1, mime: "application/pdf" };
}

describe("fold", () => {
  it("ignores case and accents", () => {
    expect(fold("Canción").folded).toBe("cancion");
    expect(fold("ÑANDÚ").folded).toBe("nandu");
  });

  it("matches decomposed input the same as precomposed", () => {
    expect(fold("canción").folded).toBe(fold("canción").folded);
  });
});

describe("matchesText", () => {
  it("finds a substring regardless of case and accents", () => {
    expect(matchesText("Mira esta CANCIÓN", "cancion")).toBe(true);
    expect(matchesText("Mira esta canción", "cancion")).toBe(true);
  });

  it("never matches an empty needle", () => {
    expect(matchesText("anything", "")).toBe(false);
  });
});

describe("findRanges", () => {
  it("returns positions in the original text", () => {
    expect(findRanges("Hello hello", "hello")).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });

  it("maps back through accents so the highlight lands on the right letters", () => {
    const text = "una canción más";
    const [range] = findRanges(text, "cancion");
    expect(text.slice(range![0], range![1])).toBe("canción");
  });

  it("maps back across characters whose folded form changes length", () => {
    const text = "İstanbul y más";
    const [range] = findRanges(text, "mas");
    expect(text.slice(range![0], range![1])).toBe("más");
  });

  it("does not overlap its own matches", () => {
    expect(findRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});

describe("searchEntries", () => {
  it("matches text and file names, oldest first", () => {
    const entries = chatEntries([
      message("a", { text: "invoice attached", createdAt: 1 }),
      message("b", { text: "unrelated", createdAt: 2 }),
      message("c", { file: file("Invoice-2024.pdf"), createdAt: 3 }),
    ]);

    expect(searchEntries(entries, "invoice")).toEqual(["a", "c"]);
  });

  it("counts an album once, whichever of its files matches", () => {
    const entries = chatEntries([
      message("a", { file: file("holiday-1.jpg"), batch: { id: "b", index: 0, count: 2 } }),
      message("b", { file: file("holiday-2.jpg"), batch: { id: "b", index: 1, count: 2 } }),
    ]);

    expect(searchEntries(entries, "holiday")).toEqual(["batch:a"]);
  });

  it("finds an album by its caption", () => {
    const entries = chatEntries([
      message("a", {
        text: "from the trip",
        file: file("1.jpg"),
        batch: { id: "b", index: 0, count: 2 },
      }),
      message("b", { file: file("2.jpg"), batch: { id: "b", index: 1, count: 2 } }),
    ]);

    expect(searchEntries(entries, "trip")).toEqual(["batch:a"]);
  });

  it("never reads a view-once message, sealed or not", () => {
    const entries = chatEntries([
      message("a", { text: "the password is hunter2", viewOnce: true }),
      message("b", { file: file("secret.pdf"), viewOnce: true }),
    ]);

    expect(searchEntries(entries, "hunter2")).toEqual([]);
    expect(searchEntries(entries, "secret")).toEqual([]);
  });

  it("finds nothing for an empty needle", () => {
    expect(searchEntries(chatEntries([message("a", { text: "hi" })]), "")).toEqual([]);
  });
});

describe("navigating matches", () => {
  const matches = ["a", "b", "c"];

  it("starts on the newest match", () => {
    expect(resolveCurrent(matches, null)).toBe("c");
  });

  it("keeps the current match while it is still a hit", () => {
    expect(resolveCurrent(matches, "b")).toBe("b");
  });

  it("falls back to the newest when the current match is gone", () => {
    expect(resolveCurrent(matches, "gone")).toBe("c");
  });

  it("has no current match when nothing matches", () => {
    expect(resolveCurrent([], "a")).toBeNull();
  });

  it("steps toward older and newer, wrapping at both ends", () => {
    expect(stepMatch(matches, null, "older")).toBe("b");
    expect(stepMatch(matches, "a", "older")).toBe("c");
    expect(stepMatch(matches, "c", "newer")).toBe("a");
    expect(stepMatch(matches, "a", "newer")).toBe("b");
  });
});
