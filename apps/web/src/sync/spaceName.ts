/**
 * The space's name, kept the same on every device in it.
 *
 * A name used to be local: renaming on a phone left the laptop calling the
 * space something else. It is now a property of the space, and this module is
 * the whole of how that works.
 *
 * The name travels as ciphertext under the GroupKey, so the server stores a
 * blob it cannot read (see the migration for exactly what it does learn). It is
 * stored rather than broadcast as a message because a message expires after 24
 * h: a device that spends a week switched off must still come back to the right
 * name, which it does by reading the record on its first poll.
 *
 * Conflicts resolve on the server's clock, not on any device's. Every publish
 * is stamped when it lands, and a device adopts anything stamped later than
 * what it holds — so two devices renamed at the same moment converge on the
 * one that arrived last, and a device with a badly wrong clock cannot pin its
 * own name forever.
 */

import type { SpaceNameRecord } from "@sendself/shared";
import { api } from "../api/client";
import { decryptText, encryptText } from "../crypto/crypto";
import { type Keyring, currentKey, keyForEpoch } from "../crypto/keyring";
import {
  type SpaceRecord,
  adoptSpaceName,
  markSpaceNamePublished,
  renameSpace,
} from "../db/spaces";
import { authHeaders, keyring, session } from "../state/session";
import { activeSpace, applySpaceRecord } from "../state/spaces";

/**
 * AAD binding the ciphertext to the space it names, so a name blob cannot be
 * replayed into another space (or into a device's name, which uses `name:<id>`).
 */
const nameContext = (groupId: string): string => `space-name:${groupId}`;

/**
 * Rename the space, everywhere.
 *
 * The local write lands first and always: the new name is on screen before any
 * request is made, and a rename typed on a train is not lost — it stays owed
 * until the sync loop can publish it.
 */
export async function renameActiveSpace(name: string): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;
  const renamed = await renameSpace(space.id, name);
  if (!renamed) return;
  applySpaceRecord(renamed);
  await publishSpaceName(renamed);
}

/**
 * Reconcile the local name with the one the space carries, on every sync pass.
 *
 * Three things can be true, in this order of precedence:
 *
 *  - this device owes the space a rename → publish it;
 *  - the space's name is newer than the one adopted here → take it on;
 *  - the space's name is sealed under a superseded key → publish it again under
 *    the current one, so a device that joins later (and holds only the current
 *    key) can read it. Whichever device notices first does it, exactly like a
 *    pending key rotation.
 *
 * Nothing here ever clears a name it merely failed to read: a device that
 * cannot open the record keeps calling the space what it called it before.
 */
export async function syncSpaceName(record: SpaceNameRecord | null, ring: Keyring): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;

  if (space.namePending) {
    await publishSpaceName(space, ring);
    return;
  }
  if (!record) return;

  if (record.updatedAt > space.nameUpdatedAt) {
    const name = await readSpaceName(record, ring);
    // Undecipherable here (a key epoch this device never held): keep the local
    // name rather than blanking it, and let a device that can read it re-publish.
    if (name === undefined) return;
    applySpaceRecord(await adoptSpaceName(space.id, name, record.updatedAt));
    return;
  }

  // Only with a name in hand: a space with none has no ciphertext to re-seal,
  // and a name this device cannot currently read (a sealed registry) also reads
  // as none — publishing that would clear the name for everyone.
  if (
    record.updatedAt === space.nameUpdatedAt &&
    record.nameKeyEpoch < ring.current &&
    space.name !== null
  ) {
    await publishSpaceName(space, ring);
  }
}

/**
 * Encrypt the local name and hand it to the space. Failures are silent by
 * design: `namePending` survives them, so the next pass simply tries again —
 * offline, rate-limited, or racing a key rotation are all the same thing here.
 */
async function publishSpaceName(space: SpaceRecord, ring?: Keyring): Promise<void> {
  const current = session.value;
  const usedRing = ring ?? keyring.value;
  if (!current || !usedRing) return;

  const encrypted =
    space.name === null
      ? null
      : await encryptText(currentKey(usedRing), space.name, nameContext(current.groupId));

  try {
    const { updatedAt } = await api.updateSpaceName(
      {
        encryptedName: encrypted?.ciphertext ?? null,
        nameIv: encrypted?.iv ?? null,
        nameKeyEpoch: usedRing.current,
      },
      authHeaders(),
    );
    applySpaceRecord(await markSpaceNamePublished(space.id, space.name, updatedAt));
  } catch {
    // Still owed. The sync loop retries on every pass until it lands.
  }
}

/** The name inside a record: null when cleared, undefined when unreadable here. */
async function readSpaceName(
  record: SpaceNameRecord,
  ring: Keyring,
): Promise<string | null | undefined> {
  if (!record.encryptedName || !record.nameIv) return null;
  const current = session.value;
  const key = keyForEpoch(ring, record.nameKeyEpoch);
  if (!current || !key) return undefined;
  return decryptText(key, record.encryptedName, record.nameIv, nameContext(current.groupId)).catch(
    () => undefined,
  );
}
