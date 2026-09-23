import { Download, WifiOff } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { installOption, promptInstall } from "../pwa";
import { Button, Modal } from "./components";

interface InstallApp {
  /** This device can install the app and has not yet. */
  available: boolean;
  install: () => void;
  /** The steps, while they are on screen; render it wherever the trigger lives. */
  dialog: JSX.Element | null;
}

/**
 * Installing the app, from whichever control offers it.
 *
 * Where the browser can be asked, the button asks it. Elsewhere it explains
 * the one step the reader has to take in the browser's own UI — the step
 * differs per browser, so a generic "use your menu" would not do.
 */
export function useInstallApp(): InstallApp {
  const [hint, setHint] = useState<string | null>(null);
  const option = installOption.value;

  const install = (): void => {
    if (!option) return;
    if (option.kind === "prompt") void promptInstall();
    else setHint(option.hint);
  };

  return {
    available: option !== null,
    install,
    dialog: hint ? <InstallSteps hint={hint} onClose={() => setHint(null)} /> : null,
  };
}

function InstallSteps({ hint, onClose }: { hint: string; onClose: () => void }): JSX.Element {
  return (
    <Modal title="Install SendSelf" onClose={onClose}>
      <p class="text-note leading-5 text-subtle">
        Installed, SendSelf opens like any other app and keeps this device's history available
        offline.
      </p>
      <div class="flex gap-3 rounded-card bg-accent-soft p-3.5 text-ink">
        <Download class="mt-0.5 size-[19px] flex-none text-accent" />
        <p class="text-note font-medium leading-5">{hint}</p>
      </div>
      <p class="flex gap-2 text-caption leading-5 text-muted">
        <WifiOff class="mt-0.5 size-3.5 flex-none" />
        Sending and receiving still need a connection; anything you send offline waits until you are
        back.
      </p>
      <Button variant="primary" onClick={onClose}>
        Got it
      </Button>
    </Modal>
  );
}
