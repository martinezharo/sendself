import { Bell, BellOff, ChevronDown, History } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadMessages } from "../state/messages";
import { loadSpaceEvents } from "../state/events";
import {
  type NotificationsState,
  disableNotifications,
  enableNotifications,
  notificationsState,
} from "../state/notifications";
import {
  RETENTION_OPTIONS,
  historyRetentionDays,
  loadHistoryRetention,
  setHistoryRetention,
} from "../state/retention";
import { showToast } from "../state/ui";
import { Button, Modal, SettingRow, Spinner } from "./components";

/**
 * How this device behaves, as opposed to how it is protected (SecurityPanel):
 * whether it notifies, and how much history it keeps. Both are device-wide —
 * they apply to every space on this device — and sit under the same heading.
 */
export function DevicePreferences(): JSX.Element {
  return (
    <div class="flex flex-col gap-2.5">
      <NotificationsRow />
      <HistoryRow />
    </div>
  );
}

const NOTIFICATION_COPY: Record<NotificationsState, { title: string; body: string }> = {
  on: {
    title: "Notifications on",
    body: "You're told when something arrives while the app is closed. Notifications never show what was sent.",
  },
  off: {
    title: "Notifications off",
    body: "Get told when something arrives while the app is closed. Only that something arrived is shown, never what.",
  },
  blocked: {
    title: "Notifications blocked",
    body: "This browser blocks notifications from SendSelf. Allow them in the site settings, then come back here.",
  },
  unsupported: {
    title: "No notifications here",
    body: "This browser can't show notifications from a web app. On iPhone and iPad, install the app to the Home Screen first.",
  },
  unavailable: {
    title: "No notifications from this server",
    body: "The server this device is linked to isn't set up to send notifications.",
  },
};

function NotificationsRow(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const state = notificationsState.value;
  const copy = NOTIFICATION_COPY[state];

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      if (state === "on") {
        await disableNotifications();
        showToast("Notifications turned off on this device");
      } else {
        await enableNotifications();
        showToast("Notifications turned on for this device");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not change notifications", "error");
    } finally {
      setBusy(false);
    }
  }

  const actionable = state === "on" || state === "off";
  return (
    <SettingRow
      icon={state === "on" ? <Bell /> : <BellOff />}
      title={copy.title}
      body={copy.body}
      tone={state === "on" || !actionable ? "ok" : "warn"}
      action={
        actionable && (
          <Button
            variant={state === "on" ? "secondary" : "primary"}
            size="sm"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {busy && <Spinner />}
            {state === "on" ? "Turn off" : "Turn on"}
          </Button>
        )
      }
    />
  );
}

function retentionLabel(days: number | null): string {
  return RETENTION_OPTIONS.find((option) => option.days === days)?.label ?? "Forever";
}

function HistoryRow(): JSX.Element {
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const days = historyRetentionDays.value;

  useEffect(() => {
    void loadHistoryRetention();
  }, []);

  async function apply(choice: number | null): Promise<void> {
    setPending(undefined);
    setBusy(true);
    try {
      const removed = await setHistoryRetention(choice);
      // The open space may just have lost part of its history.
      await loadMessages();
      await loadSpaceEvents();
      showToast(
        removed > 0
          ? `Kept ${retentionLabel(choice).toLowerCase()} of history — removed ${removed} older ${
              removed === 1 ? "message" : "messages"
            } from this device`
          : `This device now keeps ${retentionLabel(choice).toLowerCase()} of history`,
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not change history", "error");
    } finally {
      setBusy(false);
    }
  }

  function choose(value: string): void {
    const choice = value === "" ? null : Number(value);
    if (choice === days) return;
    // Shortening deletes; lengthening (or "forever") only stops deleting.
    if (choice !== null && (days === null || choice < days)) setPending(choice);
    else void apply(choice);
  }

  return (
    <>
      <SettingRow
        icon={<History />}
        title={
          days === null ? "Keeping all history" : `Keeping ${retentionLabel(days).toLowerCase()}`
        }
        body={
          days === null
            ? "Everything sent and received stays on this device until you delete it or leave the space."
            : "Older messages and files are removed from this device only. Your other devices keep their own copy."
        }
        tone="ok"
        action={
          <label class="relative flex items-center">
            <span class="sr-only">Keep history on this device for</span>
            <select
              class="h-[34px] w-full appearance-none rounded-[10px] border border-line bg-surface-2 pl-3 pr-8 text-note font-medium text-ink transition hover:bg-surface-3 disabled:opacity-60"
              value={days === null ? "" : String(days)}
              disabled={busy}
              onChange={(event) => choose((event.currentTarget as HTMLSelectElement).value)}
            >
              {RETENTION_OPTIONS.map((option) => (
                <option key={option.label} value={option.days === null ? "" : String(option.days)}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown class="pointer-events-none absolute right-2.5 size-4 text-muted" />
          </label>
        }
      />

      {pending !== undefined && pending !== null && (
        <Modal title="Delete older history?" onClose={() => setPending(undefined)}>
          <p class="text-note leading-5 text-subtle">
            Messages and files older than {retentionLabel(pending).toLowerCase()} will be removed
            from this device now, in every space, and from then on as they age. Other devices keep
            their own copy. Messages still waiting to be sent are never removed.
          </p>
          <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <Button class="sm:w-auto" variant="secondary" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button class="sm:w-auto" variant="danger" onClick={() => void apply(pending)}>
              Delete older history
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
