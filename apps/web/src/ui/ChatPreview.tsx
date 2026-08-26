import {
  ArrowUp,
  CheckCheck,
  CircleDashed,
  Download,
  Lock,
  MonitorSmartphone,
  Paperclip,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { FileTypeIcon, cx, formatBytes, formatTime } from "./components";

/**
 * The chat, as the landing page shows it.
 *
 * A playable demo rather than a screenshot: you can write, attach files and arm
 * a temporary message, and the thread reacts. Nothing here touches a space, the
 * network or storage — the transcript lives in component state and is gone on
 * reload, which is exactly the promise the page makes ("your content stays on
 * your devices"), and it keeps the prerendered markup deterministic.
 *
 * Its looks are deliberately the app's own: the same bubble tokens, radii,
 * composer layout and delivery ticks as `Chat.tsx`. When the chat changes, this
 * has to change with it — a hero that shows a product nobody ships is worse
 * than no hero at all.
 */

interface PreviewFile {
  id: number;
  name: string;
  size: number;
  mime: string;
  /** Set only for images picked in this session, for the thumbnail. */
  blob?: File;
}

interface PreviewMessage {
  id: number;
  mine: boolean;
  text?: string;
  files?: PreviewFile[];
  /** Clock label; seeded messages carry a fixed one so the prerender is stable. */
  time: string;
  sender?: string;
  /** A view-once message: sealed until the receiving device opens it. */
  sealed?: boolean;
}

const SEED: PreviewMessage[] = [
  {
    id: 1,
    mine: false,
    sender: "My laptop",
    text: "https://rankmaker.net/template/best-video-game-sagas",
    time: "09:41",
  },
  {
    id: 2,
    mine: false,
    files: [{ id: 1, name: "contract-signed.pdf", size: 1_258_291, mime: "application/pdf" }],
    time: "09:41",
  },
  {
    id: 3,
    mine: true,
    sender: "This device",
    text: "Marta · +1 (202) 555-0147",
    time: "09:42",
  },
];

let nextId = 100;

export function ChatPreview(): JSX.Element {
  const [messages, setMessages] = useState<PreviewMessage[]>(SEED);
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<PreviewFile[]>([]);
  const [armed, setArmed] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const openedRef = useRef(false);

  // The thread opens at its newest message and stays there, like the app's
  // chat. `scrollTop` rather than `scrollIntoView`: this only moves the panel's
  // own overflow, so a preview far down the hero never drags the page with it.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({
      top: thread.scrollHeight,
      behavior: openedRef.current ? "smooth" : "auto",
    });
    openedRef.current = true;
  }, [messages.length, queue.length, armed]);

  function autosize(): void {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
  }

  const canSend = !!draft.trim() || queue.length > 0;

  function send(): void {
    if (!canSend) return;
    setMessages((current) => [
      ...current,
      {
        id: nextId++,
        mine: true,
        ...(draft.trim() ? { text: draft.trim() } : {}),
        ...(queue.length > 0 ? { files: queue } : {}),
        time: formatTime(Date.now()),
        sender: current[current.length - 1]?.mine ? undefined : "This device",
        ...(armed ? { sealed: true } : {}),
      },
    ]);
    setDraft("");
    setQueue([]);
    setArmed(false);
    requestAnimationFrame(autosize);
  }

  function onPickFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []).map((file) => ({
      id: nextId++,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      ...(file.type.startsWith("image/") ? { blob: file } : {}),
    }));
    setQueue((current) => [...current, ...picked]);
    input.value = "";
  }

  return (
    <div class="surface-card w-full overflow-hidden rounded-xl3 !shadow-float max-md:rounded-xl2">
      <div class="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span class="grid size-8 flex-none place-items-center rounded-[10px] bg-accent-soft text-accent [&_svg]:size-[17px]">
          <MonitorSmartphone />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-display text-body font-semibold tracking-[-0.02em]">
            Personal
          </span>
          <span class="block font-mono text-meta uppercase tracking-[0.14em] text-muted">
            3 devices
          </span>
        </span>
        <span class="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--c-success)_14%,transparent)] px-2.5 py-1 font-mono text-meta font-medium uppercase tracking-[0.12em] text-success-ink [&_svg]:size-3">
          <Lock />
          Encrypted
        </span>
      </div>

      <div
        ref={threadRef}
        // The fade at the top says "there is more above" — without it a
        // message clipped by the panel's edge just looks broken.
        class="no-scrollbar h-[288px] overflow-y-auto px-3 py-3.5 [mask-image:linear-gradient(to_bottom,transparent_0,black_20px)] max-md:h-[264px]"
      >
        <div class="flex min-h-full flex-col justify-end gap-[3px]">
          {messages.map((message, index) => (
            <PreviewBubble
              key={message.id}
              message={message}
              showSender={messages[index - 1]?.mine !== message.mine}
            />
          ))}
        </div>
      </div>

      <div class="border-t border-line p-2.5">
        <div class={cx("rounded-[20px] bg-surface-3 transition", armed && "ring-2 ring-accent/60")}>
          {armed && (
            <div class="flex items-center gap-2 border-b border-line px-3 pb-1.5 pt-2 text-caption font-medium text-accent">
              <CircleDashed class="size-[14px] flex-none" />
              <span class="flex-1">Temporary — disappears once opened</span>
              <button
                type="button"
                aria-label="Turn off temporary"
                onClick={() => setArmed(false)}
                class="grid size-5 flex-none place-items-center rounded-full transition hover:bg-accent-soft [&_svg]:size-[13px]"
              >
                <X />
              </button>
            </div>
          )}

          {queue.length > 0 && (
            <div class="no-scrollbar flex gap-2 overflow-x-auto border-b border-line px-2.5 py-2.5">
              {queue.map((staged) => (
                <div key={staged.id} class="relative w-[68px] flex-none">
                  <div class="grid h-[54px] place-items-center rounded-[10px] bg-surface text-accent [&_svg]:size-5">
                    <FileTypeIcon mime={staged.mime} />
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${staged.name}`}
                    onClick={() => setQueue((current) => current.filter((f) => f.id !== staged.id))}
                    class="absolute -right-1 -top-1 grid size-[20px] place-items-center rounded-full bg-elevated text-subtle shadow-pop ring-1 ring-line transition hover:text-ink [&_svg]:size-3"
                  >
                    <X />
                  </button>
                  <div class="mt-1 truncate text-meta text-subtle" title={staged.name}>
                    {staged.name}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div class="flex items-end gap-1 px-1.5 py-1.5">
            <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />
            <button
              type="button"
              aria-label="Send as a temporary message"
              title="Temporary message"
              aria-pressed={armed}
              onClick={() => setArmed(!armed)}
              class={cx(
                "grid size-8 flex-none place-items-center rounded-full transition active:scale-90 [&_svg]:size-[18px]",
                armed
                  ? "bg-accent-soft text-accent"
                  : "text-subtle hover:bg-surface hover:text-ink",
              )}
            >
              <CircleDashed />
            </button>
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              aria-label="Try the composer"
              placeholder={
                queue.length > 0
                  ? "Add a comment…"
                  : armed
                    ? "Temporary message"
                    : "Write a message"
              }
              onInput={(e) => {
                setDraft((e.target as HTMLTextAreaElement).value);
                autosize();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              // `max-md:text-lead` for the same reason as the app's composer:
              // under 16px, iOS Safari zooms the viewport on focus and never
              // zooms back out.
              class="no-scrollbar max-h-[96px] flex-1 resize-none self-center border-none bg-transparent px-1 py-1.5 text-note leading-[1.45] text-ink outline-none placeholder:text-muted focus:!shadow-none focus-visible:!shadow-none max-md:text-lead"
            />
            <button
              type="button"
              aria-label="Attach file"
              title="Attach file"
              onClick={() => fileRef.current?.click()}
              class="grid size-8 flex-none place-items-center rounded-full text-subtle transition hover:bg-surface hover:text-ink active:scale-90 [&_svg]:size-[18px]"
            >
              <Paperclip />
            </button>
            <div class="relative flex-none">
              <button
                type="button"
                aria-label="Send message"
                title="Send"
                onClick={send}
                disabled={!canSend}
                class="grid size-8 place-items-center rounded-full bg-accent text-on-accent transition hover:bg-accent-hover active:scale-90 disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted [&_svg]:size-[17px]"
              >
                <ArrowUp strokeWidth={2.5} />
              </button>
              {armed && canSend && (
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute -right-0.5 -top-0.5 grid size-[15px] place-items-center rounded-full bg-elevated text-accent ring-1 ring-line [&_svg]:size-[10px]"
                >
                  <CircleDashed />
                </span>
              )}
            </div>
          </div>
        </div>
        <p class="mt-2 text-center text-meta text-muted">
          A demo of the real app. Nothing leaves this page, and it resets on reload.
        </p>
      </div>
    </div>
  );
}

function PreviewBubble({
  message,
  showSender,
}: {
  message: PreviewMessage;
  showSender: boolean;
}): JSX.Element {
  const { mine, files, text, sealed } = message;

  return (
    <div
      class={cx(
        "flex items-center gap-1",
        showSender ? "mt-[9px]" : "mt-0",
        mine ? "justify-end" : "justify-start",
      )}
    >
      <div
        class={cx(
          "max-w-[86%] rounded-card text-note leading-normal",
          files && !sealed ? "p-[6px]" : "px-[12px] py-[8px]",
          mine
            ? "rounded-br-[5px] bg-bubble text-on-bubble shadow-soft"
            : "surface-card rounded-bl-[5px] text-ink",
        )}
      >
        {showSender && message.sender && (
          <div
            class={cx(
              "mb-1 max-w-full truncate text-meta font-medium leading-tight",
              mine ? "text-on-bubble-muted" : "text-subtle",
            )}
          >
            {message.sender}
          </div>
        )}

        {sealed ? (
          <span class="-mx-1 flex items-center gap-2.5 px-1 py-0.5">
            <span class="grid size-8 flex-none place-items-center rounded-full bg-accent-soft text-accent [&_svg]:size-[17px]">
              <CircleDashed />
            </span>
            <span class="min-w-0 text-left">
              <span class="block font-medium">Temporary</span>
              <span class={cx("block text-meta", mine ? "text-on-bubble-muted" : "text-muted")}>
                Disappears once opened
              </span>
            </span>
          </span>
        ) : (
          <>
            {files && (
              <div class="flex flex-col gap-[3px]">
                {files.map((file) => (
                  <PreviewAttachment key={file.id} file={file} mine={mine} />
                ))}
              </div>
            )}
            {text && (
              <div class={cx("whitespace-pre-wrap break-words", files && "px-1.5 pb-0.5 pt-[7px]")}>
                {text}
              </div>
            )}
          </>
        )}

        <div
          class={cx(
            "mt-1 flex items-center justify-end gap-[5px] font-mono text-meta tracking-[0.03em] [&_svg]:size-[13px]",
            mine ? "text-on-bubble-muted" : "text-muted",
          )}
        >
          <span>{message.time}</span>
          {mine && <CheckCheck />}
        </div>
      </div>
    </div>
  );
}

/** Object URL for a picked image, revoked when the bubble goes away. */
function useThumbnail(blob: File | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [blob]);

  return url;
}

function PreviewAttachment({ file, mine }: { file: PreviewFile; mine: boolean }): JSX.Element {
  const thumbnail = useThumbnail(file.blob);

  return (
    <div
      class={cx(
        "flex min-w-[210px] items-center gap-[10px] rounded-[10px] px-2.5 py-2",
        mine ? "bg-black/15 dark:bg-white/15" : "bg-surface-3",
      )}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" class="size-9 flex-none rounded-[10px] object-cover" />
      ) : (
        <div
          class={cx(
            "grid size-9 flex-none place-items-center rounded-[10px] text-accent [&_svg]:size-[18px]",
            mine ? "bg-white/90" : "bg-surface",
          )}
        >
          <FileTypeIcon mime={file.mime} />
        </div>
      )}
      <div class="min-w-0 flex-1">
        <div class="truncate text-meta font-medium" title={file.name}>
          {file.name}
        </div>
        <div
          class={cx(
            "font-mono text-meta tracking-[0.02em]",
            mine ? "text-on-bubble-muted" : "text-muted",
          )}
        >
          {formatBytes(file.size)}
        </div>
      </div>
      <span
        class={cx(
          "grid size-7 flex-none place-items-center rounded-full [&_svg]:size-[15px]",
          mine ? "text-on-bubble" : "text-muted",
        )}
      >
        <Download />
      </span>
    </div>
  );
}
