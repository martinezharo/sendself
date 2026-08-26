import { describe, expect, it } from "vitest";
import { PRE_REBRAND_ID } from "./legacy";
import {
  BadRecoveryFileError,
  generateRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryFile,
} from "./recovery";

describe("generateRecoveryCode", () => {
  it("is 32 characters in groups of four", () => {
    const code = generateRecoveryCode();

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(code.replace(/-/g, "")).toHaveLength(32);
  });

  it("never uses the characters people confuse when copying by hand", () => {
    const codes = Array.from({ length: 200 }, generateRecoveryCode).join("");

    expect(codes).not.toMatch(/[ILOU]/);
  });

  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));

    expect(codes.size).toBe(200);
  });
});

describe("normalizeRecoveryCode", () => {
  it("accepts a code back in whatever shape it was written down", () => {
    const code = "ABCD-2345-6789-WXYZ";

    expect(normalizeRecoveryCode("abcd 2345 6789 wxyz")).toBe(normalizeRecoveryCode(code));
    expect(normalizeRecoveryCode("ABCD2345 6789WXYZ")).toBe(normalizeRecoveryCode(code));
    expect(normalizeRecoveryCode("  abcd-2345-6789-wxyz  ")).toBe(normalizeRecoveryCode(code));
  });

  it("forgives the substitutions the alphabet was chosen to avoid", () => {
    // The generator never emits I, L, O or U, so a code containing one is
    // certainly a transcription slip — and mapping it back beats a failure the
    // user has no way to diagnose.
    expect(normalizeRecoveryCode("O1IL")).toBe("0111");
    expect(normalizeRecoveryCode("U")).toBe("V");
  });

  it("is idempotent", () => {
    const once = normalizeRecoveryCode("abcd-2345-o789-wxyz");

    expect(normalizeRecoveryCode(once)).toBe(once);
  });
});

describe("parseRecoveryFile", () => {
  const base = {
    kind: "sendself-recovery",
    v: 1,
    createdAt: 1_700_000_000_000,
    keyEpoch: 1,
    salt: "salt",
    iterations: 600_000,
    sealed: { iv: "iv", ct: "ciphertext" },
  };

  it("rejects an iteration count that could turn restore into a CPU DoS", () => {
    expect(() =>
      parseRecoveryFile(JSON.stringify({ ...base, iterations: Number.MAX_SAFE_INTEGER })),
    ).toThrow(BadRecoveryFileError);
  });

  it("accepts a structurally valid file", () => {
    expect(parseRecoveryFile(JSON.stringify(base))).toMatchObject(base);
  });

  it("accepts recovery files written before the SendSelf rebrand", () => {
    const legacy = { ...base, kind: `${PRE_REBRAND_ID}-recovery` };

    expect(parseRecoveryFile(JSON.stringify(legacy))).toMatchObject(legacy);
  });
});
