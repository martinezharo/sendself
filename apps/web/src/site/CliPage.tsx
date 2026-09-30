import { Bot, KeyRound, Send, Terminal } from "lucide-preact";
import type { JSX } from "preact";
import {
  AGENT_INSTRUCTIONS,
  CLI_LINK_PLACEHOLDER,
  CLI_SEND_EXAMPLE,
  agentSetupPrompt,
} from "../cli";
import { DocPage, type DocSection } from "./DocPage";
import { MAX_FILE_LABEL, PAIRING_TTL_LABEL, REPO_URL } from "./facts";

/**
 * `/cli/`: the `sendself` command line, for people and for their agents.
 *
 * The commands and the prompt come from `cli.ts`, the same source the landing
 * page and the app's "Agent" pairing dialog read, so the three always agree.
 * This page is static and never hydrated: what it offers to copy is plain text.
 */

const CLI_SOURCE_URL = `${REPO_URL}/tree/main/apps/cli`;

const SECTIONS: DocSection[] = [
  {
    id: "what",
    title: "What it is",
    body: (
      <>
        <p>
          <code>sendself</code> is SendSelf's command line. It lets a server, a script or an AI
          agent send files and messages to your devices, so a report, a screenshot or a finished
          build can land on your phone the moment it is ready.
        </p>
        <p>
          It links to one of your spaces as a <strong>send-only</strong> device. It can send there,
          and never receives anything: the server leaves it out of every delivery. It encrypts and
          signs on the machine it runs on, with the same code as the app, so the server still only
          ever sees ciphertext. It needs Node.js 20 or newer, and nothing to install:{" "}
          <code>npx</code> runs the latest release.
        </p>
      </>
    ),
  },
  {
    id: "agents",
    title: "Set it up with your agent",
    body: (
      <>
        <p>
          The quickest way is to let the agent do it. In the app, open{" "}
          <strong>Devices → Add device → Agent</strong> and press{" "}
          <strong>Copy the setup prompt for your agent</strong>: it includes a one-time link command
          for your space. Paste it to your agent, then approve the machine in the app when it asks.
        </p>
        <p>
          You can also start here: this prompt has the agent generate a QR code or pairing text for
          you to scan or paste in the app under Devices → Add device:
        </p>
        <pre>{agentSetupPrompt()}</pre>
      </>
    ),
  },
  {
    id: "link",
    title: "Link a machine yourself",
    body: (
      <>
        <p>
          In the app, open <strong>Devices → Add device → Agent</strong> and copy the command. Run
          it on the machine:
        </p>
        <pre>{CLI_LINK_PLACEHOLDER}</pre>
        <p>
          It prints a short code, and the app shows the same one next to the machine's name. Approve
          it there and the command finishes by itself. An invitation works once and expires after{" "}
          {PAIRING_TTL_LABEL}. Add <code>--name "Build server"</code> to choose how the machine
          appears in the space; it defaults to its hostname.
        </p>
      </>
    ),
  },
  {
    id: "send",
    title: "Send",
    body: (
      <>
        <pre>
          {[
            CLI_SEND_EXAMPLE,
            'npx -y sendself send -m "Nightly results" chart.png log.txt',
            'npx -y sendself send -m "Deploy finished"',
            'echo "Deploy finished" | npx -y sendself send',
          ].join("\n")}
        </pre>
        <p>
          Files go up to {MAX_FILE_LABEL} each. Several files arrive as one album, with the text as
          their caption. <code>--view-once</code> deletes the message from every device once one of
          them opens it. The command exits with 0 when everything is on its way, 1 when something
          failed and 2 when it was used wrongly, so scripts and agents can rely on it.
        </p>
        <p>To teach an agent that is already linked, add this to its instructions:</p>
        <pre>{AGENT_INSTRUCTIONS}</pre>
      </>
    ),
  },
  {
    id: "security",
    title: "How the link is protected",
    body: (
      <>
        <p>
          The invitation is a slot and a secret that never reaches the server. The machine seals its
          answer with that secret, over the keys it publishes, so the app can tell those keys came
          from whoever holds the command, just as scanning a QR code would prove. You still approve
          it by name and code before it gets the space's key, because a command pasted into a chat
          can travel further than intended.
        </p>
        <p>
          The link lives in one file on that machine, <code>~/.config/sendself/device.json</code> (
          <code>SENDSELF_HOME</code> moves it), readable only by the account that created it. It
          holds the space's keys and has no passphrase, because the command line runs unattended:
          treat it like an unlocked phone that is signed in to the space.
        </p>
      </>
    ),
  },
  {
    id: "revoke",
    title: "Unlink and revoke",
    body: (
      <>
        <p>
          Revoke the machine from <strong>Devices</strong> in the app, like any other device. It
          loses access at once and the space's key rotates, so it cannot read anything sent
          afterwards. <code>npx -y sendself unlink</code> forgets the link on the machine itself.
        </p>
        <p>
          The <a href={CLI_SOURCE_URL}>source code</a> is part of the SendSelf repository.
        </p>
      </>
    ),
  },
];

export function CliPage(): JSX.Element {
  return (
    <DocPage
      page="cli"
      kicker="Command line"
      title="Let your agents and scripts send you things"
      lead="The sendself command line sends files and messages to your devices from a server, a script or an AI agent, end-to-end encrypted like everything in SendSelf."
      updated="2026-09-30"
      highlights={[
        {
          icon: Bot,
          title: "Set up by your agent",
          body: "Copy one prompt from the app and your agent links itself. You approve it with a tap.",
        },
        {
          icon: Send,
          title: "Send-only",
          body: "It can send to your space and never receives anything from it.",
        },
        {
          icon: KeyRound,
          title: "Encrypted where it runs",
          body: "Files are encrypted and signed on that machine. The server only sees ciphertext.",
        },
        {
          icon: Terminal,
          title: "Nothing to install",
          body: "One npx command with Node.js 20 or newer. Revoke it from the app at any time.",
        },
      ]}
      sections={SECTIONS}
    />
  );
}
