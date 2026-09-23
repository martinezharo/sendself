import {
  ArrowRight,
  EyeOff,
  FileUp,
  Link2,
  Lock,
  MonitorSmartphone,
  Plus,
  QrCode,
  Send,
  ShieldCheck,
  WifiOff,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Toasts, cx } from "../ui/components";
import { ChatPreview } from "./ChatPreview";
import {
  type Feature,
  FeatureCard,
  Kicker,
  OpenAppLink,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SectionHeading,
  SiteFooter,
  SiteHeader,
} from "./chrome";
import { MAX_FILE_LABEL, SERVER_RETENTION_LABEL } from "./facts";

const FEATURES: Feature[] = [
  {
    icon: Lock,
    title: "Encrypted before upload",
    body: "Messages and files are encrypted on your device before they leave it. The server can deliver the ciphertext, but cannot decrypt your content.",
  },
  {
    icon: EyeOff,
    title: "No account required",
    body: "No email or server password. Optionally protect this device with a passphrase, PIN, or passkey.",
  },
  {
    icon: MonitorSmartphone,
    title: "As many spaces as you need",
    body: "Keep work, home, and one-off transfers apart: each space has its own devices, history, and encryption keys.",
  },
  {
    icon: QrCode,
    title: "Pair with a QR code",
    body: "Link a new device through an out-of-band QR flow that securely transfers access to it.",
  },
  {
    icon: FileUp,
    title: `Files up to ${MAX_FILE_LABEL}`,
    body: `Send documents, images, or archives. The server copy is removed after all active recipients acknowledge delivery, or cleaned up within ${SERVER_RETENTION_LABEL}.`,
  },
  {
    icon: WifiOff,
    title: "Local history & offline queue",
    body: "Your history stays on your devices. Messages and selected files can wait locally, but uploading and delivery require a connection.",
  },
];

const STEPS: Feature[] = [
  {
    icon: Plus,
    title: "Create a private space",
    body: "Start on any device without an account, email, or server password.",
  },
  {
    icon: Link2,
    title: "Link your devices",
    body: "Scan a QR code to add your phone, laptop, or tablet to the same private space.",
  },
  {
    icon: Send,
    title: "Send without waiting",
    body: `Send text and files when connected; if a recipient is offline, delivery waits until it reconnects, with undelivered server copies cleaned up within ${SERVER_RETENTION_LABEL}.`,
  },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  {
    q: "Is SendSelf end-to-end encrypted?",
    a: "Yes. Messages, files, and file metadata are encrypted on your device with AES-GCM before upload. The server receives ciphertext and cannot decrypt the content.",
  },
  {
    q: "Do I need an account?",
    a: "No account, email, or server password is required. You can optionally protect this device with a passphrase, PIN, or passkey.",
  },
  {
    q: "Can the server read my messages or files?",
    a: "It cannot decrypt your content. It does receive ciphertext and the protocol metadata needed to authenticate requests and deliver messages.",
  },
  {
    q: "What is the maximum file size?",
    a: `You can share files up to ${MAX_FILE_LABEL}. The server copy is purged when active recipients acknowledge delivery; anything left over is cleaned up within ${SERVER_RETENTION_LABEL}.`,
  },
  {
    q: "Does it work offline?",
    a: "Partly. The installed PWA keeps local history available and can save outgoing messages or selected files locally, but nothing is uploaded or delivered until you reconnect.",
  },
  {
    q: "Can I install it as an app?",
    a: "Yes. SendSelf is a progressive web app. In Chrome, Edge, or Samsung Internet, use the install button the browser offers; on iPhone and iPad, choose Share → Add to Home Screen; in Safari on a Mac, choose File → Add to Dock. Installed, it opens in its own window, keeps local history available offline and, on Android, shows up in the system share sheet.",
  },
  {
    q: "How do I add another device?",
    a: "On the new device, choose to link an existing space and show its QR code. Scan it from a linked device; the shared group key is transferred in an encrypted pairing package.",
  },
  {
    q: "Where are the encryption keys kept?",
    a: "Private device keys are generated locally and never sent to the server. The shared group key is transferred only to linked devices through encrypted pairing and key-rotation packages. An optional encrypted recovery file can carry a copy for restoring a device.",
  },
];

/**
 * The public marketing page.
 *
 * Prerendered into index.html at build time (scripts/prerender.mjs), so it is
 * what crawlers and no-JS clients see. Every call to action leads to `/app`,
 * where the spaces live — nothing here creates or touches one. The hero's chat
 * (see ChatPreview.tsx) is a self-contained demo for the same reason: it looks
 * and behaves like the app, but talks to nothing.
 *
 * `prerendered` marks that baked-in copy, the one that paints before any of
 * the app's code has run. Only it hides itself inside an installed app (see
 * `.landing-prerendered` in styles.css); once the app is running, it decides
 * for itself whether the landing page is where it should be.
 */
export function Landing({ prerendered = false }: { prerendered?: boolean }): JSX.Element {
  const [scrolled, setScrolled] = useState(false);

  // Header appearance follows scroll position.
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div class={cx("bg-grad min-h-full", prerendered && "landing-prerendered")}>
      <SiteHeader page="home" solid={scrolled} />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Security />
        <Faq />
      </main>
      <SiteFooter page="home" />

      <Toasts />
    </div>
  );
}

