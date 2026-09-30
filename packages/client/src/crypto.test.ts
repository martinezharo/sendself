import { INITIAL_KEY_EPOCH, type PairingPayload } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import {
  base64UrlToBuf,
  bufToBase64Url,
  decryptFile,
  decryptName,
  decryptText,
  encryptFile,
  encryptName,
  encryptText,
  exportGroupKey,
  exportPublicKey,
  generateDeviceKeyPair,
  generateGroupKey,
  importGroupKey,
  importPublicKey,
  randomId,
  randomToken,
  sha256Hex,
  unwrapPairingPackage,
  wrapPairingPackage,
} from "./crypto";

describe("encoding", () => {
  it("round-trips base64url for arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 63, 64, 65]);
    const encoded = bufToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(new Uint8Array(base64UrlToBuf(encoded))).toEqual(bytes);
  });

  it("computes the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("generates distinct high-entropy tokens/ids", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomId()).not.toBe(randomId());
  });
});

describe("text encryption with the GroupKey", () => {
  it("round-trips unicode text with a unique IV each time", async () => {
    const key = await generateGroupKey();
    const a = await encryptText(key, "héllo 🌍 world");
    const b = await encryptText(key, "héllo 🌍 world");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptText(key, a.ciphertext, a.iv)).toBe("héllo 🌍 world");
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = await generateGroupKey();
    const { ciphertext, iv } = await encryptText(key, "secret");
    const tampered = bufToBase64Url(
      new Uint8Array(base64UrlToBuf(ciphertext)).map((b, i) => (i === 0 ? b ^ 0xff : b)),
    );
    await expect(decryptText(key, tampered, iv)).rejects.toThrow();
  });

  it("fails to decrypt with a different GroupKey", async () => {
    const k1 = await generateGroupKey();
    const k2 = await generateGroupKey();
    const { ciphertext, iv } = await encryptText(k1, "secret");
    await expect(decryptText(k2, ciphertext, iv)).rejects.toThrow();
  });
});

describe("file encryption", () => {
  it("round-trips a binary buffer", async () => {
    const key = await generateGroupKey();
    const original = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const { ciphertext, iv } = await encryptFile(key, original.buffer);
    const decrypted = new Uint8Array(await decryptFile(key, ciphertext, iv));
    expect(decrypted).toEqual(original);
  });
});

describe("AES-GCM additional authenticated data (AAD)", () => {
  it("round-trips when the same context is supplied", async () => {
    const key = await generateGroupKey();
    const { ciphertext, iv } = await encryptText(key, "secret", "text:abc");
    expect(await decryptText(key, ciphertext, iv, "text:abc")).toBe("secret");
  });

  it("fails to decrypt when the context differs (no cross-message reuse)", async () => {
    const key = await generateGroupKey();
    const { ciphertext, iv } = await encryptText(key, "secret", "text:abc");
    await expect(decryptText(key, ciphertext, iv, "text:xyz")).rejects.toThrow();
    await expect(decryptText(key, ciphertext, iv)).rejects.toThrow();
  });

  it("binds an encrypted device name to its device id", async () => {
    const key = await generateGroupKey();
    const { ciphertext, iv } = await encryptName(key, "My laptop", "device-1");
    expect(await decryptName(key, ciphertext, iv, "device-1")).toBe("My laptop");
    await expect(decryptName(key, ciphertext, iv, "device-2")).rejects.toThrow();
  });
});

describe("GroupKey export/import", () => {
  it("preserves the key across raw export/import", async () => {
    const key = await generateGroupKey();
    const reimported = await importGroupKey(await exportGroupKey(key));
    const { ciphertext, iv } = await encryptText(key, "shared");
    expect(await decryptText(reimported, ciphertext, iv)).toBe("shared");
  });
});

describe("ECIES pairing wrap/unwrap", () => {
  it("lets the joining device recover the pairing payload", async () => {
    const device2 = await generateDeviceKeyPair();
    const groupKey = await generateGroupKey();

    const payload: PairingPayload = {
      groupKey: await exportGroupKey(groupKey),
      keyEpoch: INITIAL_KEY_EPOCH,
      deviceAuthToken: randomToken(),
      groupId: randomId(),
    };

    // Device 1 wraps using only device 2's exported public key.
    const recipientPublic = await importPublicKey(await exportPublicKey(device2.publicKey));
    const wrapped = await wrapPairingPackage(recipientPublic, payload);

    // Device 2 unwraps with its private key.
    const recovered = await unwrapPairingPackage(
      device2.privateKey,
      wrapped.ephemeralPublicKey,
      wrapped.wrappedPackage,
    );
    expect(recovered).toEqual(payload);

    // The recovered GroupKey actually decrypts a message from device 1.
    const recoveredKey = await importGroupKey(recovered.groupKey);
    const msg = await encryptText(groupKey, "linked!");
    expect(await decryptText(recoveredKey, msg.ciphertext, msg.iv)).toBe("linked!");
  });

  it("cannot be unwrapped by the wrong device", async () => {
    const device2 = await generateDeviceKeyPair();
    const attacker = await generateDeviceKeyPair();
    const groupKey = await generateGroupKey();
    const payload: PairingPayload = {
      groupKey: await exportGroupKey(groupKey),
      keyEpoch: INITIAL_KEY_EPOCH,
      deviceAuthToken: randomToken(),
      groupId: randomId(),
    };
    const wrapped = await wrapPairingPackage(device2.publicKey, payload);
    await expect(
      unwrapPairingPackage(attacker.privateKey, wrapped.ephemeralPublicKey, wrapped.wrappedPackage),
    ).rejects.toThrow();
  });
});
