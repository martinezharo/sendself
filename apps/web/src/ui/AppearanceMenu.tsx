import { Check, Monitor, Moon, Settings2, Sun } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  PALETTES,
  type Theme,
  originOf,
  palette,
  setPalette,
  setTheme,
  theme,
} from "../state/appearance";
import { Menu, type MenuAnchor, anchorBelow } from "./Menu";
import { IconButton, cx } from "./components";

const THEME_OPTIONS: { id: Theme; label: string; Icon: typeof Sun }[] = [
  { id: "system", label: "Auto", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

/**
 * A segmented pill: one thumb slides between the options rather than three
 * separate buttons lighting up. The travelling thumb is what makes this read as
 * a single switch that has a position, instead of a row of toggles.
 */
function ThemePicker(): JSX.Element {
  const index = THEME_OPTIONS.findIndex((o) => o.id === theme.value);

  return (
    <div class="relative isolate grid grid-cols-3 rounded-full bg-surface-3 p-1">
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full bg-elevated shadow-pop transition-transform duration-200 ease-emphasized"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {THEME_OPTIONS.map(({ id, label, Icon }) => {
        const selected = theme.value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={(e) => setTheme(id, originOf(e.currentTarget as HTMLElement))}
            class={cx(
              "relative z-10 flex min-h-[2.15rem] items-center justify-center gap-1.5 rounded-full px-2 text-caption font-semibold transition-colors [&_svg]:size-[14px]",
              selected ? "text-ink" : "text-muted hover:text-subtle",
            )}
          >
            <Icon />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Swatches carry `data-palette` themselves and paint from `--swatch`, which
 * styles.css resolves to that palette's accent for the mode currently in
 * effect. No hex values live here.
 */
function PalettePicker(): JSX.Element {
  return (
    <div class="grid grid-cols-5 gap-2">
      {PALETTES.map((p) => {
        const selected = palette.value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            data-palette={p.id}
            title={p.label}
            aria-label={p.label}
            aria-pressed={selected}
            onClick={(e) => setPalette(p.id, originOf(e.currentTarget as HTMLElement))}
            class={cx(
              "grid aspect-square place-items-center rounded-full bg-[var(--swatch)] text-[var(--on-swatch)] ring-offset-2 ring-offset-elevated transition-shadow duration-200 ease-emphasized",
              selected
                ? "ring-2 ring-ink"
                : "ring-0 ring-transparent hover:ring-2 hover:ring-line-strong",
            )}
          >
            <Check
              class="size-[13px] transition duration-200 ease-emphasized"
              style={{
                opacity: selected ? 1 : 0,
                transform: selected ? "scale(1)" : "scale(0.4)",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceMenu(): JSX.Element {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const hint =
    theme.value === "dark"
      ? "Always dark."
      : theme.value === "light"
        ? "Always light."
        : "Follows your system.";

  return (
    <>
      <IconButton
        label="Appearance"
        onClick={(e) => setAnchor(anchorBelow(e.currentTarget as HTMLElement))}
      >
        <Settings2 />
      </IconButton>
      {anchor && (
        <Menu anchor={anchor} alignRight label="Appearance" onClose={() => setAnchor(null)}>
          <div class="w-[16.5rem] p-3">
            <p class="mb-2 text-meta font-semibold uppercase tracking-[0.12em] text-muted">Theme</p>
            <ThemePicker />
            <p class="mt-4 mb-2.5 text-meta font-semibold uppercase tracking-[0.12em] text-muted">
              Palette
            </p>
            <PalettePicker />
            <p class="mt-3 text-caption text-muted">{hint}</p>
          </div>
        </Menu>
      )}
    </>
  );
}
