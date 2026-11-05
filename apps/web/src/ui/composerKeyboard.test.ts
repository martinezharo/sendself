import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldSendOnEnter } from "./composerKeyboard";

afterEach(() => vi.unstubAllGlobals());

function keyboard(coarse: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" && coarse }),
  });
}

function enter(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  } as KeyboardEvent;
}

describe("composer Enter behavior", () => {
  it("leaves Enter available for newlines on mobile", () => {
    keyboard(true);
    expect(shouldSendOnEnter(enter())).toBe(false);
  });

  it("preserves desktop Enter to send and Shift+Enter for newlines", () => {
    keyboard(false);
    expect(shouldSendOnEnter(enter())).toBe(true);
    expect(shouldSendOnEnter(enter({ shiftKey: true }))).toBe(false);
    expect(shouldSendOnEnter(enter({ key: "a" }))).toBe(false);
  });

  it("does not send while confirming composed text, including Safari's legacy signal", () => {
    keyboard(false);
    expect(shouldSendOnEnter(enter({ isComposing: true }))).toBe(false);
    expect(shouldSendOnEnter(enter({ keyCode: 229 }))).toBe(false);
  });
});
