/**
 * `sendself link`: join a space as a send-only device.
 *
 * The same pairing the app does, from the joining side: publish fresh public
 * keys to a short-lived slot, show them out-of-band (a QR code in the terminal,
 * or text to paste), and wait for a device already in the space to wrap the
 * GroupKey for them. Nothing secret is ever shown or sent in the clear.
 */

import { NetworkError } from "@sendself/client/api";
import { importGroupKey, unwrapPairingPackage } from "@sendself/client/crypto";
import { createKeyring } from "@sendself/client/keyring";
import { createJoiningDevice } from "@sendself/client/pairing";
import { PAIRING_TTL_MS } from "@sendself/shared";
import QRCode from "qrcode";
import { type Device, saveDevice } from "./config";
import { apiFor } from "./session";

const POLL_INTERVAL_MS = 2500;

export interface LinkOptions {
  server: string;
  deviceName: string;
  devicePath?: string;
  /** Where the instructions go (stderr, so stdout stays clean for scripts). */
  print: (text: string) => void;
  /** Aborted when the user gives up (Ctrl-C). */
  signal?: AbortSignal;
}

export async function link(options: LinkOptions): Promise<Device> {
  const api = apiFor(options.server);
  const joining = await createJoiningDevice(options.deviceName, { sendOnly: true });
  const { pairingId } = joining.payload;
  await api.pairingRequest(pairingId, joining.request);

  const code = JSON.stringify(joining.payload);
  const qr = await QRCode.toString(code, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "L",
  });
  options.print(
    [
      "",
      `Linking "${options.deviceName}" as a send-only device.`,
      "",
      "On a device that is already in the space (as its owner or an admin), open",
      "Devices → Add device, then scan this code:",
      "",
      qr,
      "or choose “Paste code” and paste this text:",
      "",
      code,
      "",
      `Waiting for it to be added (the code expires in ${PAIRING_TTL_MS / 60_000} minutes)…`,
    ].join("\n"),
  );

  const deadline = Date.now() + PAIRING_TTL_MS;
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      let result: Awaited<ReturnType<typeof api.pairingPoll>>;
      try {
        result = await api.pairingPoll(pairingId);
      } catch (error) {
        // A blip on the network is no reason to give up a pairing that is
        // still valid; the next poll gets another chance.
        if (!(error instanceof NetworkError)) throw error;
        await wait(POLL_INTERVAL_MS, options.signal);
        continue;
      }
      if (result.ready && result.wrappedPackage && result.ephemeralPublicKey) {
        const recovered = await unwrapPairingPackage(
          joining.keyPair.privateKey,
          result.ephemeralPublicKey,
          result.wrappedPackage,
          pairingId,
        );
        const device: Device = {
          server: options.server,
          groupId: recovered.groupId,
          deviceId: joining.payload.deviceId,
          deviceName: options.deviceName,
          ...(recovered.spaceName ? { spaceName: recovered.spaceName } : {}),
          token: recovered.deviceAuthToken,
          keyPair: joining.keyPair,
          signingKeyPair: joining.signingKeyPair,
          // The space may have rotated its key long before this device existed.
          keyring: createKeyring(await importGroupKey(recovered.groupKey), recovered.keyEpoch),
        };
        await saveDevice(device, options.devicePath);
        return device;
      }
      await wait(POLL_INTERVAL_MS, options.signal);
    }
    throw new Error("The code expired before it was added. Run sendself link again.");
  } finally {
    // Best-effort: once linked (or given up on), the slot has nothing left to
    // offer, and the cleanup job would reap it anyway.
    await api.pairingDelete(pairingId).catch(() => {});
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
