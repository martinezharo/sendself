import type { DeviceRole } from "@sendself/shared";
import {
  AlertCircle,
  ClipboardPaste,
  Crown,
  KeyRound,
  Plus,
  ScanLine,
  ShieldCheck,
  UserRound,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type DeviceView,
  addDeviceFromQr,
  listDevicesDecrypted,
  revokeDevice,
  updateDeviceRole,
} from "../actions";
import { type Scanner, startScanner } from "../qr/scan";
import { session } from "../state/session";
import { showToast } from "../state/ui";
import { SecurityPanel } from "./SecurityPanel";
import { Button, Modal, Spinner, cx, initials } from "./components";

export function DeviceManager(): JSX.Element {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<DeviceView | null>(null);
  const [pendingRoleChange, setPendingRoleChange] = useState<DeviceView | null>(null);
  const [currentRole, setCurrentRole] = useState<DeviceRole>("member");
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const [rotationPending, setRotationPending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const myId = session.value?.deviceId;

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const result = await listDevicesDecrypted();
      setDevices(result.devices);
      setCurrentRole(result.currentRole);
      setRotationPending(result.rotationPending);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load devices", "error");
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(device: DeviceView): Promise<void> {
    const nextRole = device.role === "admin" ? "member" : "admin";
    setPendingRoleChange(null);
    setChangingRole(device.id);
    try {
      await updateDeviceRole(device.id, nextRole);
      setDevices((current) =>
        current.map((entry) => (entry.id === device.id ? { ...entry, role: nextRole } : entry)),
      );
      showToast(
        nextRole === "admin"
          ? `${device.name} is now an administrator`
          : `Administrator access removed from ${device.name}`,
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update access", "error");
    } finally {
      setChangingRole(null);
    }
  }

  const canAdminister = currentRole === "owner" || currentRole === "admin";

  useEffect(() => {
    void refresh();
  }, []);

  async function confirmRevoke(device: DeviceView): Promise<void> {
    setPendingRevoke(null);
    setRevoking(true);
    try {
      const { rotated } = await revokeDevice(device.id);
      showToast(rotated ? `Revoked ${device.name} · new key sent` : `Revoked ${device.name}`);
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not revoke device", "error");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-6 max-md:p-[14px]">
      <div class="mx-auto flex max-w-[640px] flex-col gap-[18px]">
        {/* The button drops below the copy on a phone instead of squeezing it
            into a half-width column beside itself. */}
        <div class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-4">
          <div>
            <div class="mb-1 font-mono text-meta font-medium uppercase tracking-[0.18em] text-accent">
              Workspace
            </div>
            <h2 class="text-title-sm font-semibold">Linked devices</h2>
            <p class="mt-1 text-caption leading-5 text-muted">
              Control which of your devices can connect and manage this encrypted space.
            </p>
            {!loading && (
              <KeyStatus
                rotating={rotationPending || revoking}
                waiting={devices.filter((d) => !d.keyUpToDate).length}
              />
            )}
          </div>
          {canAdminister && (
            <Button
              class="flex-none max-sm:!h-[42px] max-sm:!w-full max-sm:!text-body"
              variant="primary"
              size="sm"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
              Add device
            </Button>
          )}
        </div>

        {!loading && !canAdminister && (
          <div class="flex gap-3 rounded-card border border-line bg-surface-2 px-4 py-3.5 text-caption leading-5 text-subtle">
            <UserRound class="mt-0.5 size-4 flex-none text-muted" aria-hidden="true" />
            <p>This device is a member. Ask the space owner to add, remove, or manage devices.</p>
          </div>
        )}

        {loading ? (
          <div class="grid place-items-center py-16">
            <Spinner large />
          </div>
        ) : (
          <div class="flex flex-col gap-2.5">
            {devices.map((device) => (
              <div
                key={device.id}
                class={cx(
                  "surface-card flex items-center gap-3.5 rounded-card px-[15px] py-[13px] transition hover:shadow-pop",
                  device.id === myId && "ring-1 ring-inset ring-accent/35",
                )}
              >
                <div class="grid size-[42px] flex-none place-items-center rounded-xl bg-[linear-gradient(155deg,color-mix(in_srgb,var(--c-accent)_80%,#fff)_0%,var(--c-accent)_55%,color-mix(in_srgb,var(--c-accent)_72%,#000)_100%)] font-mono text-body font-medium text-white ring-1 ring-inset ring-white/20">
                  {initials(device.name)}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2 text-body font-medium">
                    <span class="truncate">{device.name}</span>
                    <RoleBadge role={device.role} />
                  </div>
                  <div class="font-mono text-meta text-muted">
                    {device.id === myId && <span class="text-accent">This device · </span>}
                    Linked {new Date(device.createdAt).toLocaleString()}
                  </div>
                  {!device.keyUpToDate && (
                    <div class="mt-1 flex items-center gap-1.5 text-meta text-amber-600 dark:text-amber-400">
                      <span class="size-1.5 flex-none rounded-full bg-current" />
                      Gets the new key when it reconnects
                    </div>
                  )}
                </div>
                {device.id !== myId && (
                  <div class="flex flex-none items-center gap-2">
                    {currentRole === "owner" && device.role !== "owner" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={changingRole === device.id}
                        onClick={() => setPendingRoleChange(device)}
                      >
                        {changingRole === device.id ? (
                          <Spinner />
                        ) : device.role === "admin" ? (
                          "Make member"
                        ) : (
                          "Make admin"
                        )}
                      </Button>
                    )}
                    {canAdminister &&
                      device.role !== "owner" &&
                      (currentRole === "owner" || device.role === "member") && (
                        <Button variant="danger" size="sm" onClick={() => setPendingRevoke(device)}>
                          Revoke
                        </Button>
                      )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && <SecurityPanel />}
      </div>

      {adding && (
        <AddDeviceModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            showToast("Device authorized. It should link shortly.");
            void refresh();
          }}
        />
      )}

      {pendingRevoke && (
        <Modal title="Revoke this device?" onClose={() => setPendingRevoke(null)}>
          <p class="text-note leading-5 text-subtle">
            <strong class="text-ink">{pendingRevoke.name}</strong> loses access, and this space gets
            a new encryption key so it can't read anything sent from now on.
          </p>
          <div class="flex gap-3 rounded-card border border-line bg-surface-2 px-4 py-3.5">
            <KeyRound class="mt-0.5 size-4 flex-none text-muted" aria-hidden="true" />
            <p class="text-caption leading-5 text-subtle">
              Your other devices stay linked — no need to set them up again. What this device
              already downloaded stays on it.
            </p>
          </div>
          <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <Button class="sm:w-auto" variant="secondary" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button
              class="sm:w-auto"
              variant="danger"
              onClick={() => void confirmRevoke(pendingRevoke)}
            >
              Revoke device
            </Button>
          </div>
        </Modal>
      )}

      {pendingRoleChange && (
        <Modal
          title={
            pendingRoleChange.role === "admin" ? "Remove admin access?" : "Make administrator?"
          }
          onClose={() => setPendingRoleChange(null)}
        >
          <div class="flex gap-3 rounded-card border border-line bg-surface-2 p-3.5">
            <ShieldCheck class="mt-0.5 size-[19px] flex-none text-accent" aria-hidden="true" />
            <p class="text-note leading-5 text-subtle">
              {pendingRoleChange.role === "admin" ? (
                <>
                  <strong class="text-ink">{pendingRoleChange.name}</strong> will remain connected,
                  but will no longer be able to add or revoke devices.
                </>
              ) : (
                <>
                  <strong class="text-ink">{pendingRoleChange.name}</strong> will be able to add new
                  devices and revoke members. Only you, the owner, can manage administrators.
                </>
              )}
            </p>
          </div>
          <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <Button
              class="sm:w-auto"
              variant="secondary"
              onClick={() => setPendingRoleChange(null)}
            >
              Cancel
            </Button>
            <Button
              class="sm:w-auto"
              variant={pendingRoleChange.role === "admin" ? "secondary" : "primary"}
              onClick={() => void changeRole(pendingRoleChange)}
            >
              {pendingRoleChange.role === "admin" ? "Make member" : "Make admin"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * One line on the space's encryption key. Rotation is a background mechanism,
 * so this says only what the user could act on: it is settled, it is in
 * progress, or some device has not picked it up yet.
 */
function KeyStatus({ rotating, waiting }: { rotating: boolean; waiting: number }): JSX.Element {
  const pending = rotating || waiting > 0;
  return (
    <span
      class={cx(
        "mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-medium",
        pending
          ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
          : "bg-success/12 text-success",
      )}
    >
      {rotating ? (
        <Spinner class="!size-3 !border-[1.5px]" />
      ) : pending ? (
        <KeyRound class="size-3.5" aria-hidden="true" />
      ) : (
        <ShieldCheck class="size-3.5" aria-hidden="true" />
      )}
      {rotating
        ? "Updating encryption key…"
        : waiting > 0
          ? `New key pending on ${waiting} ${waiting === 1 ? "device" : "devices"}`
          : "Encryption key up to date"}
    </span>
  );
}

function RoleBadge({ role }: { role: DeviceRole }): JSX.Element {
  const Icon = role === "owner" ? Crown : role === "admin" ? ShieldCheck : UserRound;
  const label = role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
  return (
    <span
      class={cx(
        "inline-flex flex-none items-center gap-1 rounded-full px-2 py-0.5 font-mono text-meta font-medium uppercase tracking-[0.08em]",
        role === "owner"
          ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
          : role === "admin"
            ? "bg-sky-500/12 text-sky-700 dark:text-sky-300"
            : "bg-surface-3 text-muted",
      )}
    >
      <Icon class="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

function AddDeviceModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<"scan" | "paste">("scan");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  async function submit(qrText: string): Promise<void> {
    setBusy(true);
    try {
      await addDeviceFromQr(qrText);
      onAdded();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not add device", "error");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== "scan" || !videoRef.current) return;
    let active = true;
    void import("../qr/scan")
      .then(({ startScanner }) => {
        if (!active || !videoRef.current) return null;
        return startScanner(
          videoRef.current,
          (text) => {
            if (!active) return;
            scannerRef.current?.stop();
            void submit(text);
          },
          (error) => setCameraError(error.message),
        );
      })
      .then((scanner) => {
        if (!scanner) return;
        scannerRef.current = scanner;
        if (!active) scanner.stop();
      })
      .catch((error: unknown) => {
        if (active)
          setCameraError(error instanceof Error ? error.message : "QR scanner unavailable");
      });
    return () => {
      active = false;
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
  }, [tab]);

  return (
    <Modal title="Add a device" onClose={onClose}>
      <div class="flex gap-[3px] rounded-card bg-surface-3 p-[3px]">
        <SegItem active={tab === "scan"} onClick={() => setTab("scan")}>
          <ScanLine />
          Scan QR
        </SegItem>
        <SegItem active={tab === "paste"} onClick={() => setTab("paste")}>
          <ClipboardPaste />
          Paste code
        </SegItem>
      </div>

      {tab === "scan" && (
        <div class="flex flex-col items-center gap-3">
          {cameraError ? (
            // Framed like every other error in the app, instead of a bare line
            // of red text floating in the dialog.
            <div class="flex w-full gap-3 rounded-card border border-danger/25 bg-danger-soft p-3.5 text-danger">
              <AlertCircle class="mt-0.5 size-[19px] flex-none" aria-hidden="true" />
              <p class="text-note font-medium leading-5">
                {cameraError}. Use “Paste code” instead.
              </p>
            </div>
          ) : (
            <video
              ref={videoRef}
              class="aspect-square w-full rounded-card border border-line bg-black object-cover"
              muted
              playsInline
            />
          )}
          {busy && (
            <p class="flex items-center gap-2 text-note text-muted">
              <Spinner /> Authorizing…
            </p>
          )}
        </div>
      )}

      {tab === "paste" && (
        <form
          class="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted.trim()) void submit(pasted.trim());
          }}
        >
          <textarea
            rows={5}
            // The explicit size overrides `.field-input`, so it has to carry
            // the mobile step-up itself or iOS Safari zooms in on focus.
            class="field-input no-scrollbar break-all font-mono text-caption leading-relaxed max-md:text-lead"
            placeholder="Paste the linking code from the new device"
            value={pasted}
            onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)}
          />
          <Button variant="primary" type="submit" disabled={busy || !pasted.trim()}>
            {busy ? <Spinner /> : "Authorize device"}
          </Button>
        </form>
      )}
    </Modal>
  );
}

function SegItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      class={cx(
        "inline-flex flex-1 items-center justify-center gap-[7px] rounded-[10px] py-2 text-note font-medium transition [&_svg]:size-4",
        active ? "bg-surface text-ink shadow-soft" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
