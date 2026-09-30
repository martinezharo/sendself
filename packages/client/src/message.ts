/**
 * How a message's contents are sealed with the GroupKey.
 *
 * Every ciphertext in a message is bound (as AES-GCM additional data) to the
 * message id and to the role it plays, so a server cannot move a caption onto
 * another message or pass a file off as its metadata. Those context strings are
 * protocol: a sender and a receiver that disagree on one byte cannot read each
 * other. They live here, once, so the PWA and the CLI cannot drift apart.
 */

import type { MessageMeta } from "@sendself/shared";
import {
  type EncryptedFile,
  type EncryptedText,
  decryptFile,
  decryptJson,
  decryptText,
  encryptFile,
  encryptJson,
  encryptText,
} from "./crypto";

/** The AAD context of each ciphertext a message can carry. */
export const messageContext = {
  text: (messageId: string): string => `text:${messageId}`,
  file: (messageId: string): string => `file:${messageId}`,
  meta: (messageId: string): string => `meta:${messageId}`,
} as const;

export function encryptMessageText(
  key: CryptoKey,
  messageId: string,
  text: string,
): Promise<EncryptedText> {
  return encryptText(key, text, messageContext.text(messageId));
}

export function decryptMessageText(
  key: CryptoKey,
  messageId: string,
  ciphertext: string,
  iv: string,
): Promise<string> {
  return decryptText(key, ciphertext, iv, messageContext.text(messageId));
}

/** See `encryptFile` for when `ivB64` may be passed. */
export function encryptMessageFile(
  key: CryptoKey,
  messageId: string,
  data: ArrayBuffer,
  ivB64?: string,
): Promise<EncryptedFile> {
  return encryptFile(key, data, messageContext.file(messageId), ivB64);
}

export function decryptMessageFile(
  key: CryptoKey,
  messageId: string,
  data: ArrayBuffer,
  iv: string,
): Promise<ArrayBuffer> {
  return decryptFile(key, data, iv, messageContext.file(messageId));
}

export function encryptMessageMeta(
  key: CryptoKey,
  messageId: string,
  meta: MessageMeta,
): Promise<EncryptedText> {
  return encryptJson(key, meta, messageContext.meta(messageId));
}

export function decryptMessageMeta(
  key: CryptoKey,
  messageId: string,
  ciphertext: string,
  iv: string,
): Promise<MessageMeta> {
  return decryptJson<MessageMeta>(key, ciphertext, iv, messageContext.meta(messageId));
}
