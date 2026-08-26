import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { AlertCircle, CheckCircle2, X } from "lucide-preact";
import { toasts } from "../state/ui";

/** Tiny className joiner. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function initials(name: string | undefined | null): string {
  const parts = (name ?? "").trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/* --------------------------------------------------------------------------
   Button
   ------------------------------------------------------------------------ */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-card font-medium tracking-[-0.01em] whitespace-nowrap transition active:scale-[0.995] disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:size-[18px]";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent shadow-accent hover:bg-accent-hover active:bg-accent-press",
  secondary: "bg-surface border border-line-strong text-ink hover:bg-surface-3",
  ghost: "bg-transparent text-subtle hover:bg-surface-3 hover:text-ink",
  danger: "bg-transparent text-danger border border-danger/35 hover:bg-danger-soft",
};

interface ButtonProps extends Omit<JSX.IntrinsicElements["button"], "size"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
}

export function Button({
  variant = "secondary",
  size = "md",
  class: cls,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      class={cx(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant],
        size === "sm"
          ? "h-[34px] w-auto px-3 text-note rounded-[10px]"
          : "h-[42px] w-full px-4 text-body",
        cls as string,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------------
   Icon button
   ------------------------------------------------------------------------ */
type IconButtonProps = JSX.IntrinsicElements["button"] & { label: string };

export function IconButton({ label, class: cls, children, ...rest }: IconButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      class={cx(
        "inline-flex items-center justify-center size-[38px] rounded-[10px] text-subtle transition hover:bg-surface-3 hover:text-ink active:scale-90 disabled:opacity-40 disabled:cursor-not-allowed [&_svg]:size-[19px]",
        cls as string,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------------
   Brand mark

   The SendSelf glyph, inlined rather than loaded from `/sendself-logo.svg`.
   An <img> could not inherit `currentColor`, so every placement that needs the
   mark in a different colour (accent tile, ink header, muted footer) would need
   its own file. One path, coloured by CSS, is the maintainable shape of this.
   ------------------------------------------------------------------------ */
export function BrandMark(props: JSX.SVGAttributes<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 1095 1095" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        d="M299.51 540.5C300.64 535.98 300.34 531.2 300.32 526.5C300.27 505.29 295.46 475.47 319.79 465.35C339.38 457.2 351.13 471.67 363.47 484.03C391.59 512.23 420.92 539.27 448.8 567.71C459.19 578.31 477.02 590.21 476.42 606.5C475.98 618.51 466.46 625.44 458.17 632.66C442.33 646.45 427.53 661.4 411.74 675.24C403.4 682.54 395.76 690.62 387.51 698C380.13 704.6 372.57 711.08 365.45 717.96C358.77 724.4 349.02 735.35 341.03 739.53C325.88 747.45 307.75 737.43 302.25 722.3C299.61 715.06 300.27 707.06 300.29 699.5C300.32 686.83 300.15 674.16 300.28 661.5C294.33 659.77 287.71 660.33 281.5 659.88C272.49 659.22 263.34 657.91 254.54 655.87C220.06 647.86 188.2 631.04 161.2 608.32C145.34 594.97 131.12 579.05 119.77 561.72C58.48 468.08 81.9 343.51 143.66 256.19C158.86 234.7 176.55 215.18 196.02 197.5C235.96 161.25 287.99 136.2 341.18 127.55C369.77 122.9 398.62 123.14 427.5 123.2C455.83 123.26 484.17 123.11 512.5 123.31C560.16 123.66 607.84 123.18 655.5 123.21C689.37 123.23 722.96 122.22 756.44 128.28C856.2 146.36 937.58 218.1 979.7 308.77C993.03 337.45 1003.36 369.18 1007.71 400.55C1010.98 424.13 1010.99 447.74 1011.04 471.5C1011.08 492.17 1011.05 512.83 1011.04 533.5C1011.02 563.83 1011.06 594.17 1010.99 624.5C1010.94 648.25 1011.48 671.93 1007.77 695.47C994.68 778.43 941.69 862.25 868.75 905.27C835.5 924.89 799.5 940.1 761.25 946.59C730.1 951.87 699.93 951.49 668.5 951.36C643.5 951.25 618.5 951.52 593.5 951.44C516.16 951.2 438.84 951.61 361.5 951.49C351.5 951.48 341.5 951.47 331.5 951.5C306.65 951.57 287.84 949.78 273.67 926.79C256.67 899.2 273.06 864.38 302.59 855.18C311.04 852.54 319.76 853.05 328.5 853.07C340.17 853.1 351.83 853.17 363.5 853.15C448.5 853.04 533.5 853.11 618.5 853.12C638.17 853.12 657.83 853.1 677.5 853.07C689.09 853.05 700.94 853.81 712.5 852.89C730.37 851.46 748.72 847.48 765.41 840.88C830.97 814.96 882.83 757.3 896.74 687.41C901.24 664.79 900.16 641.43 900.13 618.5C900.1 589.17 900.11 559.83 900.13 530.5C900.14 506.83 900.14 483.17 900.11 459.5C900.06 427.73 899.57 398.06 888.71 367.74C880.81 345.66 870.9 327.07 857.87 307.66C832.25 269.49 787.85 237.9 743.47 226.07C713.47 218.07 682.24 219.86 651.5 219.96C607.84 220.1 564.16 220.14 520.5 219.92C493.83 219.78 467.17 220.01 440.5 219.95C416.98 219.9 393.79 219.19 370.55 223.23C325.87 231 284.13 257.26 254 290.53C222.67 325.14 199.83 371.06 199.17 418.5C198.44 470.59 226.06 520.25 277.33 536.25C284.56 538.51 291.89 540.27 299.51 540.5ZM591.77 484.47C601.29 483.84 610.96 484.46 620.5 484.41C642.83 484.29 665.17 484.35 687.5 484.38C707.22 484.4 726.95 482.08 744.37 493.09C755.83 500.34 765.24 512.41 768.94 525.54C773.15 540.48 771.15 558.99 771.1 574.5C771.04 593.5 771.03 612.5 771.11 631.5C771.21 657.82 772.57 681.22 748.89 698.41C733.76 709.38 719.51 709.47 701.5 709.44C691.83 709.42 682.17 709.31 672.5 709.31C654.5 709.3 636.5 709.23 618.5 709.37C590.41 709.58 566.19 711.05 548.68 684.79C535.87 665.6 538.98 641.41 538.96 619.5C538.95 600.83 538.95 582.17 538.95 563.5C538.95 551.01 538.09 538.04 541.45 525.87C547.54 503.82 568.99 485.96 591.77 484.47Z"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Brand logo
   ------------------------------------------------------------------------ */
export function Logo({ size = "md" }: { size?: "md" | "lg" }): JSX.Element {
  const lg = size === "lg";
  return (
    <span class="inline-flex items-center gap-2.5 text-ink">
      {/* The mark carries its own rounded silhouette and enclosed counters, so
          it is set on the page rather than inside the gradient tile the flat
          shield needed. Boxing it shrinks the glyph to the tile's padding and
          the counters close up into a blob at header size. */}
      <BrandMark class={cx("flex-none text-accent", lg ? "size-[52px]" : "size-[30px]")} />
      {!lg && (
        <span class="font-display text-[1.05rem] font-semibold tracking-[-0.04em] text-ink">
          Send<span class="text-accent">Self</span>
        </span>
      )}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Spinner
   ------------------------------------------------------------------------ */
export function Spinner({
  large = false,
  class: cls,
}: {
  large?: boolean;
  class?: string;
}): JSX.Element {
  return (
    <span
      class={cx("spinner", large && "!size-[26px] !border-[2.5px]", cls)}
      aria-label="loading"
    />
  );
}

/* --------------------------------------------------------------------------
   Loading
   ------------------------------------------------------------------------ */
/**
 * The app with nothing to show yet: booting, or opening a space.
 *
 * This is also what `/app` is prerendered as (see `entry-server.tsx`), so the
 * very first paint of the installed app is already this screen and the boot
 * finishes into the same markup rather than replacing it.
 */
export function Loading(): JSX.Element {
  return (
    <div class="bg-grad grid h-full place-items-center">
      <Spinner large />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------------ */
export function Toasts(): JSX.Element {
  return (
    <div class="fixed left-1/2 top-[calc(16px+env(safe-area-inset-top))] z-[100] flex w-max max-w-[min(92vw,420px)] -translate-x-1/2 flex-col items-center gap-2.5 max-md:top-[calc(68px+env(safe-area-inset-top))]">
      {toasts.value.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          class={cx(
            "animate-toast-in flex items-center gap-2.5 rounded-card border border-line bg-elevated px-3.5 py-3 text-note font-medium text-ink shadow-float [&_svg]:size-[18px] [&_svg]:flex-none",
            t.kind === "error" && "border-danger/40",
          )}
        >
          {t.kind === "error" ? (
            <AlertCircle class="text-danger" />
          ) : (
            <CheckCircle2 class="text-accent" />
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Modal
   ------------------------------------------------------------------------ */
interface ModalProps {
  title: string;
  /**
   * Omit for a modal the user cannot walk away from: no close button, no
   * Escape, no backdrop click — it must be resolved through its own actions.
   */
  onClose?: () => void;
  children: ComponentChildren;
}

export function Modal({ title, onClose, children }: ModalProps): JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape and move focus into the dialog when it opens (basic a11y).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      class="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,#0a0a0c_55%,transparent)] p-4 backdrop-blur-[4px]"
      onClick={() => onClose?.()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        class="animate-modal-in flex max-h-[calc(100dvh-2rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-xl3 bg-elevated shadow-float outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="flex flex-none items-center justify-between py-4 pl-[22px] pr-[18px]">
          <h2 id={titleId} class="text-title-sm font-semibold">
            {title}
          </h2>
          {onClose && (
            <IconButton label="Close" onClick={onClose}>
              <X />
            </IconButton>
          )}
        </header>
        {/* The body scrolls rather than the panel growing past the viewport: a
            tall dialog on a short screen used to clip its own actions off the
            bottom with no way to reach them. */}
        <div class="flex min-h-0 flex-col gap-4 overflow-y-auto px-[22px] pb-[22px] pt-1">
          {children}
        </div>
      </div>
    </div>
  );
}