function Hero(): JSX.Element {
  return (
    <section id="top" class="relative scroll-mt-20">
      <div class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 max-md:px-4 max-md:py-10 md:grid-cols-[1.05fr_0.95fr] md:py-24">
        <div class="max-md:text-center">
          <span class="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5 font-mono text-meta font-medium uppercase tracking-[0.16em] text-accent [&_svg]:size-3.5">
            <ShieldCheck />
            End-to-end encrypted
          </span>
          <h1 class="mt-5 text-[clamp(2.25rem,5vw,3.5rem)] font-semibold leading-[1.04] tracking-[-0.035em]">
            Send files and text
            <br class="max-md:hidden" /> between your own devices —{" "}
            <span class="text-accent">privately</span>.
          </h1>
          <p class="mt-5 max-w-xl text-lead leading-relaxed text-subtle max-md:mx-auto">
            SendSelf is a private, end-to-end encrypted space for your phone, laptop, and tablet. No
            account required: your content is encrypted on your device before upload, and the server
            never receives it in readable form.
          </p>
          {/* Stacked on a phone, the two buttons match widths instead of
              centring two different-length pills under each other. */}
          <div class="mt-8 flex flex-wrap items-center gap-3 max-md:justify-center max-sm:flex-col max-sm:items-stretch">
            <OpenAppLink class={PRIMARY_BUTTON}>
              Open the app
              <ArrowRight />
            </OpenAppLink>
            <a href="#how" class={SECONDARY_BUTTON}>
              See how it works
            </a>
          </div>
          <ul class="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-meta uppercase tracking-[0.1em] text-muted max-md:justify-center">
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> No account
            </li>
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> Up to {MAX_FILE_LABEL} per file
            </li>
            <li class="flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-success" /> Offline queue
            </li>
          </ul>
        </div>

        <div class="mx-auto w-full max-w-[420px]">
          <ChatPreview />
        </div>
      </div>
    </section>
  );
}

function Features(): JSX.Element {
  return (
    <section id="features" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-6xl">
        <SectionHeading
          kicker="Why SendSelf"
          title="Your content stays yours"
          subtitle="Messages and files are encrypted on your devices before they leave them. The server can deliver ciphertext, but cannot decrypt it."
        />
        <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <FeatureCard key={feature.title} {...feature} />
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks(): JSX.Element {
  return (
    <section id="how" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-6xl">
        <SectionHeading kicker="How it works" title="Up and running in three steps" />
        <ol class="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} class="surface-card relative rounded-xl2 p-6">
              <div class="flex items-center gap-3">
                <span class="grid size-10 place-items-center rounded-[12px] bg-accent text-on-accent [&_svg]:size-[20px]">
                  <Icon />
                </span>
                <span class="font-mono text-caption font-medium text-muted">
                  Step {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 class="mt-4 text-title-sm font-semibold tracking-[-0.01em]">{title}</h3>
              <p class="mt-2 text-body leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Security(): JSX.Element {
  const points = [
    {
      term: "Content encryption (AES-GCM 256)",
      desc: "A local group key encrypts messages, files, and file metadata. Keys rotate when a device is revoked.",
    },
    {
      term: "Device identity (ECDH P-256)",
      desc: "Each device creates its own P-256 key pair. Private keys are never sent to the server; an optional encrypted recovery file can restore a device.",
    },
    {
      term: "Encrypted device pairing",
      desc: "A QR code binds the new device's public key to the pairing. The shared group key is sent only inside an encrypted package.",
    },
    {
      term: "Temporary server storage",
      desc: `Delivered messages and files are purged when active recipients acknowledge them; a scheduled cleanup removes anything older than ${SERVER_RETENTION_LABEL}.`,
    },
  ];

  return (
    <section id="security" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="surface-card mx-auto max-w-5xl overflow-hidden rounded-xl3 p-8 !shadow-float md:p-12">
        <div class="grid gap-10 md:grid-cols-[0.9fr_1.1fr] md:items-center">
          <div>
            <Kicker>Security model</Kicker>
            <h2 class="mt-3 text-[clamp(1.6rem,3.5vw,2.25rem)] font-semibold tracking-[-0.03em]">
              Built so the server cannot decrypt your content
            </h2>
            <p class="mt-4 text-body-lg leading-relaxed text-muted">
              Messages, files, and file metadata are encrypted on your devices. The service receives
              ciphertext, public keys, authentication data, and delivery metadata — but not readable
              content or private device keys.
            </p>
            <a
              href="/security/"
              class="mt-6 inline-flex items-center gap-2 text-body font-semibold text-accent transition-[gap] hover:gap-3 [&_svg]:size-[17px]"
            >
              Read the full security model
              <ArrowRight />
            </a>
          </div>
          <dl class="grid gap-3 sm:grid-cols-2">
            {points.map(({ term, desc }) => (
              <div key={term} class="rounded-xl2 bg-surface-3 p-5">
                <dt class="flex items-center gap-2 text-body font-semibold [&_svg]:size-4 [&_svg]:text-accent">
                  <Lock />
                  {term}
                </dt>
                <dd class="mt-2 text-note leading-relaxed text-muted">{desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function Faq(): JSX.Element {
  return (
    <section id="faq" class="scroll-mt-20 px-6 py-16 max-md:px-4 md:py-24">
      <div class="mx-auto max-w-3xl">
        <SectionHeading kicker="FAQ" title="Questions, answered" />
        <div class="mt-10 flex flex-col gap-3">
          {FAQS.map(({ q, a }) => (
            <details key={q} class="surface-card group rounded-xl2 px-5 transition open:shadow-pop">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-body-lg font-semibold [&::-webkit-details-marker]:hidden">
                {q}
                <span class="grid size-7 flex-none place-items-center rounded-full bg-surface-3 text-muted transition group-open:rotate-45 group-open:bg-accent-soft group-open:text-accent">
                  <Plus class="size-4" />
                </span>
              </summary>
              <p class="pb-5 text-body leading-relaxed text-muted">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
