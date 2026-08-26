import {
  AlertTriangle,
  ArrowLeft,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  MonitorSmartphone,
  MoreVertical,
  Pencil,
} from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { leaveSpace, resumeAfterUnlock } from "../actions";
import { UNNAMED_SPACE } from "../db/spaces";
import { lockConfigured, lockNow, locked } from "../state/lock";
import {
  APP_PATH,
  type SpaceSection,
  followLink,
  navigate,
  route,
  spacePath,
} from "../state/route";
import { ready, session, sessionRevoked, startupError } from "../state/session";
import { activeSpace } from "../state/spaces";
import { type ConnectionState, connection } from "../state/ui";
import { renameActiveSpace } from "../sync/spaceName";
import { Chat } from "./Chat";
import { DeviceManager } from "./DeviceManager";
import { DropZone } from "./DropZone";
import { Landing } from "./Landing";
import { LockScreen } from "./LockScreen";
import { Menu, type MenuAnchor, MenuItem, MenuSeparator, anchorBelow } from "./Menu";
import { Spaces } from "./Spaces";
import { Button, IconButton, Loading, Modal, Toasts, cx } from "./components";

const SECTIONS: Array<{ id: SpaceSection; label: string; icon: typeof MessagesSquare }> = [
  { id: "chat", label: "Messages", icon: MessagesSquare },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
];

function sectionLabel(section: SpaceSection): string {
  return SECTIONS.find((entry) => entry.id === section)?.label ?? "";
}

export function App(): JSX.Element {
  return (
    <>
      <CurrentView />
      {/* Outside the view switch: a file dropped on the landing or while the
          session is still loading must not navigate the app away either. */}
      <DropZone />
    </>
  );
}

function CurrentView(): JSX.Element {
  const current = route.value;

  // The marketing page is static and needs nothing loaded, so it renders before
  // (and regardless of) anything IndexedDB has to say.
  if (current.name === "landing") return <Landing />;

  if (startupError.value) return <StartupError message={startupError.value} />;

  if (!ready.value) return <Loading />;

  // A locked device has nothing loaded to show: every space's session and every
  // stored message are ciphertext until the secret arrives.
  if (locked.value) return <LockScreen onUnlocked={() => void resumeAfterUnlock()} />;

  if (current.name === "spaces") return <Spaces />;

  const space = activeSpace.value;
  // Opening a space is asynchronous (storage, and possibly the vault), and a
  // route change lands here first.
  if (!space || space.id !== current.spaceId || !session.value) return <Loading />;

  return <SpaceView section={current.section} />;
}

function StartupError({ message }: { message: string }): JSX.Element {
  return (
    <div class="bg-grad grid min-h-full place-items-center p-6">
      <section
        role="alert"
        class="surface-card w-full max-w-[480px] rounded-xl3 p-7 text-center !shadow-float max-md:p-6"
      >
        <div class="mx-auto grid size-12 place-items-center rounded-[14px] bg-danger-soft text-danger [&_svg]:size-6">
          <AlertTriangle />
        </div>
        <h1 class="mt-5 font-display text-display font-semibold tracking-[-0.025em]">
          Secure connection required
        </h1>
        <p class="mt-3 text-body leading-6 text-subtle">{message}</p>
        <p class="mt-3 text-note leading-5 text-muted">
          For local development, open the app through <code>http://localhost</code> or configure
          HTTPS for the host you are using.
        </p>
        <Button class="mt-6" variant="secondary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </section>
    </div>
  );
}

