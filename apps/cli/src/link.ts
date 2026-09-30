/**
 * `sendself link`: join a space as a send-only device.
 *
 * The same pairing the app does, from the joining side: publish fresh public
 * keys to a short-lived slot and wait for a device already in the space to wrap
 * the GroupKey for them. The keys reach that device out-of-band one of two ways:
 *
 *  - with an invitation code from the app (`sendself link <code>`), the usual
 *    way: the answer is sealed with the code's secret, so the app can tell the
 *    keys are the ones whoever holds the code published;
 *  - without one, by showing them as a QR code in the terminal, or as text to
 *    paste into the app.
 *
 * Nothing secret is ever shown or sent in the clear.
 */

import { type Api, NetworkError } from "@sendself/client/api";
import { importGroupKey, unwrapPairingPackage } from "@sendself/client/crypto";
import { createKeyring } from "@sendself/client/keyring";
import {
  type Invite,
  type JoiningDevice,
  createJoiningDevice,
  deviceFingerprint,
} from "@sendself/client/pairing";
import { PAIRING_TTL_MS, type PairingQrPayload } from "@sendself/shared";
import QRCode from "qrcode";
import { type Device, saveDevice } from "./config";
import { apiFor } from "./session";

const POLL_INTERVAL_MS = 2500;

export interface LinkOptions {
  server: string;
  deviceName: string;
  /** The invitation from the app; without one, the keys are shown to scan. */
  invite?: Invite;
  devicePath?: string;
  /** Where the instructions go (stderr, so stdout stays clean for scripts). */
  print: (text: string) => void;
  /** Aborted when the user gives up (Ctrl-C). */
  signal?: AbortSignal;
}

export async function link(options: LinkOptions): Promise<Device> {
  const api = apiFor(options.server);
  const joining = await createJoiningDevice(options.deviceName, {
    sendOnly: true,
    ...(options.invite ? { invite: options.invite } : {}),
  });
  const { pairingId } = joining.payload;
  await api.pairingRequest(pairingId, joining.request);

  if (options.invite) {
    const fingerprint = await deviceFingerprint(
      joining.payload.publicKey,
      joining.payload.signingPublicKey!,
    );
    options.print(
      [
        `Linking "${options.deviceName}" as a send-only device.`,
        `Approve it in the SendSelf app; it shows the code ${fingerprint} for this device.`,
        "Waiting for approval…",
      ].join("\n"),
    );
  } else {
    await showKeys(joining.payload, options);
  }

  return waitForPackage(api, joining, options);
}

async function showKeys(payload: PairingQrPayload, options: LinkOptions): Promise<void> {
  const code = JSON.stringify(payload);
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
}

async function waitForPackage(
  api: Api,
  joining: JoiningDevice,
  options: LinkOptions,
): Promise<Device> {
  const { pairingId } = joining.payload;

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
    throw new Error(
      options.invite
        ? "The invitation expired before it was approved. Create a new one in the app."
        : "The code expired before it was added. Run sendself link again.",
    );
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
