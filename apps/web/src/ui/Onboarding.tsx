import { Check, ChevronRight, Copy, LifeBuoy, Link2, Plus, ShieldCheck } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cancelLinking, createSpace, linking, startLinking } from "../actions";
import { solveSpaceChallenge } from "../challenge";
import { restoreFromRecoveryFile } from "../recovery";
import { navigate, spacePath } from "../state/route";
import { showToast } from "../state/ui";
import { Button, Spinner } from "./components";

type Mode = "choose" | "create" | "link" | "restore";

/**
 * The panel that brings a space onto this device: create a new one, link to one
 * that exists, or restore one from a recovery file. Shown on `/app`, which is
 * where spaces live.
 */
export function OnboardingCard(): JSX.Element {
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const challengeRef = useRef<HTMLDivElement>(null);
  const link = linking.value;

  async function onCreate(): Promise<void> {
    if (!name.trim() || !challengeRef.current) return;
    setBusy(true);
    try {
      // Solved before anything is set up locally, so a failed challenge leaves
      // nothing behind to clean up.
      const challengeToken = await solveSpaceChallenge(challengeRef.current);
      const space = await createSpace(name.trim(), spaceName, challengeToken);
      navigate(spacePath(space.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create space", "error");
    } finally {
      setBusy(false);
    }
  }

  async function onStartLink(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await startLinking(name.trim());
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not start linking", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      id="get-started"
      class="surface-card w-full scroll-mt-24 rounded-xl3 p-7 !shadow-float max-md:rounded-xl2 max-md:p-6"
    >
      {mode === "choose" && (
        <>
          <header class="mb-6">
            <span class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 font-mono text-meta font-medium uppercase tracking-[0.14em] text-accent [&_svg]:size-3.5">
              <ShieldCheck />
              Encrypted before upload
            </span>
            <h2 class="mt-3.5 text-title-lg tracking-[-0.02em]">
              Your private space for every device
            </h2>
            <p class="mt-1.5 text-body leading-relaxed text-muted">
              Create a private space or link this device to one you already have. No account or
              server password needed.
            </p>
          </header>
          <div class="flex flex-col gap-2.5">
            <Choice
              icon={<Plus />}
              title="Create a new space"
              desc="Start fresh on this device"
              onClick={() => setMode("create")}
            />
            <Choice
              icon={<Link2 />}
              title="Link to an existing space"
              desc="Join from another device"
              onClick={() => setMode("link")}
            />
            <Choice
              icon={<LifeBuoy />}
              title="Restore from a recovery file"
              desc="Lost every device? Use your backup"
              onClick={() => setMode("restore")}
            />
          </div>
        </>
      )}

      {mode === "create" && (
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <header class="mb-1">
            <h2 class="text-title-lg tracking-[-0.02em]">Create a private space</h2>
            <p class="mt-1.5 text-body leading-relaxed text-muted">
              Name the space and this device to get started — no account required.
            </p>
          </header>
          <TextField
            label="Space name"
            hint="Optional"
            value={spaceName}
            onInput={setSpaceName}
            placeholder="e.g. Personal"
            autoFocus
          />
          <TextField
            label="Name this device"
            value={name}
            onInput={setName}
            placeholder="e.g. My laptop"
          />
          {/* Empty unless Turnstile needs an interaction to tell a person apart. */}
          <div ref={challengeRef} class="empty:hidden" />
          <div class="mt-1 flex flex-col gap-2">
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? <Spinner /> : "Create space"}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setMode("choose")}>
              Back
            </Button>
          </div>
        </form>
      )}

      {mode === "restore" && <RestoreFlow onBack={() => setMode("choose")} />}

      {mode === "link" && (
        <>
          {!link && (
            <header class="mb-4">
              <h2 class="text-title-lg tracking-[-0.02em]">Link this device</h2>
              <p class="mt-1.5 text-body leading-relaxed text-muted">
                Name this device, then scan the code from one already in the space.
              </p>
            </header>
          )}
          <LinkFlow
            name={name}
            setName={setName}
            busy={busy}
            onStart={onStartLink}
            onBack={() => setMode("choose")}
          />
        </>
      )}
    </div>
  );
}

/**
 * The way back into a space whose devices are all gone. It asks for the file
 * *and* the code because either one alone is useless — which is the property
 * that makes it safe to keep the file in cloud storage.
 */
