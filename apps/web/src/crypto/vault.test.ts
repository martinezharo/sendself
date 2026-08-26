import { describe, expect, it } from "vitest";
import { PRE_REBRAND_ID } from "../legacy";
import { exportGroupKey, generateGroupKey, importGroupKey } from "./crypto";
import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  type VaultSecrets,
  keysFromPassphrase,
  keysFromSecret,
  newSalt,
  open,
  openVault,
  seal,
  sealVault,
} from "./vault";

/** Real PBKDF2 rounds make each derivation ~1 s; tests only need the shape. */
const ROUNDS = 1_000;

async function secrets(): Promise<VaultSecrets> {
  const key = await generateGroupKey();
  return {
    spaces: [
      {
        spaceId: "space-1",
        session: {
          groupId: "group-1",
          deviceId: "device-1",
          deviceName: "Laptop",
          deviceAuthToken: "super-secret-token",
        },
        keyring: { current: 2, keys: [[2, await exportGroupKey(key)]] },
        deviceKeyPair: { publicKey: "spki", privateKey: "pkcs8" },
        signingKeyPair: null,
      },
    ],
    contentKey: "raw-content-key",
  };
}

describe("keysFromPassphrase", () => {
  it("is deterministic for the same passphrase, salt and rounds", async () => {
    const salt = newSalt();
    const a = await keysFromPassphrase("open sesame", salt, ROUNDS);
    const b = await keysFromPassphrase("open sesame", salt, ROUNDS);

    const blob = await seal(a.vaultKey, { hello: "world" }, "ctx");
    expect(await open(b.vaultKey, blob, "ctx")).toEqual({ hello: "world" });
  });

  it("rejects an unsafe iteration count before deriving", async () => {
    await expect(keysFromPassphrase("pw", newSalt(), MAX_PBKDF2_ITERATIONS + 1)).rejects.toThrow(
      "Invalid PBKDF2 iteration count",
    );
  });

  it("produces a different key for a different salt", async () => {
    const a = await keysFromPassphrase("open sesame", newSalt(), ROUNDS);
    const b = await keysFromPassphrase("open sesame", newSalt(), ROUNDS);

    const blob = await seal(a.vaultKey, { hello: "world" }, "ctx");
    await expect(open(b.vaultKey, blob, "ctx")).rejects.toThrow();
  });

  it("gives the vault key and the content key different values", async () => {
    // The store layer only ever receives the content key, so a bug there must
    // not be able to open the credentials.
    const salt = newSalt();
    const { vaultKey, contentKey } = await keysFromPassphrase("secret", salt, ROUNDS);

    const blob = await seal(vaultKey, { a: 1 }, "ctx");
    await expect(open(contentKey, blob, "ctx")).rejects.toThrow();
  });

  it("derives the same pair from a passkey's PRF bytes", async () => {
    const salt = newSalt();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const a = await keysFromSecret(prf.buffer as ArrayBuffer, salt);
    const b = await keysFromSecret(prf.buffer as ArrayBuffer, salt);

    const blob = await seal(a.contentKey, { n: 7 }, "ctx");
    expect(await open(b.contentKey, blob, "ctx")).toEqual({ n: 7 });
  });
});

describe("newSalt", () => {
  it("never repeats", () => {
    const salts = new Set(Array.from({ length: 64 }, () => newSalt()));
    expect(salts.size).toBe(64);
  });
});

describe("seal / open", () => {
  it("round-trips a value", async () => {
    const { vaultKey } = await keysFromPassphrase("pw", newSalt(), ROUNDS);

    const blob = await seal(vaultKey, { list: [1, 2, 3] }, "ctx");

    expect(blob.ct).not.toContain("1,2,3");
    expect(await open(vaultKey, blob, "ctx")).toEqual({ list: [1, 2, 3] });
  });

  it("refuses a blob opened under a different context", async () => {
    // AAD is what stops a recovery file from being replayed as an at-rest
    // vault, and vice versa.
    const { vaultKey } = await keysFromPassphrase("pw", newSalt(), ROUNDS);
    const blob = await seal(vaultKey, { a: 1 }, "sendself-vault:1");

    await expect(open(vaultKey, blob, "sendself-recovery:1")).rejects.toThrow();
  });

  it("uses a fresh IV per call", async () => {
    const { vaultKey } = await keysFromPassphrase("pw", newSalt(), ROUNDS);

    const a = await seal(vaultKey, { same: true }, "ctx");
    const b = await seal(vaultKey, { same: true }, "ctx");

    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("sealVault / openVault", () => {
  it("round-trips the secrets and restores usable GroupKeys", async () => {
    const salt = newSalt();
    const { vaultKey } = await keysFromPassphrase("passphrase", salt, ROUNDS);
    const original = await secrets();

    const envelope = await sealVault(vaultKey, original, {
      v: 2,
      method: "passphrase",
      salt,
      iterations: ROUNDS,
    });
    const opened = await openVault(vaultKey, envelope);

    expect(opened).toEqual(original);
    // The point of storing raw bytes: they have to come back as a working key.
    const restored = await importGroupKey((opened as VaultSecrets).spaces[0]!.keyring.keys[0]![1]);
    expect(restored.type).toBe("secret");
  });

  it("opens vaults written before the SendSelf rebrand", async () => {
    const salt = newSalt();
    const { vaultKey } = await keysFromPassphrase("passphrase", salt, ROUNDS);
    const original = await secrets();
    const envelope = {
      v: 2 as const,
      method: "passphrase" as const,
      salt,
      iterations: ROUNDS,
      sealed: await seal(vaultKey, original, `${PRE_REBRAND_ID}-vault:1`),
    };

    await expect(openVault(vaultKey, envelope)).resolves.toEqual(original);
  });

  it("leaves nothing readable in the envelope", async () => {
    const salt = newSalt();
    const { vaultKey } = await keysFromPassphrase("passphrase", salt, ROUNDS);

    const envelope = await sealVault(vaultKey, await secrets(), {
      v: 2,
      method: "passphrase",
      salt,
      iterations: ROUNDS,
    });

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("device-1");
    expect(serialized).not.toContain("Laptop");
  });

  it("fails to open with the wrong passphrase, and says nothing more", async () => {
    const salt = newSalt();
    const right = await keysFromPassphrase("correct horse", salt, ROUNDS);
    const wrong = await keysFromPassphrase("correct horsf", salt, ROUNDS);

    const envelope = await sealVault(right.vaultKey, await secrets(), {
      v: 2,
      method: "passphrase",
      salt,
      iterations: ROUNDS,
    });

    await expect(openVault(wrong.vaultKey, envelope)).rejects.toThrow();
  });

  it("keeps the iteration count it was sealed with, so raising the default is safe", async () => {
    const salt = newSalt();
    const { vaultKey } = await keysFromPassphrase("pw", salt, ROUNDS);
    const envelope = await sealVault(vaultKey, await secrets(), {
      v: 2,
      method: "passphrase",
      salt,
      iterations: ROUNDS,
    });

    // An unlock re-derives from the envelope's own parameters, never the
    // current constant — otherwise every existing device would be locked out
    // the day the default changes.
    const reopened = await keysFromPassphrase("pw", envelope.salt, envelope.iterations);
    await expect(openVault(reopened.vaultKey, envelope)).resolves.toBeTruthy();
  });
});

describe("MIN_PASSPHRASE_LENGTH", () => {
  it("still admits a 6-digit PIN", () => {
    expect("123456".length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
  });
});
