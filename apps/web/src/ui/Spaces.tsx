import { ArrowRight, LockKeyhole, MessagesSquare, Plus, X } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { hasPendingShare } from "../actions";
import { type SpaceRecord, UNNAMED_SPACE } from "../db/spaces";
import { lockConfigured, lockNow } from "../state/lock";
import { followLink, spacePath } from "../state/route";
import { spaces } from "../state/spaces";
import { OnboardingCard } from "./Onboarding";
import { AppearanceMenu } from "./AppearanceMenu";
import { Button, IconButton, Logo, Toasts, cx } from "./components";

/**
 * `/app`: every space this device holds.
 *
 * The device's home rather than the landing page's: creating, joining and
 * restoring a space all happen here, and each space is one click (and one URL)
 * away from the one next to it.
 */
export function Spaces(): JSX.Element {
  const [creating, setCreating] = useState(false);
  const list = spaces.value;

  return (
    <div class="bg-grad min-h-full">
      <header class="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--c-surface)_72%,transparent)] backdrop-blur-xl">
        <div class="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-6 max-md:px-4">
          <a href="/" class="flex items-center" onClick={(e) => followLink(e as MouseEvent, "/")}>
            <Logo />
          </a>
          <div class="flex items-center gap-1">
            <AppearanceMenu />
            {lockConfigured.value && (
              <IconButton label="Lock this device" onClick={lockNow}>
                <LockKeyhole />
              </IconButton>
            )}
          </div>
        </div>
      </header>

      <main class="mx-auto max-w-3xl px-6 py-10 max-md:px-4">
        {list.length === 0 ? (
          <>
            <div class="mb-8 text-center">
              <h1 class="text-[clamp(1.7rem,4vw,2.25rem)] font-semibold tracking-[-0.03em]">
                Start your first space
              </h1>
              <p class="mx-auto mt-3 max-w-md text-body-lg leading-relaxed text-muted">
                A space is a private, end-to-end encrypted thread shared by your own devices. You
                can have as many as you like.
              </p>
            </div>
            <div class="mx-auto w-full max-w-[420px]">
              <OnboardingCard />
            </div>
          </>
        ) : (
          <>
            {/* The button drops below the copy on a phone instead of squeezing
                it into a half-width column beside itself. */}
            <div class="flex items-end justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-5">
              <div>
                <h1 class="text-display-lg font-semibold tracking-[-0.03em]">Your spaces</h1>
                <p class="mt-1.5 text-body text-muted">
                  {hasPendingShare()
                    ? "Pick the space to send the shared content to."
                    : "Everything in a space stays encrypted between your devices."}
                </p>
              </div>
              <Button
                class="flex-none sm:!w-auto"
                variant="primary"
                onClick={() => setCreating(true)}
              >
                <Plus />
                New space
              </Button>
            </div>

            <ul class="mt-7 flex flex-col gap-2.5">
              {list.map((space) => (
                <SpaceCard key={space.id} space={space} />
              ))}
            </ul>
          </>
        )}
      </main>

      {creating && (
        <div class="animate-fade-in fixed inset-0 z-50 overflow-y-auto bg-[color-mix(in_srgb,#0a0a0c_55%,transparent)] backdrop-blur-[4px]">
          <div
            class="min-h-full p-4"
            onClick={(event) => {
              if (event.currentTarget === event.target) setCreating(false);
            }}
          >
            <div class="mx-auto flex min-h-full max-w-[420px] items-center">
              <div class="relative w-full">
                <div class="absolute -top-1 right-0 z-10 -translate-y-full pb-2">
                  <IconButton
                    label="Close"
                    class="bg-surface/80 text-ink backdrop-blur hover:bg-surface"
                    onClick={() => setCreating(false)}
                  >
                    <X />
                  </IconButton>
                </div>
                <OnboardingCard />
              </div>
            </div>
          </div>
        </div>
      )}

      <Toasts />
    </div>
  );
}

/**
 * A space in the list is a link and nothing else. Leaving one is done from
 * inside it, where the whole context of what is about to be deleted is on
 * screen — and where the action can be reached without a pointer.
 */
function SpaceCard({ space }: { space: SpaceRecord }): JSX.Element {
  const path = spacePath(space.id);
  const name = space.name ?? UNNAMED_SPACE;

  return (
    <li class="group relative">
      <a
        href={path}
        onClick={(event) => followLink(event as MouseEvent, path)}
        class="surface-card flex items-center gap-4 rounded-xl2 p-4 transition hover:shadow-pop"
      >
        <span class="grid size-11 flex-none place-items-center rounded-[12px] bg-accent-soft text-accent [&_svg]:size-[21px]">
          <MessagesSquare />
        </span>
        <span class="min-w-0 flex-1">
          <span
            class={cx(
              "block truncate text-lead font-semibold tracking-[-0.01em]",
              !space.name && "text-subtle",
            )}
          >
            {name}
          </span>
          <span class="block text-caption text-muted">
            Created {new Date(space.createdAt).toLocaleDateString()}
          </span>
        </span>
        <ArrowRight class="size-[18px] flex-none text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </a>
    </li>
  );
}