function SpaceView({ section }: { section: SpaceSection }): JSX.Element {
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const space = activeSpace.value;
  const spaceName = space?.name ?? UNNAMED_SPACE;
  const spaceId = space?.id ?? "";

  const confirmLeave = async (): Promise<void> => {
    setConfirmLeaveOpen(false);
    await leaveSpace();
  };

  return (
    <div class="bg-grad flex h-full">
      {/* Desktop sidebar: the nav lists the places that hold content, and the
          actions on the space itself hang off the name they act on. */}
      <aside class="hidden w-[248px] flex-none flex-col border-r border-line bg-[color-mix(in_srgb,var(--c-surface)_55%,transparent)] pb-[14px] backdrop-blur-xl md:flex">
        {/* Same height and same rule as the view header on the right, so the two
            read as one band across the top rather than two headers 15px apart. */}
        <div class="flex h-[60px] flex-none items-center gap-0.5 border-b border-line px-[10px]">
          <BackLink to={APP_PATH} label="All spaces" />
          {/* The name is its own rename shortcut: the pencil is only a hover
              hint, so the menu beside it stays the discoverable path. */}
          <button
            type="button"
            title={`Rename ${spaceName}`}
            onClick={() => setRenaming(true)}
            class="group mr-auto flex min-w-0 items-center gap-1.5 rounded-[10px] px-1.5 py-[7px] text-left transition hover:bg-surface-3"
          >
            <span class="truncate font-display text-body-lg font-semibold tracking-[-0.022em]">
              {spaceName}
            </span>
            <Pencil class="size-[13px] flex-none text-muted opacity-0 transition group-hover:opacity-100" />
          </button>
          <SpaceMenuButton
            spaceId={spaceId}
            onRename={() => setRenaming(true)}
            onLeave={() => setConfirmLeaveOpen(true)}
          />
        </div>

        <nav class="flex flex-col gap-[3px] px-[14px] pt-[14px]">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <NavItem key={id} active={section === id} href={spacePath(spaceId, id)}>
              <Icon />
              {label}
            </NavItem>
          ))}
        </nav>

        <ConnectionBadge />
      </aside>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top bar. The space is a stack rather than a switch: the chat
            is the space, and a section is stepped into and backed out of, so
            the same arrow always means "one level up". */}
        <header class="sticky top-0 z-20 flex h-[calc(56px+env(safe-area-inset-top))] flex-none items-center justify-between gap-2 border-b border-line bg-[color-mix(in_srgb,var(--c-surface)_80%,transparent)] px-[10px] pt-[env(safe-area-inset-top)] backdrop-blur-xl md:hidden">
          <div class="flex min-w-0 items-center gap-0.5">
            {section === "chat" ? (
              <BackLink to={APP_PATH} label="All spaces" />
            ) : (
              <BackLink to={spacePath(spaceId)} label={`Back to ${spaceName}`} />
            )}
            <span class="truncate px-1.5 font-display text-body-lg font-semibold tracking-[-0.022em]">
              {section === "chat" ? spaceName : sectionLabel(section)}
            </span>
          </div>
          {section === "chat" && (
            <SpaceMenuButton
              spaceId={spaceId}
              showDevices
              onRename={() => setRenaming(true)}
              onLeave={() => setConfirmLeaveOpen(true)}
            />
          )}
        </header>

        {/* Desktop view header */}
        <div class="hidden h-[60px] flex-none items-center justify-between gap-3 border-b border-line px-6 md:flex">
          <div class="font-display text-title-sm font-semibold tracking-[-0.022em]">
            {sectionLabel(section)}
          </div>
        </div>

        <main class="flex min-h-0 flex-1 flex-col">
          {section === "chat" ? <Chat /> : <DeviceManager />}
        </main>
      </div>

      {renaming && <RenameSpaceModal name={spaceName} onClose={() => setRenaming(false)} />}

      {confirmLeaveOpen && (
        <Modal title="Leave this space?" onClose={() => setConfirmLeaveOpen(false)}>
          <div class="flex gap-3 rounded-card border border-danger/25 bg-danger-soft p-3.5 text-danger">
            <AlertTriangle class="mt-0.5 size-[19px] flex-none" />
            <p class="text-note font-medium leading-5">
              This will remove the space, messages, files, and encryption keys from this device.
            </p>
          </div>
          <p class="text-note leading-5 text-subtle">
            Other devices in the space will keep their access, and your other spaces on this device
            are untouched. You can link this device again later from another device.
          </p>
          <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <Button
              class="sm:w-auto"
              variant="secondary"
              onClick={() => setConfirmLeaveOpen(false)}
            >
              Stay
            </Button>
            <Button class="sm:w-auto" variant="danger" onClick={() => void confirmLeave()}>
              Leave space
            </Button>
          </div>
        </Modal>
      )}

      {sessionRevoked.value && <RevokedNotice />}

      <Toasts />
    </div>
  );
}

/** One level up: out of a section into the space, or out of the space into the list. */
function BackLink({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <a
      href={to}
      aria-label={label}
      title={label}
      onClick={(event) => followLink(event as unknown as MouseEvent, to)}
      class="inline-flex size-[38px] flex-none items-center justify-center rounded-[10px] text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-90 [&_svg]:size-[19px]"
    >
      <ArrowLeft />
    </a>
  );
}

/**
 * Everything a space can do, behind one visible button — the single list both
 * breakpoints share, so an action is never added to one and forgotten in the
 * other. There is no hover on a phone, so no action may depend on one.
 * `showDevices` is for the mobile bar, which has no nav to reach it by.
 */
