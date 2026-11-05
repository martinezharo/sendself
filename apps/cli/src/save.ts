/**
 * `sendself save`: keep files and notes in the space's vault, where they stay
 * until someone deletes them, instead of delivering them as messages.
 */

import { readFile } from "node:fs/promises";
import { type Api, ApiError } from "@sendself/client/api";
import {
  type VaultContext,
  type VaultEntry,
  applyVaultChanges,
  createVaultFile,
  createVaultFolder,
  createVaultNote,
  isVaultItemVisible,
  openVaultEntries,
  pullVaultChanges,
} from "@sendself/client/vault";
import type { Device } from "./config";
import type { OutgoingFile } from "./send";
import { explainAuthFailure, syncKeys } from "./session";

export interface SaveRequest {
  /** Folder path inside the vault, `/`-separated; missing folders are created. Root when empty. */
  folder?: string;
  files: readonly OutgoingFile[];
  /** A note to save, with an optional title (its first line otherwise). */
  note?: { title: string; text: string };
}

export interface SaveOptions {
  devicePath?: string;
  onSaved?: (entry: VaultEntry) => void;
}

/** Split a folder path into names, ignoring empty segments (`/a//b/` is `a/b`). */
export function folderNames(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * The visible folder called `name` directly inside `parentId`, if there is
 * one. Names are not unique in the vault; the oldest folder wins, so the same
 * path always lands in the same place.
 */
export function childFolder(
  entries: readonly VaultEntry[],
  parentId: string | null,
  name: string,
): VaultEntry | undefined {
  return entries
    .filter(
      (entry) =>
        entry.record.kind === "folder" &&
        entry.record.parentId === parentId &&
        entry.meta?.name === name,
    )
    .sort((a, b) => a.record.createdAt - b.record.createdAt)[0];
}

export async function saveAll(
  device: Device,
  api: Api,
  request: SaveRequest,
  options: SaveOptions = {},
): Promise<Device> {
  try {
    const synced = (await syncKeys(device, api, options.devicePath)).device;
    const ctx: VaultContext = {
      api,
      auth: { token: synced.token },
      groupId: synced.groupId,
      keyring: synced.keyring,
    };

    const parentId = await resolveFolder(ctx, folderNames(request.folder), options);
    for (const file of request.files) {
      const data = await readFile(file.path);
      const entry = await createVaultFile(ctx, parentId, {
        name: file.name,
        mime: file.mime,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      });
      options.onSaved?.(entry);
    }
    if (request.note) {
      // Not `onSaved?.(await …)`: an absent callback would skip evaluating the save.
      const entry = await createVaultNote(ctx, parentId, request.note.title, request.note.text);
      options.onSaved?.(entry);
    }
    return synced;
  } catch (error) {
    if (error instanceof ApiError && error.code === "key_rotated") {
      throw new Error(
        "The space's key changed and this device has not received the new one yet. Open SendSelf on one of your devices so it can finish the rotation, then try again.",
      );
    }
    throw explainAuthFailure(error);
  }
}

/** The id of the folder at `names`, creating whatever part of the path is missing. */
async function resolveFolder(
  ctx: VaultContext,
  names: readonly string[],
  options: SaveOptions,
): Promise<string | null> {
  if (names.length === 0) return null;
  const changes = await pullVaultChanges(ctx.api, ctx.auth, 0);
  const records = applyVaultChanges(new Map(), changes);
  const visible = [...records.values()].filter((record) => isVaultItemVisible(records, record));
  const entries = await openVaultEntries(ctx.keyring, ctx.groupId, visible);

  let parentId: string | null = null;
  for (const name of names) {
    let folder = childFolder(entries, parentId, name);
    if (!folder) {
      folder = await createVaultFolder(ctx, parentId, name);
      entries.push(folder);
      options.onSaved?.(folder);
    }
    parentId = folder.record.id;
  }
  return parentId;
}
