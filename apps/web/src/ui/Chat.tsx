import {
  AlertCircle,
  ArrowUp,
  CheckCheck,
  CircleDashed,
  Clock,
  Download,
  KeyRound,
  Lock,
  MoreVertical,
  Paperclip,
  RotateCw,
  ShieldAlert,
  UserMinus,
  UserPlus,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  consumeViewOnce,
  listDevicesDecrypted,
  releaseViewOnce,
  retryMessage,
  saveFile,
  sendStagedComposer,
} from "../actions";
import { getFile } from "../db/store";
import { getClipboardImages } from "../share/transfer";
import {
  composerDraft,
  stageFiles,
  stagedFiles,
  unstageFile,
  viewOnceArmed,
} from "../state/composer";
import { spaceEvents } from "../state/events";
import { type AlbumEntry, albumCaption, chatEntries } from "../state/grouping";
import { visibleMessages } from "../state/messages";
import { showSpaceSection } from "../state/route";
import { session } from "../state/session";
import { syncNow } from "../sync/sync";
import type { FileRef, LocalEvent, LocalMessage, MessageStatus } from "../types";
import type { MenuAnchor } from "./Menu";
import { MessageMenu } from "./MessageMenu";
import {
  Button,
  FileTypeIcon,
  IconButton,
  Modal,
  Spinner,
  cx,
  formatBytes,
  formatTime,
} from "./components";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function Linkify({ text }: { text: string }): JSX.Element {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    parts.push(
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 decoration-current opacity-80 hover:opacity-100"
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

/** Incoming file messages whose blob hasn't been fetched from the server yet. */
function countIncomingDownloads(list: LocalMessage[]): number {
  return list.filter(
    (m) =>
      m.direction === "in" && m.file && (m.fileState === "remote" || m.fileState === "downloading"),
  ).length;
}

export function Chat(): JSX.Element {
  const list = visibleMessages.value;
  // Files picked together arrive as separate messages; the chat puts them back
  // together, and space notices are merged into the same thread by time (see
  // state/grouping.ts).
  const entries = chatEntries(list, spaceEvents.value);
  const downloading = countIncomingDownloads(list);
  const currentSession = session.value;
  const myId = currentSession?.deviceId;
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(() => new Map());
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    // Open the chat already at the bottom; only animate for what arrives
    // afterwards. The thread starts empty and fills in async from IndexedDB,
    // so "opened" means the first render that had anything in it.
    //
    // Counted in entries rather than messages: a device joining while the chat
    // is open adds a notice and no message, and a notice that lands below the
    // fold is one nobody reads.
    bottomRef.current?.scrollIntoView({ behavior: hasScrolledRef.current ? "smooth" : "auto" });
    if (entries.length > 0) hasScrolledRef.current = true;
  }, [entries.length]);

  useEffect(() => {
    if (!currentSession) return;

    let cancelled = false;
    listDevicesDecrypted()
      .then(({ devices }) => {
        if (!cancelled) {
          setDeviceNames(new Map(devices.map((device) => [device.id, device.name])));
        }
      })
      .catch(() => {
        /* Names for newly received messages still come from /messages/pending. */
      });

    return () => {
      cancelled = true;
    };
  }, [currentSession?.groupId, currentSession?.deviceId]);

  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      {downloading > 0 && (
        <div class="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
          <div
            role="status"
            class="flex items-center gap-2 rounded-full bg-elevated px-3.5 py-[7px] text-caption font-medium text-ink shadow-pop"
          >
            <Spinner class="!size-[13px] !border-[1.5px]" />
            <span>Receiving {downloading === 1 ? "1 file" : `${downloading} files`}…</span>
          </div>
        </div>
      )}
      <div class="flex-1 overflow-y-auto px-6 pb-2 pt-[22px] max-md:px-[14px] max-md:pt-4">
        {/* A short conversation hangs from the composer rather than floating at
            the top of an empty column — the thread grows upwards, like every
            other messaging app. */}
        <div class="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-end gap-[3px]">
          {entries.length === 0 && <EmptyState />}
          {entries.map((entry, index) => {
            if (entry.kind === "notice") {
              return (
                <SpaceNotice
                  key={entry.key}
                  event={entry.event}
                  mine={entry.event.deviceId === myId}
                />
              );
            }
            const first = entry.kind === "album" ? entry.messages[0]! : entry.message;
            const previous = entries[index - 1];
            const previousSender =
              previous === undefined || previous.kind === "notice"
                ? undefined
                : previous.kind === "album"
                  ? previous.messages[0]?.senderDeviceId
                  : previous.message.senderDeviceId;
            return (
              <MessageBubble
                key={entry.key}
                message={first}
                {...(entry.kind === "album" ? { album: entry } : {})}
                mine={first.senderDeviceId === myId}
                deviceName={deviceNames.get(first.senderDeviceId)}
                // The name answers "who sent this?", so it is only worth
                // repeating when the answer changes.
                showSender={previousSender !== first.senderDeviceId}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
      <Composer />
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div class="m-auto flex max-w-[360px] flex-col items-center gap-3.5 px-5 py-10 text-center">
      <div class="surface-card grid size-14 place-items-center rounded-xl2 text-accent [&_svg]:size-[26px]">
        <Lock />
      </div>
      <div class="font-mono text-meta font-medium uppercase tracking-[0.2em] text-accent">
        End-to-end encrypted
      </div>
      <h3 class="-mt-1.5 text-title">Your private channel</h3>
      <p class="text-body leading-relaxed text-muted">
        Messages and files you send are encrypted on this device and synced only across your own
        linked devices.
      </p>
    </div>
  );
}

/**
 * How sure this device is about the keys of a device that joined.
 *
 * Only two answers matter to someone reading the thread — "its keys reached me
 * through a channel the server is not part of" or "I am taking the server's
 * word for it" — so four levels of provenance collapse into two, with the
 * strongest one naming how it was earned.
 */
function trustNote(trust: LocalEvent["trust"]): { label: string; verified: boolean } | null {
  switch (trust) {
    case "scanned":
      return { label: "verified by QR", verified: true };
    case "attested":
    case "inherited":
      return { label: "verified", verified: true };
    case "tofu":
      return { label: "not verified", verified: false };
    default:
      return null;
  }
}

/**
 * A space notice: what happened to the space, drawn in the thread it happened
 * in.
 *
 * Centred, unbubbled and without a timestamp — its place in the thread already
 * says when. Breaking the left/right rhythm is the point: these are not
 * messages, and they should never read as one.
 */
function SpaceNotice({ event, mine }: { event: LocalEvent; mine: boolean }): JSX.Element {
  const name = <b class="font-semibold text-ink">{event.deviceName ?? event.deviceId}</b>;

  if (event.kind === "device-key-changed") {
    // The one notice that is not just history: a device's identity key
    // changing is either a re-pairing the user knows about or someone standing
    // in the middle, and only the user can tell which.
    return (
      <div class="mx-auto my-1.5 flex max-w-[86%] items-start gap-[7px] rounded-card bg-danger-soft px-3.5 py-2.5 text-caption leading-snug text-danger [&>svg]:mt-px [&>svg]:size-[14px] [&>svg]:shrink-0">
        <ShieldAlert />
        <div>
          <span>The security key of {name} changed. Verify it before sharing anything else.</span>
          <button
            type="button"
            onClick={() => showSpaceSection("devices")}
            class="mt-1.5 block rounded-[8px] border border-danger/45 px-2 py-[3px] text-caption font-semibold text-danger transition hover:bg-danger/10"
          >
            Review devices
          </button>
        </div>
      </div>
    );
  }

  // How this device's own keys reached it is not a question it can answer
  // about itself, so its own arrival carries no verification note.
  const trust = event.kind === "device-added" && !mine ? trustNote(event.trust) : null;
  const icon =
    event.kind === "device-added" ? (
      <UserPlus />
    ) : event.kind === "device-removed" ? (
      <UserMinus />
    ) : (
      <KeyRound />
    );
  const body =
    event.kind === "device-added" ? (
      mine ? (
        <span>This device joined the space</span>
      ) : event.byMe ? (
        <span>You added {name} to the space</span>
      ) : (
        <span>{name} joined the space</span>
      )
    ) : event.kind === "device-removed" ? (
      <span>{name} was removed from the space</span>
    ) : (
      <span>
        The space key was rotated. Messages sent before this point stay readable here, but not on
        devices added later.
      </span>
    );

  // A pill is only a pill while it fits on one line; the rotation notice is a
  // sentence, and a three-line capsule reads as a mistake.
  const long = event.kind === "key-rotated";
  return (
    <div
      class={cx(
        "mx-auto my-1.5 flex max-w-[86%] items-start gap-[7px] bg-surface-3 px-3 py-1.5 text-caption leading-snug text-subtle [&>svg]:mt-[3px] [&>svg]:size-[13px] [&>svg]:shrink-0 [&>svg]:opacity-70",
        long ? "rounded-card text-left" : "rounded-full text-center",
      )}
    >
      {icon}
      <div>
        {body}
        {trust && (
          <>
            {" · "}
            <span class={cx("font-semibold", trust.verified ? "text-success-ink" : "text-muted")}>
              {trust.label}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The delivery state a group of messages should show as one.
 *
 * Ordered by how much is left to do, so an album never claims to be sent while
 * one of its files is still uploading, and a single failure is never hidden by
 * its siblings' ticks.
 */
const STATUS_ORDER: MessageStatus[] = ["failed", "uploading", "queued", "sent"];

function worstStatus(parts: readonly LocalMessage[]): MessageStatus {
  for (const status of STATUS_ORDER) {
    if (parts.some((part) => part.status === status)) return status;
  }
  return "sent";
}

/** How long a touch must be held on a bubble before the menu opens. */
const LONG_PRESS_MS = 400;
/** Finger drift beyond this cancels the long-press (it's a scroll). */
const LONG_PRESS_DRIFT_PX = 10;

function MessageBubble({
  message,
  album,
  mine,
  deviceName,
  showSender,
}: {
  /** The message itself, or the batch's representative when `album` is set. */
  message: LocalMessage;
  album?: AlbumEntry;
  mine: boolean;
  deviceName?: string;
  showSender: boolean;
}): JSX.Element {
  const displayDeviceName = showSender
    ? (message.senderDeviceName ?? deviceName ?? (mine ? session.value?.deviceName : undefined))
    : undefined;

  // Every message the bubble stands for: one, or the whole album.
  const parts = album?.messages ?? [message];
  const caption = album ? albumCaption(album) : message.text;
  // A view-once message shows a seal instead of its content until it is opened,
  // and opening it is what retracts it from the other devices. An outgoing one
  // is never openable: you wrote it, and consuming your own copy would destroy
  // the message for everyone without anybody having read it.
  const sealed = !!message.viewOnce;
  const openable = sealed && message.direction === "in";
  const [viewing, setViewing] = useState(false);
  // An album is as far along as its least-advanced file: one tick means every
  // file in it landed, and one spinner means at least one is still going up.
  const status = worstStatus(parts);

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const suppressTouchEnd = useRef(false);

  function cancelPress(): void {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  }

  // iOS Safari never fires `contextmenu` on long-press, so touch long-press is
  // detected by hand. Android's native long-press arrives as `contextmenu`
  // (handled below), racing this timer — whichever fires first wins.
  function onPointerDown(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    if (e.pointerType !== "touch" || menu) return;
    // A second finger means a scroll/zoom gesture, not a long-press.
    if (pressStart.current) {
      cancelPress();
      return;
    }
    suppressTouchEnd.current = false;
    const { pointerId, clientX, clientY } = e;
    pressStart.current = { pointerId, x: clientX, y: clientY };
    pressTimer.current = window.setTimeout(() => {
      cancelPress();
      suppressTouchEnd.current = true;
      navigator.vibrate?.(10);
      setMenu({ x: clientX, y: clientY });
    }, LONG_PRESS_MS);
  }

  // The menu opens while the finger is still down. Lifting it would otherwise
  // synthesize a click on whatever now sits at that point — the menu backdrop
  // (closing it instantly) or even the first menu item — so swallow it.
  function onTouchEnd(e: JSX.TargetedTouchEvent<HTMLDivElement>): void {
    if (!suppressTouchEnd.current) return;
    suppressTouchEnd.current = false;
    e.preventDefault();
  }

  function onPointerMove(e: JSX.TargetedPointerEvent<HTMLDivElement>): void {
    const start = pressStart.current;
    if (!start || e.pointerId !== start.pointerId) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_DRIFT_PX) cancelPress();
  }

  // Desktop right-click and Android long-press.
  function onContextMenu(e: JSX.TargetedMouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    cancelPress();
    if (!menu) setMenu({ x: e.clientX, y: e.clientY });
  }

  function openFromTrigger(e: JSX.TargetedMouseEvent<HTMLButtonElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: mine ? rect.right : rect.left, y: rect.bottom + 6 });
  }

  return (
    <div
      class={cx(
        // items-start, not items-center: the trigger is sticky within this
        // row, and centering it would leave it only the bottom half of a tall
        // bubble to travel through.
        "group flex items-start gap-1",
        // Bubbles from one device in a row read as one turn: tight inside the
        // run, a clear step between runs.
        showSender ? "mt-[9px]" : "mt-0",
        mine ? "justify-end" : "justify-start",
      )}
    >
      {mine && <MenuTrigger onOpen={openFromTrigger} />}
      <div
        class={cx(
          // A phone held at arm's length is not a monitor: the desktop
          // reading size steps up on narrow screens, where every messaging
          // app people compare this to sits at 16-17px.
          "msg-bubble max-w-[min(80%,540px)] rounded-card text-body leading-normal transition-shadow max-md:max-w-[86%] max-md:text-lead",
          message.file || album ? "p-[7px]" : "px-[13px] py-[9px]",
          mine
            ? "rounded-br-[5px] bg-bubble text-on-bubble shadow-soft"
            : "surface-card rounded-bl-[5px] text-ink",
          menu && "ring-2 ring-accent/60",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onTouchEnd={onTouchEnd}
        onContextMenu={onContextMenu}
      >
        {displayDeviceName && (
          <div
            class={cx(
              "mb-1 max-w-full truncate text-meta font-medium leading-tight max-md:text-caption",
              mine ? "text-on-bubble-muted" : "text-subtle",
            )}
            title={displayDeviceName}
          >
            {displayDeviceName}
          </div>
        )}
        {message.senderVerified === "invalid" && (
          <div
            class={cx(
              "mb-1.5 flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-meta font-medium leading-tight max-md:text-caption bg-danger-soft text-danger [&_svg]:size-[13px]",
            )}
            title="This message's signature doesn't match the sending device's key, so it may not come from the device it claims."
          >
            <ShieldAlert class="flex-none" />
            Sender couldn&apos;t be verified
          </div>
        )}
        {sealed && <ViewOnceSeal mine={mine} openable={openable} onOpen={() => setViewing(true)} />}
        {!sealed && message.corrupted && (
          <div
            class={cx(
              "flex items-center gap-1.5 text-note italic [&_svg]:size-[14px]",
              // `opacity` here dimmed the text below 4.5:1 on a sent bubble;
              // the muted token is the same intent at a legible contrast.
              mine ? "text-on-bubble-muted" : "text-muted",
            )}
          >
            <AlertCircle class="flex-none" />
            Couldn&apos;t decrypt this message
          </div>
        )}
        {!sealed &&
          (album ? (
            <div class="flex flex-col gap-[3px]">
              {album.messages.map((part) => (
                <FileAttachment key={part.id} message={part} mine={mine} />
              ))}
              {album.messages.length < album.expected && (
                <div
                  class={cx(
                    "px-1.5 py-1 text-meta max-md:text-caption",
                    mine ? "text-on-bubble-muted" : "text-muted",
                  )}
                >
                  {album.expected - album.messages.length} more on the way…
                </div>
              )}
            </div>
          ) : (
            message.file && <FileAttachment message={message} mine={mine} />
          ))}
        {/* Under the attachment, not above it: a caption describes what it
            hangs from, and reading it first leaves the reader holding a
            sentence with nothing to attach it to yet. */}
        {!sealed && caption && (
          <div
            class={cx(
              "whitespace-pre-wrap break-words",
              (album || message.file) && "px-1.5 pb-0.5 pt-[7px]",
            )}
          >
            <Linkify text={caption} />
          </div>
        )}
        <div
          class={cx(
            "mt-1 flex items-center justify-end gap-[5px] font-mono text-meta tracking-[0.03em] [&_svg]:size-[14px]",
            mine ? "text-on-bubble-muted" : "text-muted",
          )}
        >
          <span>{formatTime(message.createdAt)}</span>
          {mine && status === "queued" && <Clock aria-label="Waiting to send" />}
          {mine && status === "uploading" && <Spinner class="!size-[12px] !border-[1.5px]" />}
          {mine && status === "sent" && <CheckCheck />}
          {mine && status === "failed" && (
            <>
              <AlertCircle aria-label="Failed to send" />
              {/* Sized to WCAG 2.2's 24x24 minimum target rather than to the
                  11px caption it sits in — a retry is a real action, and it
                  was previously a bare 13px-tall run of text. */}
              <button
                type="button"
                onClick={() => void Promise.all(parts.map(retryMessage))}
                class="-my-1 inline-flex min-h-6 items-center rounded-full px-2 font-medium underline underline-offset-2 transition hover:bg-black/10 dark:hover:bg-white/10"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
      {!mine && <MenuTrigger onOpen={openFromTrigger} />}
      {viewing && <ViewOnceViewer message={message} onClose={() => setViewing(false)} />}
      {menu && (
        <MessageMenu
          message={message}
          {...(album ? { album: album.messages } : {})}
          anchor={menu}
          alignRight={mine}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * What a view-once message looks like before it is opened.
 *
 * The content is deliberately not rendered behind a blur or an overlay: it is
 * not in the DOM at all until the reader asks for it. Anything softer would
 * mean "the first device that opens it" was really "the first device that
 * happened to sync while in the foreground".
 */
function ViewOnceSeal({
  mine,
  openable,
  onOpen,
}: {
  mine: boolean;
  openable: boolean;
  onOpen: () => void;
}): JSX.Element {
  const body = (
    <>
      <span
        class={cx(
          "grid size-9 flex-none place-items-center rounded-full [&_svg]:size-[18px]",
          "bg-accent-soft text-accent",
        )}
      >
        <CircleDashed />
      </span>
      <span class="min-w-0 text-left">
        <span class="block font-medium">Temporary</span>
        <span class={cx("block text-caption", mine ? "text-on-bubble-muted" : "text-muted")}>
          {openable ? "Tap to open once" : "Disappears once opened"}
        </span>
      </span>
    </>
  );

  if (!openable) {
    return <span class="-mx-1 flex items-center gap-2.5 px-1 py-0.5">{body}</span>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      class="-mx-1 flex w-full items-center gap-2.5 rounded-[10px] px-1 py-0.5 transition hover:bg-black/5 dark:hover:bg-white/10"
    >
      {body}
    </button>
  );
}

/**
 * Reading a view-once message.
 *
 * Opening it retracts it from every *other* device immediately, and closing it
 * erases the copy here. The split is what makes the promise literal: a second
 * device can no longer reach the message from the moment this one opens it,
 * while the person who opened it still gets to finish reading.
 *
 * If the app dies with the viewer open the message survives, sealed. That
 * failure direction is the safe one — nothing is lost that the user has not
 * read.
 */
function ViewOnceViewer({
  message,
  onClose,
}: {
  message: LocalMessage;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    void consumeViewOnce(message);
  }, [message.id]);

  function done(): void {
    onClose();
    void releaseViewOnce(message);
  }

  return (
    <Modal title="Temporary message" onClose={done}>
      <div class="flex gap-2.5 rounded-card bg-accent-soft p-3 text-accent">
        <CircleDashed class="mt-0.5 size-[17px] flex-none" />
        <p class="text-note font-medium leading-5">
          Already removed from your other devices. It goes from this one when you close it.
        </p>
      </div>
      {message.text && (
        <p class="whitespace-pre-wrap break-words text-body leading-relaxed text-ink">
          <Linkify text={message.text} />
        </p>
      )}
      {message.file && (
        <div class="flex items-center gap-2.5 rounded-[10px] bg-surface-3 p-2">
          <div class="grid size-10 flex-none place-items-center rounded-[10px] bg-surface text-accent [&_svg]:size-5">
            <FileTypeIcon mime={message.file.mime} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-note font-medium" title={message.file.name}>
              {message.file.name}
            </div>
            <div class="font-mono text-meta tracking-[0.02em] text-muted">
              {formatBytes(message.file.size)}
            </div>
          </div>
          {message.fileState === "downloaded" && (
            <IconButton
              label="Save file"
              class="size-[34px]"
              onClick={() => void saveFile(message)}
            >
              <Download />
            </IconButton>
          )}
        </div>
      )}
      <div class="flex justify-end">
        <Button class="sm:w-auto" onClick={done}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Hover-revealed "⋮" button beside a bubble. Only rendered on devices with a
 * real pointer (`.msg-actions-trigger` is display:none elsewhere) — touch
 * users long-press the bubble instead.
 *
 * It sticks to the top of the scroller while its message is on screen, so a
 * long message is never a hunt for a button parked halfway down it, or one
 * scrolled out of the viewport entirely. Sticky confines it to its own row, so
 * it stops at the bubble's last line rather than following the next message.
 * Being able to float over the bubble above is what earns it a surface of its
 * own instead of the ghost button it was when it sat in dead margin.
 */
function MenuTrigger({
  onOpen,
}: {
  onOpen: (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Message actions"
      title="Message actions"
      onClick={onOpen}
      class="msg-actions-trigger sticky top-2 size-7 flex-none place-items-center rounded-full bg-elevated text-muted opacity-0 shadow-soft transition hover:bg-surface-3 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-4"
    >
      <MoreVertical />
    </button>
  );
}

/** Human-readable transfer state for a file card. */
function fileStateLabel(message: LocalMessage): string | null {
  if (message.direction === "out") {
    switch (message.status) {
      case "queued":
        return "Waiting to upload";
      case "uploading":
        return "Uploading…";
      case "failed":
        return "Upload failed";
      default:
        return null;
    }
  }
  switch (message.fileState) {
    case "corrupted":
      return "Couldn't decrypt";
    case "expired":
      return "No longer available";
    default:
      return null;
  }
}

/**
 * Object URL for an image attachment's locally cached blob, or null while the
 * file is not an image / not downloaded yet. Revoked on unmount.
 */
function useImageThumbnail(file: FileRef, available: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = file.mime.startsWith("image/");

  useEffect(() => {
    if (!isImage || !available) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void getFile(file.r2Key).then((blob) => {
      if (!blob || cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file.r2Key, isImage, available]);

  return url;
}

function FileAttachment({ message, mine }: { message: LocalMessage; mine: boolean }): JSX.Element {
  const file = message.file!;
  const state = message.fileState;
  const stateLabel = fileStateLabel(message);
  const thumbnailUrl = useImageThumbnail(file, state === "downloaded");

  return (
    <div
      class={cx(
        "flex min-w-[240px] items-center gap-[11px] rounded-[10px] px-2.5 py-2",
        // The inset has to move *away* from the bubble's text colour, not
        // always darker: in the dark theme the accent is light and the text
        // on it is near-black, so darkening this panel pushed even the file
        // name down to 4.17:1. Lightening it there restores 6.9:1.
        mine ? "bg-black/15 dark:bg-white/15" : "bg-surface-3",
      )}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          class="size-10 flex-none rounded-[10px] object-cover"
          loading="lazy"
        />
      ) : (
        <div
          class={cx(
            "grid size-10 flex-none place-items-center rounded-[10px] text-accent [&_svg]:size-5",
            mine ? "bg-white/90" : "bg-surface",
          )}
        >
          <FileTypeIcon mime={file.mime} />
        </div>
      )}
      <div class="min-w-0 flex-1">
        <div class="truncate text-note font-medium max-md:text-body" title={file.name}>
          {file.name}
        </div>
        <div
          class={cx(
            "font-mono text-meta tracking-[0.02em] max-md:text-caption",
            mine ? "text-on-bubble-muted" : "text-muted",
          )}
        >
          {formatBytes(file.size)}
          {stateLabel && ` · ${stateLabel}`}
        </div>
      </div>
      <div class="flex-none">
        {message.direction === "out" ? (
          message.status === "uploading" ? (
            <span class="grid size-[34px] place-items-center">
              <Spinner />
            </span>
          ) : message.status === "failed" ? (
            <IconButton
              label="Retry upload"
              class={cx("size-[34px]", mine && "text-on-bubble hover:bg-accent-soft")}
              onClick={() => void retryMessage(message)}
            >
              <RotateCw />
            </IconButton>
          ) : (
            <IconButton
              label="Save file"
              class={cx("size-[34px]", mine && "text-on-bubble hover:bg-accent-soft")}
              onClick={() => void saveFile(message)}
            >
              <Download />
            </IconButton>
          )
        ) : (
          <>
            {(state === "remote" || state === "downloading") && <Spinner />}
            {state === "downloaded" && (
              <IconButton
                label="Save file"
                class="size-[34px]"
                onClick={() => void saveFile(message)}
              >
                <Download />
              </IconButton>
            )}
            {state === "error" && (
              <IconButton label="Retry download" class="size-[34px]" onClick={() => void syncNow()}>
                <RotateCw />
              </IconButton>
            )}
            {(state === "corrupted" || state === "expired") && (
              <span
                class="grid size-[34px] place-items-center text-muted [&_svg]:size-[18px]"
                title={
                  state === "corrupted" ? "Couldn't decrypt this file" : "File no longer available"
                }
              >
                <AlertCircle />
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The composer.
 *
 * Two rules decide the layout. **Left is how you send** — the view-once
 * toggle, which stays visible at all times so the mode can be armed *or
 * disarmed* with text already in the field, and is reachable when the share
 * sheet hands the composer a draft it did not type. **Right is what you send**
 * — attach, then send. The old `+` becomes a paperclip and moves next to the
 * send button, because it opens the file picker directly and never promised a
 * menu.
 *
 * Its contents live in `state/composer.ts` rather than in local state: a drop
 * anywhere in the window, a paste, and a share from another app all fill the
 * same queue, and all of them used to bypass the composer entirely by sending
 * on the spot.
 */
function Composer(): JSX.Element {
  const text = composerDraft.value;
  const queue = stagedFiles.value;
  const armed = viewOnceArmed.value;
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function autosize(): void {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  // The draft can be filled from outside the component (Web Share Target, a
  // drop), so the textarea has to resize to content it did not receive by
  // keystroke.
  useEffect(autosize, [text]);

  function submit(): void {
    void sendStagedComposer();
    requestAnimationFrame(autosize);
  }

  function onPickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    stageFiles(Array.from(input.files ?? []));
    input.value = "";
  }

  function onPaste(event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>): void {
    const images = getClipboardImages(event.clipboardData);
    if (images.length === 0) return;

    // Staged rather than sent: a pasted screenshot is exactly the kind of thing
    // people want to say something about.
    event.preventDefault();
    stageFiles(images);
  }

  const canSend = !!text.trim() || queue.length > 0;

  return (
    <div class="flex-none px-6 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 max-md:px-[14px] max-md:pb-[calc(14px+env(safe-area-inset-bottom))]">
      <div
        class={cx(
          "surface-card mx-auto w-full max-w-[760px] rounded-[24px] !shadow-pop transition",
          armed && "ring-2 ring-accent/60",
        )}
      >
        {armed && (
          <div class="flex items-center gap-2 border-b border-line px-3.5 pb-2 pt-2.5 text-caption font-medium text-accent">
            <CircleDashed class="size-[15px] flex-none" />
            <span class="flex-1">Temporary — disappears once opened</span>
            <button
              type="button"
              aria-label="Turn off temporary"
              onClick={() => (viewOnceArmed.value = false)}
              class="grid size-6 flex-none place-items-center rounded-full transition hover:bg-accent-soft [&_svg]:size-[14px]"
            >
              <X />
            </button>
          </div>
        )}

        {/* Shown rather than hidden behind a badge: holding files back is only
            worth the extra tap if you can see what is about to go. */}
        {queue.length > 0 && (
          <div class="no-scrollbar flex gap-2 overflow-x-auto border-b border-line px-2.5 py-2.5">
            {queue.map((staged) => (
              <div key={staged.id} class="relative w-[76px] flex-none">
                <div class="grid h-[62px] place-items-center rounded-[10px] bg-surface-3 text-accent [&_svg]:size-6">
                  <FileTypeIcon mime={staged.file.type} />
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${staged.file.name}`}
                  onClick={() => unstageFile(staged.id)}
                  class="absolute -right-1 -top-1 grid size-[22px] place-items-center rounded-full bg-elevated text-subtle shadow-pop ring-1 ring-line transition hover:text-ink [&_svg]:size-[13px]"
                >
                  <X />
                </button>
                <div class="mt-1 truncate text-meta text-subtle" title={staged.file.name}>
                  {staged.file.name}
                </div>
                <div class="font-mono text-meta text-muted">{formatBytes(staged.file.size)}</div>
              </div>
            ))}
          </div>
        )}

        <div class="flex items-end gap-1.5 px-2 py-2">
          <input ref={fileRef} type="file" multiple hidden onChange={onPickFile} />
          <button
            type="button"
            aria-label="Send as a temporary message"
            title="Temporary message"
            aria-pressed={armed}
            onClick={() => (viewOnceArmed.value = !armed)}
            class={cx(
              "grid size-9 flex-none place-items-center rounded-full transition active:scale-90 [&_svg]:size-[20px]",
              armed
                ? "bg-accent-soft text-accent"
                : "text-subtle hover:bg-surface-3 hover:text-ink",
            )}
          >
            <CircleDashed />
          </button>
          <textarea
            ref={taRef}
            // `max-md:text-lead` is load-bearing, not cosmetic: under 16px iOS
            // Safari zooms the viewport the moment the composer takes focus and
            // never zooms back out.
            class="no-scrollbar max-h-[160px] flex-1 self-center border-none bg-transparent px-1.5 py-[7px] text-body-lg leading-[1.45] text-ink outline-none placeholder:text-muted focus:!shadow-none focus-visible:!shadow-none max-md:text-lead"
            placeholder={
              queue.length > 0 ? "Add a comment…" : armed ? "Temporary message" : "Write a message"
            }
            value={text}
            rows={1}
            onPaste={onPaste}
            onInput={(e) => {
              composerDraft.value = (e.target as HTMLTextAreaElement).value;
              autosize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            aria-label="Attach file"
            title="Attach file"
            onClick={() => fileRef.current?.click()}
            class="grid size-9 flex-none place-items-center rounded-full text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-90 [&_svg]:size-[20px]"
          >
            <Paperclip />
          </button>
          <div class="relative flex-none">
            <button
              type="button"
              aria-label="Send message"
              title="Send"
              onClick={submit}
              disabled={!canSend}
              class="grid size-9 place-items-center rounded-full bg-accent text-on-accent transition hover:bg-accent-hover active:scale-90 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-muted [&_svg]:size-[18px]"
            >
              <ArrowUp strokeWidth={2.5} />
            </button>
            {/* The send button reflects the mode; it never controls it, so it
                can still be changed after the message is written. */}
            {armed && canSend && (
              <span
                aria-hidden="true"
                class="pointer-events-none absolute -right-0.5 -top-0.5 grid size-[17px] place-items-center rounded-full bg-elevated text-accent ring-1 ring-line [&_svg]:size-[11px]"
              >
                <CircleDashed />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
