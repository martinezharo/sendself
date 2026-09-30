/**
 * `sendself send`: encrypt, sign and deliver text and files, exactly as the
 * app's outbox does. The server only ever receives ciphertext.
 */

import { readFile } from "node:fs/promises";
import { type Api, ApiError } from "@sendself/client/api";
import { randomId, signStatement } from "@sendself/client/crypto";
import { currentKey } from "@sendself/client/keyring";
import {
  encryptMessageFile,
  encryptMessageMeta,
  encryptMessageText,
} from "@sendself/client/message";
import {
  MAX_FILE_SIZE,
  type MessageMeta,
  type SendMessageRequest,
  messageSignatureStatement,
} from "@sendself/shared";
import type { Device } from "./config";
import { explainAuthFailure, syncKeys } from "./session";

export interface OutgoingFile {
  /** Where to read it from. */
  path: string;
  /** The name the receiving devices show and save it under. */
  name: string;
  size: number;
  mime: string;
}

export interface SendRequest {
  /** Text on its own, or the caption of the files. */
  text?: string;
  files: readonly OutgoingFile[];
  /** Removed from every device once one of them opens it. */
  viewOnce?: boolean;
}

/** One message on the wire, before encryption. */
export interface PlannedMessage {
  id: string;
  text?: string;
  file?: OutgoingFile & { r2Key: string };
  meta?: MessageMeta;
}

/**
 * The server stores at most this much ciphertext for a text message. Longer
 * text has to go as a file.
 */
const MAX_TEXT_CIPHERTEXT = 1_000_000;

/** How long to wait for a rate limit to lift, and how often to try. */
const RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_ATTEMPTS = 5;

/**
 * Turn a request into messages, the way the app's composer does: text alone
 * is one message; files are one message each, the caption rides on the first,
 * and several files share a batch id so the chat draws them as one album.
 */
export function planMessages(request: SendRequest): PlannedMessage[] {
  const text = request.text?.length ? request.text : undefined;
  const viewOnce = request.viewOnce ? { viewOnce: true as const } : {};

  if (request.files.length === 0) {
    if (!text) throw new Error("Nothing to send");
    return [{ id: randomId(), text, ...(request.viewOnce ? { meta: viewOnce } : {}) }];
  }

  const batchId = request.files.length > 1 ? randomId() : undefined;
  return request.files.map((file, index) => ({
    id: randomId(),
    ...(index === 0 && text ? { text } : {}),
    file: { ...file, r2Key: randomId() },
    meta: {
      name: file.name,
      size: file.size,
      mime: file.mime,
      ...(batchId ? { batchId, batchIndex: index, batchCount: request.files.length } : {}),
      ...viewOnce,
    },
  }));
}

export interface SendOptions {
  /** Called once per message as it lands. */
  onSent?: (message: PlannedMessage) => void;
  /** Overridable so tests do not have to wait out a rate limit. */
  sleep?: (ms: number) => Promise<void>;
  devicePath?: string;
}

/**
 * Send everything in `request`. Messages go one after another, like the app's
 * outbox: each file is its own delivery, so an interrupted run leaves whole
 * files behind rather than half an album of broken ones.
 */
export async function sendAll(
  device: Device,
  api: Api,
  request: SendRequest,
  options: SendOptions = {},
): Promise<void> {
  for (const file of request.files) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`${file.name} is larger than the ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
    }
  }
  const messages = planMessages(request);

  let current = (await syncKeys(device, api, options.devicePath)).device;
  for (const message of messages) {
    current = await sendOne(current, api, message, options);
    options.onSent?.(message);
  }
}

/**
 * Send one message, catching up with a key rotation if the server reports one
 * mid-send: it refuses content under a superseded key precisely so a device
 * that was just revoked never gets to read it.
 */
async function sendOne(
  device: Device,
  api: Api,
  message: PlannedMessage,
  options: SendOptions,
): Promise<Device> {
  let current = device;
  const data = message.file ? toArrayBuffer(await readFile(message.file.path)) : undefined;

  for (let attempt = 0; ; attempt++) {
    try {
      await withRateLimitRetries(() => deliver(current, api, message, data), options.sleep);
      return current;
    } catch (error) {
      if (error instanceof ApiError && error.code === "key_rotated" && attempt === 0) {
        current = (await syncKeys(current, api, options.devicePath)).device;
        continue;
      }
      if (error instanceof ApiError && error.code === "key_rotated") {
        throw new Error(
          "The space's key changed and this device has not received the new one yet. Open SendSelf on one of your devices so it can finish the rotation, then try again.",
        );
      }
      throw explainAuthFailure(error);
    }
  }
}

async function deliver(
  device: Device,
  api: Api,
  message: PlannedMessage,
  data: ArrayBuffer | undefined,
): Promise<void> {
  const auth = { token: device.token };
  const keyEpoch = device.keyring.current;
  const key = currentKey(device.keyring);

  const payload: Omit<SendMessageRequest, "id" | "keyEpoch" | "signature"> = {};
  if (message.file && data) {
    const encrypted = await encryptMessageFile(key, message.id, data);
    // The same object key on every attempt: a retry after a rotation replaces
    // the blob instead of stranding the first one until the cleanup.
    await api.uploadFile(message.file.r2Key, encrypted.ciphertext, auth);
    payload.fileR2Key = message.file.r2Key;
    payload.fileIv = encrypted.iv;
  }
  if (message.text !== undefined) {
    const text = await encryptMessageText(key, message.id, message.text);
    if (text.ciphertext.length > MAX_TEXT_CIPHERTEXT) {
      throw new Error("That text is too long for a message. Send it as a file instead.");
    }
    payload.encryptedPayload = text.ciphertext;
    payload.iv = text.iv;
  }
  if (message.meta) {
    const meta = await encryptMessageMeta(key, message.id, message.meta);
    payload.fileMeta = meta.ciphertext;
    payload.fileMetaIv = meta.iv;
  }

  const signature = await signStatement(
    device.signingKeyPair.privateKey,
    messageSignatureStatement({
      groupId: device.groupId,
      messageId: message.id,
      senderDeviceId: device.deviceId,
      keyEpoch,
      ...payload,
    }),
  );

  try {
    await api.sendMessage({ id: message.id, keyEpoch, ...payload, signature }, auth);
  } catch (error) {
    // The id is ours and random: a conflict only means an earlier attempt of
    // this very request landed and its response was lost.
    if (error instanceof ApiError && error.code === "conflict") return;
    throw error;
  }
}

async function withRateLimitRetries(
  run: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const limited = error instanceof ApiError && error.code === "rate_limited";
      if (!limited || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
      await sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
