/**
 * What the site and the app tell people (and their agents) to run.
 *
 * One place for the commands and the setup prompt, so the landing page, the
 * "Agent" pairing dialog and the CLI's own help cannot drift apart.
 * The CLI is published to npm as `sendself`; `npx -y` runs the latest release
 * without installing anything or stopping to ask.
 */

import { SERVICE_ORIGIN } from "@sendself/shared";

const NPX = "npx -y sendself";

export const CLI_SEND_EXAMPLE = `${NPX} send report.pdf`;
export const CLI_LINK_PLACEHOLDER = `${NPX} link <code>`;

/**
 * The command that answers an invitation from this origin. The server flag is
 * only spelled out when it is not the default, which keeps the command a person
 * copies from the real service short.
 */
export function linkCommand(code: string, origin: string): string {
  const server = origin === SERVICE_ORIGIN ? "" : ` --server ${origin}`;
  return `${NPX} link ${code}${server}`;
}

/** The lines an agent keeps in its standing instructions. */
export const AGENT_INSTRUCTIONS = `Use \`${NPX} send <files>\` to send me files, or \`${NPX} send -m "text"\` to send me a message.`;

/** Use the app's invitation when provided; otherwise let the CLI generate a code. */
export function agentSetupPrompt(command?: string): string {
  const approval = command
    ? "wait for me to approve it in SendSelf"
    : "show me the QR code or pairing text it prints so I can add it in SendSelf under Devices → Add device, and wait for approval";
  return `Run this command and ${approval}:
${command ?? `${NPX} link`}

After it succeeds, remember in your persistent instructions (CLAUDE.md, AGENTS.md or equivalent):
${AGENT_INSTRUCTIONS}

Do not replace an existing link without asking me.`;
}
