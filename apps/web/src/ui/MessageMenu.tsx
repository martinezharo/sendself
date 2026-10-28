import { Copy, ImageIcon, Share2, Trash2, Users } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  canCopyImage,
  canDeleteEverywhere,
  canShareMessage,
  copyMessageImage,
  copyMessageText,
  deleteMessageEverywhere,
  deleteMessageLocally,
  shareMessage,
} from "../actions";
import type { LocalMessage } from "../types";
import { Menu, type MenuAnchor, MenuItem, MenuSeparator } from "./Menu";
import { Button, Modal } from "./components";

/**
 * Per-message context menu, opened from the message's own button, a long-press
 * or a right-click.
 *
 * `album` is the whole batch when the menu was opened on one. Deleting then
 * takes the album with it, which is what the user is looking at and pointing
 * at — offering to delete one hidden third of a group would be a surprise.
 * Copy and share still act on the representative message alone: those produce
 * one thing, not N. For that reason "Copy image" is not offered on an album at
 * all — it would copy a photo the user never pointed at.
 */
export function MessageMenu({
  message,
  album,
  anchor,
  alignRight,
  onClose,
}: {
  message: LocalMessage;
  album?: readonly LocalMessage[];
  anchor: MenuAnchor;
  alignRight: boolean;
  onClose: () => void;
}): JSX.Element {
  // Deleting everywhere is the one action here that cannot be undone and that
  // reaches beyond this device, so it is confirmed. The confirmation replaces
  // the menu rather than opening on top of it: the menu's backdrop sits above
  // the dialog layer, and dismissing the menu first would take the dialog with
  // it.
  const [confirmingGlobalDelete, setConfirmingGlobalDelete] = useState(false);

  const targets = album ?? [message];
  const copyableImage = targets.length === 1 && canCopyImage(message);
  const hasActions = !!message.text || copyableImage || canShareMessage(message);

  function run(action: (message: LocalMessage) => Promise<void>): void {
    onClose();
    void action(message);
  }

  /** Apply a destructive action to every message the menu was opened on. */
  function runAll(action: (message: LocalMessage) => Promise<void>): void {
    onClose();
    void Promise.all(targets.map((target) => action(target)));
  }

  if (confirmingGlobalDelete) {
    return (
      <Modal title="Delete on all devices?" onClose={onClose}>
        <div class="px-5 pb-5 pt-1 text-body leading-relaxed text-muted">
          <p>
            {targets.length === 1 ? "This message" : `These ${targets.length} files`} will be
            removed from every device linked to this space, including the ones that are offline
            right now — they&apos;ll delete it as soon as they reconnect.
          </p>
          <p class="mt-3">
            {targets.some((target) => target.file)
              ? "A device that already saved this file elsewhere keeps that copy. This can't be undone."
              : "This can't be undone."}
          </p>
          <div class="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button class="sm:w-auto" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              class="sm:w-auto"
              variant="danger"
              onClick={() => runAll(deleteMessageEverywhere)}
            >
              Delete everywhere
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Menu anchor={anchor} alignRight={alignRight} label="Message actions" onClose={onClose}>
      {message.text && (
        <MenuItem icon={<Copy />} onClick={() => run(copyMessageText)}>
          Copy text
        </MenuItem>
      )}
      {copyableImage && (
        <MenuItem icon={<ImageIcon />} onClick={() => run(copyMessageImage)}>
          Copy image
        </MenuItem>
      )}
      {canShareMessage(message) && (
        <MenuItem icon={<Share2 />} onClick={() => run(shareMessage)}>
          Share…
        </MenuItem>
      )}
      {hasActions && <MenuSeparator />}
      <MenuItem danger icon={<Trash2 />} onClick={() => runAll(deleteMessageLocally)}>
        Delete on this device
      </MenuItem>
      {/* Hidden entirely when no other device can be holding a copy — an entry
          that would do nothing beyond the one above it is worse than no entry
          at all. See `canDeleteEverywhere`. */}
      {targets.some(canDeleteEverywhere) && (
        <MenuItem danger icon={<Users />} onClick={() => setConfirmingGlobalDelete(true)}>
          Delete on all devices
        </MenuItem>
      )}
    </Menu>
  );
}
