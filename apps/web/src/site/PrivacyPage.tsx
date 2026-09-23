import { CircleSlash, Clock, EyeOff, UserX } from "lucide-preact";
import type { JSX } from "preact";
import { Callout, DataTable, DocPage, type DocSection } from "./DocPage";
import { ISSUES_URL, OPERATOR, PAIRING_TTL_LABEL, REPO_URL, SERVER_RETENTION_LABEL } from "./facts";

/**
 * `/privacy/`: the privacy policy.
 *
 * Every statement here describes what the code does today — the Worker's
 * tables and cleanup (apps/worker), what the browser keeps (apps/web/src/db),
 * and the headers every response carries (apps/worker/src/security.ts). A
 * change to any of those is a change to this page.
 */

const SECTIONS: DocSection[] = [
  {
    id: "operator",
    title: "Who runs SendSelf",
    body: (
      <>
        <p>
          SendSelf is a free, open-source project run by {OPERATOR}, who is responsible for the data
          described on this page. It has no advertising, sells nothing, and makes no other use of
          the data it handles than running the service.
        </p>
        <p>
          The <a href={REPO_URL}>source code</a> is public, so every claim below can be checked
          against what actually runs.
        </p>
      </>
    ),
  },
  {
    id: "content",
    title: "What we cannot access",
    body: (
      <>
        <p>
          Your messages, your files, their names and types, and the names of your devices and spaces
          are encrypted on your devices before they are uploaded. The keys to decrypt them never
          reach us, so we cannot read, scan or hand over that content in readable form — not even if
          we wanted to.
        </p>
        <p>
          How that works, and where it stops, is described in the{" "}
          <a href="/security/">security model</a>.
        </p>
      </>
    ),
  },
  {
    id: "stored",
    title: "What the service stores",
    body: (
      <>
        <p>
          To pass content between your devices, the service keeps the following. None of it includes
          your name, email address, phone number or any other account details, because SendSelf
          never asks for them.
        </p>
        <DataTable
          caption="Data the service stores, why, and for how long"
          columns={["Data", "Why", "How long"]}
          rows={[
            [
              "Encrypted messages and files",
              "To hold them until each of your devices has downloaded them.",
              `Deleted once every active device in the space has them, and after ${SERVER_RETENTION_LABEL} at the latest.`,
            ],
            [
              "Delivery status",
              "Which devices still need each message, so a copy can be deleted as soon as it is safe to.",
              "Deleted with the message.",
            ],
            [
              "Space and device records",
              "Random ids, public keys, device roles, encrypted device and space names, a hash of each device's token, and when devices were added or revoked — so your devices can authenticate and recognise each other.",
              "For as long as the space exists. Revoked devices stay on record, marked as revoked.",
            ],
            [
              "Key updates",
              "When a device is revoked, the new space key, sealed separately for each remaining device.",
              "Deleted once each device has collected its copy.",
            ],
            [
              "Pairing requests",
              "The new device's public keys and the sealed package that lets it join.",
              `Deleted when pairing completes; an unfinished request expires after ${PAIRING_TTL_LABEL} and is removed within the hour.`,
            ],
          ]}
        />
        <Callout title="Leaving a space does not delete it from the server">
          Leaving a space erases it from that device only. The space, and that device's record, stay
          on the server for the devices still using it. To cut a device off, revoke it from another
          device in the space. There is not yet a way to delete a whole space from the server
          yourself — if you need that, <a href="#contact">get in touch</a>.
        </Callout>
      </>
    ),
  },
  {
    id: "network",
    title: "Network data and logs",
    body: (
      <>
        <p>
          Like any website, every request reaches the service with your IP address and the standard
          information your browser sends, such as its user agent.
        </p>
        <ul>
          <li>
            SendSelf uses the IP address to limit how often spaces can be created and devices
            linked, which keeps the service from being abused. The check happens in memory; the
            address is not stored with your space.
          </li>
          <li>
            Requests and errors are logged by the hosting platform so problems can be diagnosed.
            These logs record details of each request, such as its time, the URL requested and
            network information that may include your IP address. They never contain your content or
            keys, and are kept for a few days.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "local",
    title: "What stays on your devices",
    body: (
      <>
        <p>
          Your readable history, your files and your keys are stored in the browser of each device,
          and nowhere else. They stay there until you leave the space, clear the site's data, or the
          browser removes it. There is no automatic clean-up of local history yet.
        </p>
        <p>
          Besides that, SendSelf keeps a copy of its own app files so it opens offline, and your
          appearance setting (theme and colour) so it survives a reload. You can protect your
          history, files and keys with a lock; the{" "}
          <a href="/security/#this-device">security model</a> explains how.
        </p>
      </>
    ),
  },
  {
    id: "tracking",
    title: "Cookies and tracking",
    body: (
      <>
        <p>
          SendSelf sets no cookies and uses no analytics, advertising, fingerprinting or social
          media trackers. Its pages are only allowed to run SendSelf's own scripts, so no
          third-party code can be added to them.
        </p>
        <p>Links you follow out of SendSelf do not tell the site you visit where you came from.</p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Service providers",
    body: (
      <>
        <p>
          SendSelf runs on <a href="https://www.cloudflare.com/">Cloudflare</a>, which serves the
          app, runs its server code, and stores the database and the encrypted files. Cloudflare
          processes the data above on our behalf and may do so in data centres outside your country.
          Its handling of that data is governed by the{" "}
          <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare privacy policy</a>.
        </p>
        <p>No other company receives data from SendSelf, and none is sold or shared.</p>
      </>
    ),
  },
  {
    id: "basis",
    title: "Why we may process this data",
    body: (
      <>
        <p>
          Storing and delivering your encrypted content, and the records that let your devices
          authenticate, is necessary to provide the service you ask for when you use SendSelf.
          Rate-limiting by IP address and keeping short-lived logs rest on our legitimate interest
          in keeping the service secure and working.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your choices and rights",
    body: (
      <>
        <p>Most of what the service holds is in your hands directly:</p>
        <ul>
          <li>
            <strong>Delete a message for everyone</strong> to remove it from the server at once and
            from your other devices as they reconnect, or send it as a temporary message.
          </li>
          <li>
            <strong>Revoke a device</strong> to end its access to a space.
          </li>
          <li>
            <strong>Leave a space</strong>, or clear the site's data in your browser, to remove
            everything stored on that device.
          </li>
        </ul>
        <p>
          Depending on where you live, you may also have the right to access, correct, delete or
          export your personal data, to object to or restrict how it is processed, and to complain
          to your data protection authority. Because SendSelf has no accounts, we cannot tell which
          records are yours without information from one of your devices; if you want to exercise a
          right, <a href="#contact">get in touch</a> and we will work out with you how to identify
          them.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        SendSelf is an early-stage project, and this policy will change as the service does. The
        date at the top of the page shows when it last changed, and every earlier version is kept in
        the <a href={REPO_URL}>public repository</a>.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        For questions about this policy or your data, <a href={ISSUES_URL}>open an issue</a> on the
        project's repository. If your request involves anything you would rather not post in public,
        say so in the issue — without the details — and we will arrange a private channel.
      </p>
    ),
  },
];

export function PrivacyPage(): JSX.Element {
  return (
    <DocPage
      page="privacy"
      kicker="Privacy policy"
      title="We can't read what you send, and we keep as little as we can"
      lead="SendSelf has no accounts and no trackers. What you share is encrypted before it leaves your device, so the service carries it without being able to read it. This policy lists everything the service does process, why, and for how long."
      updated="2026-09-23"
      highlights={[
        {
          icon: UserX,
          title: "No account",
          body: "No name, email address, phone number or password. Your devices are identified by keys they create themselves.",
        },
        {
          icon: CircleSlash,
          title: "No tracking",
          body: "No cookies, analytics or ads, and no third-party scripts on any page.",
        },
        {
          icon: EyeOff,
          title: "Unreadable to us",
          body: "Messages, files and names are end-to-end encrypted. The keys never reach the server.",
        },
        {
          icon: Clock,
          title: `Gone within ${SERVER_RETENTION_LABEL}`,
          body: "Encrypted copies are deleted from the server as soon as your devices have them, and after a day at most.",
        },
      ]}
      sections={SECTIONS}
    />
  );
}
