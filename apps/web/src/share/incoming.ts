/**
 * Reading what the Web Share Target delivered.
 *
 * The service worker (src/sw/share-target.ts) cannot hand the POST body to the
 * page, so it stashes the shared text + files in the Cache Storage and
 * redirects to `/app?share-target=1`. This module drains that stash; applying
 * it — prefilling the composer, queueing the files — belongs to the space that
 * receives it (see `consumeSharedContent` in actions/spaces.ts).
 *
 * Keep `SHARE_CACHE` and the cache keys in sync with src/sw/share-target.ts.
 */

import {
  MAX_SHARED_FILES,
  SHARE_CACHE,
  SHARE_META_KEY,
  type SharedMeta,
  clearSharedCache,
  sharedFileKey,
} from "./cache";

/** Text and files handed over by the OS share sheet. */
export interface SharedContent {
  text: string;
  files: File[];
}

/**
 * Whether this page load came from the share sheet, consuming the marker so a
 * reload does not reprocess an already-handled share.
 *
 * Separate from reading the content because the two happen at different
 * moments: the marker is in the URL the service worker redirected to and must
 * be cleared before the router reads it, while the content can only be applied
 * once a space is open to receive it.
 */
export function claimSharedContent(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has("share-target")) return false;
  history.replaceState(null, "", location.pathname);
  return true;
}

/**
 * Drain the stash. Whatever it finds is removed from the cache, so a share is
 * delivered at most once.
 */
export async function takeSharedContent(): Promise<SharedContent> {
  if (!("caches" in window)) return { text: "", files: [] };
  const cache = await caches.open(SHARE_CACHE);

  const meta = await readMeta(cache);
  try {
    return { text: joinSharedText(meta), files: await readFiles(cache, meta.fileCount) };
  } finally {
    // Clearing by prefix also removes files left behind when an earlier share
    // was interrupted or contained more files than the current metadata.
    await clearSharedCache(cache);
  }
}

async function readMeta(cache: Cache): Promise<SharedMeta> {
  const fallback: SharedMeta = { title: "", text: "", url: "", fileCount: 0 };
  const response = await cache.match(SHARE_META_KEY);
  if (!response) return fallback;
  try {
    const raw = (await response.json()) as Partial<SharedMeta>;
    return {
      title: typeof raw.title === "string" ? raw.title : fallback.title,
      text: typeof raw.text === "string" ? raw.text : fallback.text,
      url: typeof raw.url === "string" ? raw.url : fallback.url,
      fileCount:
        typeof raw.fileCount === "number" &&
        Number.isSafeInteger(raw.fileCount) &&
        raw.fileCount >= 0 &&
        raw.fileCount <= MAX_SHARED_FILES
          ? raw.fileCount
          : fallback.fileCount,
    };
  } catch {
    return fallback;
  }
}

async function readFiles(cache: Cache, count: number): Promise<File[]> {
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const response = await cache.match(sharedFileKey(i));
    if (!response) continue;
    try {
      const blob = await response.blob();
      let name = response.headers.get("X-Share-Filename") ?? `shared-${i}`;
      try {
        name = decodeURIComponent(name);
      } catch {
        // A malformed cache entry must not prevent the rest of a share from
        // being delivered.
      }
      files.push(new File([blob], name, { type: blob.type }));
    } catch {
      // Continue draining the other files and clear this one in the finally.
    }
  }
  return files;
}

/** Combine title/text/url into one message, dropping empties and duplicates. */
function joinSharedText(meta: SharedMeta): string {
  const parts: string[] = [];
  for (const value of [meta.title, meta.text, meta.url]) {
    const trimmed = value.trim();
    if (trimmed && !parts.some((p) => p.includes(trimmed))) parts.push(trimmed);
  }
  return parts.join("\n");
}
