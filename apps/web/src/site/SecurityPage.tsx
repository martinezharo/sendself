import { BadgeCheck, KeyRound, Lock, RefreshCw } from "lucide-preact";
import type { JSX } from "preact";
import { Callout, Contrast, DataTable, DocPage, type DocSection, Steps } from "./DocPage";
import {
  PAIRING_TTL_LABEL,
  PBKDF2_ITERATIONS_LABEL,
  REPO_URL,
  SECURITY_DOC_URL,
  SECURITY_REPORT_URL,
  SERVER_RETENTION_LABEL,
} from "./facts";

/**
 * `/security/`: the security model, for the people who use the app.
 *
 * A plain-language reading of docs/security.md — same claims, same limits,
 * none of the implementation references. When the model changes, both change:
 * this page must never promise more than that document does.
 */

const SECTIONS: DocSection[] = [
  {
    id: "encryption",
    title: "What gets encrypted",
    body: (
      <>
        <p>
          Every space has its own <strong>space key</strong>: a random AES-GCM 256-bit key that is
          created on the first device and only ever exists on the devices in that space. Before
          anything is uploaded, your device uses it to encrypt:
        </p>
        <ul>
          <li>the text of your messages;</li>
          <li>the contents of your files;</li>
          <li>
            the details around them — file names, types and sizes, which files were sent together,
            and whether a message is temporary;
          </li>
          <li>the names you give your devices and your spaces.</li>
        </ul>
        <p>
          Each piece of ciphertext is also bound to the message it belongs to, so it cannot be
          lifted into another message without failing to decrypt.
        </p>
      </>
    ),
  },
  {
    id: "keys",
    title: "Keys, and where they live",
    body: (
      <>
        <p>
          SendSelf has no accounts and no passwords on the server. What identifies you is a small
          set of keys, and the ones that matter never leave your devices.
        </p>
        <DataTable
          caption="The keys SendSelf uses, what each one does, and where it is kept"
          columns={["Key", "What it does", "Where it lives"]}
          rows={[
            [
              "Space key",
              "Encrypts everything you share in a space.",
              "Only on the space's devices. Replaced when a device is revoked; earlier keys are kept so your history stays readable.",
            ],
            [
              "Device keys",
              "Each device has two P-256 key pairs: one to receive keys securely, one to sign what it sends.",
              "The private halves never leave the device. The public halves are published so your other devices can recognise it.",
            ],
            [
              "Device token",
              "A random 256-bit credential that lets one device use the API.",
              "Kept on the device. The server stores only a hash of it, and each device has its own.",
            ],
            [
              "Lock key",
              "Encrypts this device's local data, if you set a lock.",
              "Derived when you unlock and held in memory only.",
            ],
          ]}
        />
      </>
    ),
  },
  {
    id: "pairing",
    title: "Linking a device",
    body: (
      <>
        <p>Adding a device never gives the server a copy of the space key that it can open:</p>
        <Steps
          items={[
            "The new device creates its own keys and shows a QR code (or a text code to paste) that carries its public keys.",
            "A device already in the space scans it. If the keys the server relays do not match the ones in the code, it refuses to go on.",
            "It seals the space key, and a fresh token for the new device, so that only the new device can open them — then hands the sealed package to the server to pass on.",
            `The new device opens the package and joins. A pairing request that is not completed expires after ${PAIRING_TTL_LABEL}.`,
          ]}
        />
        <p>
          The device that scans also signs the newcomer's public keys, and your other devices check
          that signature rather than taking the server's list of devices on trust. When a device
          joins, the chat says whether its keys were verified this way. If the keys of a device you
          already know ever change, your devices say so instead of quietly accepting them.
        </p>
        <p>
          Only the space's owner and its admins can link or revoke devices; other devices are
          members.
        </p>
        <Callout title="The code is what you vouch for">
          Scan the code from the screen of the device you are adding, not from a screenshot or a
          message someone sent you: whichever keys are in that code are the ones that get access.
        </Callout>
      </>
    ),
  },
  {
    id: "signatures",
    title: "Messages are signed",
    body: (
      <>
        <p>
          Every message — and every “delete for everyone” — is signed by the device that sent it.
          The signature covers who sent it, the key it was encrypted with, its id, and every
          encrypted field. Your devices check it against the sender they already trust before
          storing anything.
        </p>
        <p>
          So the server cannot change a message, and cannot pass one off as having come from a
          different device in your space. What a signature does not cover is covered under{" "}
          <a href="#limits">limits</a> below.
        </p>
      </>
    ),
  },
  {
    id: "revocation",
    title: "Removing a device",
    body: (
      <>
        <p>Revoking a device from the devices list does two things:</p>
        <ul>
          <li>its token stops working at once, so it can no longer reach the space;</li>
          <li>
            one of your remaining devices creates a new space key and seals a copy for each device
            that stays. The server passes those copies on without being able to open them.
          </li>
        </ul>
        <p>
          From then on, everything is encrypted with a key the revoked device never receives. Your
          other devices keep the earlier keys, so your history stays readable.
        </p>
        <Callout title="Revocation only works forwards">
          A revoked device keeps whatever it already had: messages it received, files it saved, and
          the older keys. Revoking it protects what you send next, not what it has already seen.
        </Callout>
      </>
    ),
  },
  {
    id: "deletion",
    title: "Deleting and temporary messages",
    body: (
      <>
        <p>
          <strong>Delete for everyone</strong> sends a signed deletion through the same path as a
          message. The server drops its own copy straight away, and each of your devices deletes its
          copy once it has checked the signature.
        </p>
        <p>
          A <strong>temporary message</strong> disappears from your other devices as soon as one of
          them opens it, and from that one when it is closed. Whether a message is temporary is part
          of the encrypted content, so the server cannot tell which ones are — or remove the flag to
          keep one around.
        </p>
        <p>
          Both depend on your devices doing what the app asks. Neither can undo a screenshot, a file
          that was already saved elsewhere, or a device that never comes back online.
        </p>
      </>
    ),
  },
  {
    id: "this-device",
    title: "Protecting this device",
    body: (
      <>
        <p>
          Your history, your files and your keys are stored in this browser. Without a lock, anyone
          who can open this browser profile can read them.
        </p>
        <h3>Lock</h3>
        <p>
          A lock encrypts all of that at rest, with a key derived from a passphrase or PIN
          (PBKDF2-SHA-256, {PBKDF2_ITERATIONS_LABEL} iterations) or from a passkey. SendSelf then
          asks for it every time it starts, and you can lock it on demand. The secret is never sent
          anywhere, so it cannot be reset: if you forget it, you lose this device's copy — not the
          space, and not your other devices.
        </p>
        <h3>Recovery file</h3>
        <p>
          If every device in a space is lost, nothing on the server can bring the space back. A
          recovery file can: it restores this device in that space, identity and keys included. It
          is encrypted with a code that is generated for you and shown only once. The file and its
          code together are as good as the device itself, so keep them apart and safe.
        </p>
        <p>
          A recovery file is a snapshot. After a device is revoked and the key changes, create a new
          one to cover what is sent from then on.
        </p>
      </>
    ),
  },
  {
    id: "server",
    title: "What the server can see",
    body: (
      <>
        <p>
          Encryption hides what you share, not the fact that you are sharing. This is what the
          service can and cannot see:
        </p>
        <Contrast
          hidden={{
            title: "It cannot read",
            items: [
              "The text of your messages",
              "Your files, their names and their types",
              "The names of your devices and spaces",
              "Which messages are temporary, or which files were sent together",
              "The space key or any private key",
            ],
          }}
          visible={{
            title: "It can see",
            items: [
              "That a space exists, and which devices are in it, with their public keys and roles",
              "When messages are sent, roughly how large they are, and which devices still need them",
              "When a device is added, revoked, or deletes a message",
              "IP addresses and request timing, as any web service does",
            ],
          }}
        />
        <p>
          Encrypted messages and files are kept only until your devices have them, and never longer
          than {SERVER_RETENTION_LABEL}. The <a href="/privacy/">privacy policy</a> lists everything
          the service stores and for how long.
        </p>
      </>
    ),
  },
  {
    id: "limits",
    title: "Where the protection ends",
    body: (
      <>
        <p>We would rather you knew these than found them:</p>
        <ul>
          <li>
            <strong>The app comes from the server.</strong> SendSelf runs in your browser as code
            served by sendself.4oli.com. Whoever controls that deployment could ship code that reads
            your messages while the app is open — encryption inside an app cannot protect you from
            the app itself. The code is open source, and the page is only allowed to run its own
            scripts, but you are trusting this deployment.
          </li>
          <li>
            <strong>Your devices are part of the model.</strong> A device that is compromised, or
            unlocked in someone else's hands, can read everything on it.
          </li>
          <li>
            <strong>No protection against replays yet.</strong> The server cannot forge or alter
            messages, but it could send a valid one twice, or deliver messages out of order.
            Timestamps are set by the server and are not signed.
          </li>
          <li>
            <strong>Metadata is not hidden.</strong> Message sizes, timing and the number of devices
            are visible to the service.
          </li>
          <li>
            <strong>The lock is opt-in</strong> and does not yet lock itself after a period of
            inactivity. Files shared into SendSelf from another app also wait briefly, unencrypted,
            in the browser's cache until the app picks them up.
          </li>
          <li>
            <strong>Not independently audited.</strong> SendSelf is an early-stage project, and its
            security has not been reviewed by a third party.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "verify",
    title: "Check it yourself",
    body: (
      <>
        <p>
          SendSelf is open source under the MIT license. The{" "}
          <a href={SECURITY_DOC_URL}>technical security document</a> describes the model in full —
          algorithms, formats and open design questions — and the <a href={REPO_URL}>source code</a>{" "}
          is what runs.
        </p>
        <p>
          If you find a vulnerability, please report it privately through the repository's{" "}
          <a href={SECURITY_REPORT_URL}>security page</a> rather than in a public issue.
        </p>
      </>
    ),
  },
];

export function SecurityPage(): JSX.Element {
  return (
    <DocPage
      page="security"
      kicker="Security model"
      title="Built so the server can't read what you send"
      lead="SendSelf encrypts what you share on your own device, before it is uploaded. This page explains how, what the service can still see, and where the protection ends."
      updated="2026-09-23"
      highlights={[
        {
          icon: Lock,
          title: "Encrypted on your device",
          body: "Messages, files and their names are encrypted with AES-GCM before they leave the device that sends them.",
        },
        {
          icon: KeyRound,
          title: "Keys stay with you",
          body: "Private keys never leave the device that created them. The server only relays sealed copies it cannot open.",
        },
        {
          icon: BadgeCheck,
          title: "Signed by the sender",
          body: "Every message is signed by the device that sent it, so the server cannot alter it or change who sent it.",
        },
        {
          icon: RefreshCw,
          title: "Revoking changes the key",
          body: "Removing a device cuts off its access and moves the space to a new key that device never gets.",
        },
      ]}
      sections={SECTIONS}
    />
  );
}
