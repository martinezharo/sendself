import { getFile } from "../db/store";
import { showToast } from "../state/ui";
import type { LocalMessage } from "../types";

/** Open an attachment for a user action, using its encrypted metadata's name and MIME type. */
export async function readMessageFile(
  message: LocalMessage,
  spaceId?: string,
): Promise<File | undefined> {
  if (!message.file) return;
  let blob: Blob | undefined;
  try {
    blob = await getFile(message.file.r2Key, spaceId);
  } catch {
    showToast("Couldn't open this file on this device", "error");
    return;
  }
  if (!blob) {
    showToast("File is no longer available", "error");
    return;
  }
  return new File([blob], message.file.name, { type: message.file.mime });
}