function RestoreFlow({ onBack }: { onBack: () => void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function restore(): Promise<void> {
    if (!file) return;
    setBusy(true);
    try {
      await restoreFromRecoveryFile(await file.text(), code);
      showToast("Space restored on this device");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not restore", "error");
      setBusy(false);
    }
  }

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void restore();
      }}
    >
      <header class="mb-1">
        <h2 class="text-title-lg tracking-[-0.02em]">Restore a space</h2>
        <p class="mt-1.5 text-body leading-relaxed text-muted">
          Pick the recovery file you saved and enter its code. This device takes over the identity
          the file was exported from.
        </p>
      </header>

      <label class="flex flex-col gap-1.5 text-left">
        <span class="text-note font-medium text-subtle">Recovery file</span>
        <input
          type="file"
          accept="application/json,.json"
          class="field-input file:mr-3 file:rounded-[8px] file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-note file:font-medium"
          onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
        />
      </label>

      <label class="flex flex-col gap-1.5 text-left">
        <span class="text-note font-medium text-subtle">Recovery code</span>
        <input
          type="text"
          class="field-input font-mono tracking-[0.06em]"
          placeholder="XXXX-XXXX-XXXX-…"
          autoComplete="off"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value)}
        />
      </label>

      <div class="mt-1 flex flex-col gap-2">
        <Button variant="primary" type="submit" disabled={busy || !file || !code.trim()}>
          {busy ? <Spinner /> : "Restore space"}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </form>
  );
}

function Choice({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  desc: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      class="group flex w-full items-center gap-3.5 rounded-card bg-surface-3 px-4 py-[15px] text-left transition hover:shadow-pop hover:ring-1 hover:ring-inset hover:ring-accent/40 active:translate-y-px"
    >
      <span class="grid size-[42px] flex-none place-items-center rounded-[10px] bg-accent-soft text-accent [&_svg]:size-[21px]">
        {icon}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-body font-semibold">{title}</span>
        <span class="block text-caption text-muted">{desc}</span>
      </span>
      <ChevronRight class="size-[18px] flex-none text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </button>
  );
}

function TextField({
  label,
  hint,
  value,
  onInput,
  placeholder,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onInput: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5 text-left">
      <span class="flex items-baseline justify-between gap-2 text-note font-medium text-subtle">
        {label}
        {hint && <span class="text-meta font-normal text-muted">{hint}</span>}
      </span>
      <input
        type="text"
        class="field-input"
        value={value}
        placeholder={placeholder}
        maxLength={64}
        autoFocus={autoFocus}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

interface LinkFlowProps {
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  onStart: () => void;
  onBack: () => void;
}

function LinkFlow({ name, setName, busy, onStart, onBack }: LinkFlowProps): JSX.Element {
  const link = linking.value;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link) return;
    let active = true;
    void import("../qr/generate")
      .then(({ renderQrToCanvas }) => {
        if (active && canvasRef.current) return renderQrToCanvas(canvasRef.current, link.qrText);
        return undefined;
      })
      .catch(() => {
        if (active) showToast("Could not render the linking code", "error");
      });
    return () => {
      active = false;
    };
  }, [link?.qrText]);

  if (!link) {
    return (
      <form
        class="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
      >
        <TextField
          label="Name this device"
          value={name}
          onInput={setName}
          placeholder="e.g. My phone"
          autoFocus
        />
        <div class="mt-1 flex flex-col gap-2">
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : "Generate linking code"}
          </Button>
          <Button variant="ghost" type="button" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    );
  }

  const qrText = link.qrText;

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(qrText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Couldn't copy to clipboard", "error");
    }
  }

  return (
    <div class="flex flex-col items-center gap-5 text-center">
      <p class="text-body leading-relaxed text-subtle">
        On a device already in the space, open{" "}
        <strong class="text-ink">Devices → Add device</strong> and scan this code.
      </p>
      <div class="rounded-xl2 bg-white p-4 shadow-pop">
        <canvas ref={canvasRef} class="block rounded-lg" />
      </div>

      {link.status === "error" ? (
        <p class="inline-flex items-center gap-2 rounded-full bg-danger-soft px-3.5 py-2 text-note text-danger">
          Linking failed: {link.error}
        </p>
      ) : (
        <span class="inline-flex items-center gap-2.5 rounded-full bg-surface-3 px-3.5 py-2 font-mono text-meta font-medium uppercase tracking-[0.14em] text-subtle">
          <Spinner /> Waiting for device
        </span>
      )}

      <div class="flex w-full flex-col gap-2">
        <Button variant="secondary" type="button" onClick={() => void copyCode()}>
          {copied ? (
            <>
              <Check /> Code copied
            </>
          ) : (
            <>
              <Copy /> Can&apos;t scan? Copy code
            </>
          )}
        </Button>
        <Button variant="ghost" type="button" onClick={() => void cancelLinking()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
