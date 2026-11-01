import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { PasskeyUnsupportedError, passkeySupported } from "../crypto/passkey";
import { MIN_PASSPHRASE_LENGTH } from "../crypto/vault";
import { META_RECOVERY_EPOCH, metaGet } from "../db/store";
import { NoExportableKeysError, createRecoveryFile, recoveryFileName } from "../recovery";
import { disableLock, enableLock, lockConfigured, lockMethod, lockNow } from "../state/lock";
import { keyring, session } from "../state/session";
import { showToast } from "../state/ui";
import { Button, Modal, SettingRow, Spinner } from "./components";

/**
 * Everything about protecting this device's copy of the space: the at-rest lock
 * and the recovery file. They live together because they are two halves of one
 * question — what happens to the space if this device is stolen, and what
 * happens if it is lost.
 */
export function SecurityPanel(): JSX.Element {
  const [setupOpen, setSetupOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [recovery, setRecovery] = useState<{ code: string; url: string; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [exportedEpoch, setExportedEpoch] = useState<number | null>(null);

  const currentEpoch = keyring.value?.current ?? 1;
  const staleBackup = exportedEpoch !== null && exportedEpoch < currentEpoch;

  useEffect(() => {
    void metaGet<number>(META_RECOVERY_EPOCH).then((epoch) => setExportedEpoch(epoch ?? null));
  }, []);

  async function removeLock(): Promise<void> {
    setRemoveOpen(false);
    setBusy(true);
    try {
      await disableLock();
      showToast("Lock removed from this device");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not remove the lock", "error");
    } finally {
      setBusy(false);
    }
  }

  async function exportRecovery(): Promise<void> {
    setBusy(true);
    try {
      const { file, code } = await createRecoveryFile();
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      setRecovery({ code, url: URL.createObjectURL(blob), name: recoveryFileName(file) });
      setExportedEpoch(file.keyEpoch);
    } catch (error) {
      showToast(
        error instanceof NoExportableKeysError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not create a recovery file",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-2.5">
      <h3 class="mt-2 text-body-lg font-semibold">This device</h3>

      <SettingRow
        icon={<LockKeyhole />}
        title={lockConfigured.value ? "Locked when you're away" : "No lock on this device"}
        body={
          lockConfigured.value
            ? `Messages, files and keys are encrypted at rest and need your ${
                lockMethod.value === "passkey" ? "passkey" : "passphrase"
              } after every launch.`
            : "Anyone who can open this browser profile can read everything stored here. A lock encrypts it until you unlock."
        }
        tone={lockConfigured.value ? "ok" : "warn"}
        action={
          lockConfigured.value ? (
            <div class="flex gap-2">
              <Button variant="secondary" size="sm" onClick={lockNow}>
                Lock now
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => setRemoveOpen(true)}
              >
                Remove
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>
              Set a lock
            </Button>
          )
        }
      />

      <SettingRow
        icon={<ShieldCheck />}
        title="Recovery file"
        body={
          exportedEpoch === null
            ? "If every device in this space is lost, the space is gone — nothing on the server can bring it back. A recovery file is the only copy that can."
            : staleBackup
              ? "Your recovery file predates the latest key change, so it opens history but nothing sent since. Create a new one."
              : "Your recovery file is up to date with this space's current key."
        }
        tone={exportedEpoch === null || staleBackup ? "warn" : "ok"}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void exportRecovery()}
          >
            {busy ? <Spinner /> : <Download />}
            {exportedEpoch === null ? "Create" : "Create new"}
          </Button>
        }
      />

      {setupOpen && (
        <SetLockModal
          deviceName={session.value?.deviceName ?? "This device"}
          onClose={() => setSetupOpen(false)}
          onDone={() => {
            setSetupOpen(false);
            showToast("This device is now locked when you're away");
          }}
        />
      )}

      {removeOpen && (
        <Modal title="Remove the lock?" onClose={() => setRemoveOpen(false)}>
          <div class="flex gap-3 rounded-card border border-danger/25 bg-danger-soft p-3.5 text-danger">
            <AlertTriangle class="mt-0.5 size-[19px] flex-none" />
            <p class="text-note font-medium leading-5">
              Messages, files and keys go back to being stored unencrypted on this device.
            </p>
          </div>
          <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <Button class="sm:w-auto" variant="secondary" onClick={() => setRemoveOpen(false)}>
              Keep the lock
            </Button>
            <Button class="sm:w-auto" variant="danger" onClick={() => void removeLock()}>
              Remove it
            </Button>
          </div>
        </Modal>
      )}

      {recovery && (
        <RecoveryModal
          code={recovery.code}
          url={recovery.url}
          name={recovery.name}
          onClose={() => {
            URL.revokeObjectURL(recovery.url);
            setRecovery(null);
          }}
        />
      )}
    </div>
  );
}

function SetLockModal({
  deviceName,
  onClose,
  onDone,
}: {
  deviceName: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE_LENGTH && confirm === passphrase;

  async function apply(run: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await run();
      onDone();
    } catch (error) {
      showToast(
        error instanceof PasskeyUnsupportedError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not set the lock",
        "error",
      );
      setBusy(false);
    }
  }

  return (
    <Modal title="Lock this device" onClose={busy ? undefined : onClose}>
      <p class="text-note leading-5 text-subtle">
        Everything stored here gets encrypted with a key only you can produce. It never reaches the
        server, and your other devices are unaffected.
      </p>

      {passkeySupported() && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void apply(() => enableLock({ method: "passkey", deviceName }))}
        >
          {busy ? <Spinner /> : <Fingerprint />}
          Use this device's passkey
        </Button>
      )}

      <form
        class="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void apply(() => enableLock({ method: "passphrase", passphrase }));
        }}
      >
        <label class="flex flex-col gap-1.5">
          <span class="text-note font-medium text-subtle">Passphrase or PIN</span>
          <input
            type="password"
            class="field-input"
            autoComplete="new-password"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-note font-medium text-subtle">Repeat it</span>
          <input
            type="password"
            class="field-input"
            autoComplete="new-password"
            value={confirm}
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
          />
        </label>
        {(tooShort || mismatch) && (
          <p class="text-caption text-danger">
            {tooShort
              ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`
              : "Those don't match yet."}
          </p>
        )}
        <div class="flex gap-3 rounded-card border border-amber-500/25 bg-amber-500/10 p-3.5">
          <AlertTriangle
            class="mt-0.5 size-4 flex-none text-amber-600 dark:text-amber-300"
            aria-hidden="true"
          />
          <p class="text-caption leading-5 text-subtle">
            There is no reset. If you forget it, this device's copy is unreadable — link it again
            from another device, or restore from a recovery file.
          </p>
        </div>
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          {busy ? <Spinner /> : "Lock this device"}
        </Button>
      </form>
    </Modal>
  );
}

function RecoveryModal({
  code,
  url,
  name,
  onClose,
}: {
  code: string;
  url: string;
  name: string;
  onClose: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Couldn't copy to clipboard", "error");
    }
  }

  return (
    <Modal title="Your recovery file" onClose={onClose}>
      <p class="text-note leading-5 text-subtle">
        Save both. The file is useless without the code, and the code is useless without the file.
      </p>

      <div class="flex flex-col gap-2">
        <span class="text-note font-medium text-subtle">Recovery code</span>
        <code class="select-all break-all rounded-card bg-surface-3 px-3.5 py-3 font-mono text-note leading-6 tracking-[0.06em]">
          {code}
        </code>
        <Button variant="secondary" size="sm" class="self-start" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>

      <div class="flex gap-3 rounded-card border border-amber-500/25 bg-amber-500/10 p-3.5">
        <AlertTriangle
          class="mt-0.5 size-4 flex-none text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <p class="text-caption leading-5 text-subtle">
          This code is shown once and stored nowhere. Anyone holding both the file and the code has
          full access to this space — keep them somewhere you would keep a password.
        </p>
      </div>

      <a
        href={url}
        download={name}
        onClick={() => setDownloaded(true)}
        class="inline-flex h-[42px] w-full items-center justify-center gap-2 rounded-card bg-accent px-4 text-body font-medium text-on-accent shadow-accent transition hover:bg-accent-hover [&_svg]:size-[18px]"
      >
        <Download />
        Download recovery file
      </a>
      <Button variant="ghost" onClick={onClose}>
        {downloaded ? "Done" : "Close without saving"}
      </Button>
    </Modal>
  );
}
