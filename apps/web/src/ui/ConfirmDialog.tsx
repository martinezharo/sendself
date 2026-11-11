import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, Modal } from "./components";

/** A confirmation with shared pending state and customizable content. */
export function ConfirmDialog({
  title,
  action,
  cancel = "Cancel",
  variant = "danger",
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  action: string;
  cancel?: string;
  variant?: "primary" | "secondary" | "danger";
  onClose: () => void;
  onConfirm: () => Promise<void>;
  children: ComponentChildren;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <Button class="sm:w-auto" variant="secondary" onClick={onClose}>
          {cancel}
        </Button>
        <Button
          class="sm:w-auto"
          variant={variant}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}