function SpaceMenuButton({
  spaceId,
  showDevices = false,
  onRename,
  onLeave,
}: {
  spaceId: string;
  showDevices?: boolean;
  onRename: () => void;
  onLeave: () => void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  const run = (action: () => void) => (): void => {
    setAnchor(null);
    action();
  };

  return (
    <>
      <IconButton
        label="Space options"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchorBelow(event.currentTarget as HTMLElement))}
      >
        <MoreVertical />
      </IconButton>

      {anchor && (
        <Menu anchor={anchor} alignRight label="Space options" onClose={() => setAnchor(null)}>
          {showDevices && (
            <MenuItem
              icon={<MonitorSmartphone />}
              onClick={run(() => navigate(spacePath(spaceId, "devices")))}
            >
              Devices
            </MenuItem>
          )}
          <MenuItem icon={<Pencil />} onClick={run(onRename)}>
            Rename space
          </MenuItem>
          {lockConfigured.value && (
            <MenuItem icon={<LockKeyhole />} onClick={run(lockNow)}>
              Lock this device
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem danger icon={<LogOut />} onClick={run(onLeave)}>
            Leave space
          </MenuItem>
        </Menu>
      )}
    </>
  );
}

function RenameSpaceModal({ name, onClose }: { name: string; onClose: () => void }): JSX.Element {
  const [value, setValue] = useState(activeSpace.value?.name ?? "");

  const save = async (): Promise<void> => {
    await renameActiveSpace(value);
    onClose();
  };

  return (
    <Modal title="Rename space" onClose={onClose}>
      <form
        class="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label class="flex flex-col gap-1.5 text-left">
          <span class="text-note font-medium text-subtle">Space name</span>
          <input
            type="text"
            class="field-input"
            value={value}
            placeholder={name}
            maxLength={64}
            autoFocus
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        </label>
        <p class="text-caption leading-5 text-muted">
          Every device in this space will use this name. It is encrypted before it leaves this one,
          so only your devices can read it.
        </p>
        <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <Button class="sm:w-auto" variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button class="sm:w-auto" variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Terminal state: the server no longer accepts this device. Nothing in this
 * space works from here, so the notice is not dismissable — the only way out is
 * to leave the space, which is also how it can be linked again.
 */
function RevokedNotice(): JSX.Element {
  return (
    <Modal title="This device is no longer linked">
      <div class="flex gap-3 rounded-card border border-danger/25 bg-danger-soft p-3.5 text-danger">
        <AlertTriangle class="mt-0.5 size-[19px] flex-none" />
        <p class="text-note font-medium leading-5">
          Its access was revoked from another device, or the space no longer exists. Messages and
          files can't be sent or received until you link it again.
        </p>
      </div>
      <p class="text-note leading-5 text-subtle">
        Linking again starts a new session on this device: the messages, files and encryption keys
        stored here for this space are removed first.
      </p>
      <div class="flex justify-end">
        <Button class="sm:w-auto" variant="danger" onClick={() => void leaveSpace()}>
          Leave and link again
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The foot of the sidebar: what this device's link to the others is doing.
 *
 * Three states rather than two, because "not offline" is not the same as
 * "delivering". `connecting` is the honest middle — the browser has a network
 * but the push channel is down (server unreachable, proxy eating WebSockets,
 * backoff between retries), and messages are moving on the polling fallback if
 * they are moving at all. The title says that in words for the case where it
 * persists.
 */
const CONNECTION_COPY: Record<ConnectionState, { label: string; dot: string; title: string }> = {
  connected: {
    label: "Connected",
    dot: "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--c-success)_22%,transparent)]",
    title: "Live: new messages arrive as they are sent",
  },
  connecting: {
    label: "Connecting",
    dot: "animate-pulse bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--c-warning)_22%,transparent)]",
    title: "Reaching the server. Messages still sync, but with a delay",
  },
  offline: {
    label: "Offline",
    dot: "bg-muted",
    title: "No network. Anything you send waits on this device",
  },
};

function ConnectionBadge(): JSX.Element {
  const { label, dot, title } = CONNECTION_COPY[connection.value];
  return (
    <div
      title={title}
      class="mt-auto flex items-center gap-2.5 px-[25px] pt-2 font-mono text-meta font-medium uppercase tracking-[0.14em] text-muted"
    >
      <span aria-hidden="true" class={cx("size-2 flex-none rounded-full", dot)} />
      <span role="status">{label}</span>
    </div>
  );
}

/**
 * A sidebar entry. Every one of them points at a section that holds content,
 * so they are real links — navigable, bookmarkable and middle-clickable.
 * Actions on the space live in the menu beside its name, not here.
 */
function NavItem({
  active,
  href,
  children,
}: {
  active?: boolean;
  href: string;
  children: preact.ComponentChildren;
}): JSX.Element {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => followLink(event as unknown as MouseEvent, href)}
      class={cx(
        "flex w-full items-center gap-[11px] rounded-[10px] px-[11px] py-[9px] text-left text-body font-medium transition [&_svg]:size-[18px] [&_svg]:flex-none [&_svg]:opacity-85",
        active
          ? "bg-accent-soft text-accent [&_svg]:opacity-100"
          : "text-subtle hover:bg-surface-3 hover:text-ink",
      )}
    >
      {children}
    </a>
  );
}
