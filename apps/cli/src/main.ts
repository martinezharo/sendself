/**
 * `sendself`: send files and text to your SendSelf devices from a terminal, a
 * script or an agent, end-to-end encrypted like everything the app sends.
 *
 * Output contract, since scripts and agents are the main users: results go to
 * stdout, progress and errors to stderr, and the exit code says how it went
 * (0 success, 1 failure, 2 wrong usage).
 */

import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, NetworkError } from "@sendself/client/api";
import { assertWebCryptoAvailable } from "@sendself/client/crypto";
import { DEFAULT_SERVER, devicePath, isLinked, loadDevice, removeDevice } from "./config";
import { link } from "./link";
import { mimeFor } from "./mime";
import { type OutgoingFile, sendAll } from "./send";
import { apiFor, syncKeys } from "./session";

declare const __SENDSELF_CLI_VERSION__: string | undefined;
const VERSION = typeof __SENDSELF_CLI_VERSION__ === "string" ? __SENDSELF_CLI_VERSION__ : "dev";

const HELP = `sendself — send files and text to your SendSelf devices

Usage:
  sendself send [options] [FILE...]   Send files, text, or both
  sendself link [options]             Link this machine to a space (once)
  sendself status                     Show which space this machine sends to
  sendself unlink                     Forget the link on this machine

send:
  -m, --message TEXT   Text to send; with files, their caption. "-" reads stdin.
      --view-once      Delete it from every device once one of them opens it
  With no FILE and no --message, text is read from stdin when it is piped.

link:
  -n, --name NAME      How this machine appears in the space (default: hostname)
      --server URL     SendSelf server (default: ${DEFAULT_SERVER})
      --force          Replace an existing link on this machine

Environment:
  SENDSELF_HOME        Directory holding the link (default: ~/.config/sendself)

Examples:
  sendself send report.pdf
  sendself send -m "Build finished" screenshot.png logs.txt
  echo "Deploy done" | sendself send
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "send":
      return runSend(rest);
    case "link":
      return runLink(rest);
    case "status":
      return runStatus(rest);
    case "unlink":
      return runUnlink(rest);
    case "-v":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

async function runSend(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    message: { type: "string", short: "m" },
    "view-once": { type: "boolean" },
  });

  let text = values.message;
  if (text === "-" || (text === undefined && positionals.length === 0 && !process.stdin.isTTY)) {
    text = await readStdin();
  }
  if (!text && positionals.length === 0) {
    throw new UsageError("Nothing to send: give a file, --message, or pipe text in.");
  }

  const files = await Promise.all(positionals.map(describeFile));
  const device = await loadDevice();
  let sent = 0;
  await sendAll(
    device,
    apiFor(device.server),
    { ...(text ? { text } : {}), files, viewOnce: values["view-once"] === true },
    {
      onSent: (message) => {
        sent++;
        process.stdout.write(
          message.file
            ? `Sent ${message.file.name} (${formatSize(message.file.size)})\n`
            : "Sent message\n",
        );
      },
    },
  );
  if (sent === 0) process.stdout.write("Nothing sent\n");
  return 0;
}

async function runLink(args: string[]): Promise<number> {
  const { values } = parse(args, {
    name: { type: "string", short: "n" },
    server: { type: "string" },
    force: { type: "boolean" },
  });
  if (!values.force && (await isLinked())) {
    const device = await loadDevice();
    throw new UsageError(
      `Already linked as "${device.deviceName}" (${devicePath()}). Use --force to replace it, and revoke the old one from the app.`,
    );
  }

  const server = normalizeServer(values.server ?? DEFAULT_SERVER);
  const deviceName = (values.name ?? (await defaultName())).trim();
  if (!deviceName) throw new UsageError("The device name cannot be empty.");

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new Error("Linking cancelled."));
  process.once("SIGINT", onInterrupt);
  try {
    const device = await link({
      server,
      deviceName,
      print: (line) => process.stderr.write(`${line}\n`),
      signal: controller.signal,
    });
    process.stdout.write(
      `Linked to ${device.spaceName ? `"${device.spaceName}"` : "the space"} as "${device.deviceName}". Send with: sendself send FILE\n`,
    );
    return 0;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function runStatus(args: string[]): Promise<number> {
  parse(args, {});
  const device = await loadDevice();
  const { device: synced, groupKeyEpoch } = await syncKeys(device, apiFor(device.server));
  const lines = [
    `Server:  ${synced.server}`,
    `Space:   ${synced.spaceName ? `${synced.spaceName} (${synced.groupId})` : synced.groupId}`,
    `Device:  ${synced.deviceName} (${synced.deviceId}), send-only`,
    `Key:     epoch ${synced.keyring.current}${synced.keyring.current < groupKeyEpoch ? ` — the space is at ${groupKeyEpoch}; waiting for the new key` : ""}`,
    `Link:    ${devicePath()}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function runUnlink(args: string[]): Promise<number> {
  parse(args, {});
  if (!(await isLinked())) {
    process.stdout.write("Not linked; nothing to do.\n");
    return 0;
  }
  const device = await loadDevice().catch(() => null);
  await removeDevice();
  process.stdout.write(
    `Forgot the link${device ? ` as "${device.deviceName}"` : ""}. Revoke it from Devices in the app so the space stops trusting it.\n`,
  );
  return 0;
}

type Options = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;

function parse<const T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true } as const);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function describeFile(path: string): Promise<OutgoingFile> {
  const absolute = resolve(path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new UsageError(`Not a file: ${path}`);
    size = info.size;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${path}`);
  }
  const name = basename(absolute);
  return { path: absolute, name, size, mime: mimeFor(name) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
}

async function defaultName(): Promise<string> {
  const { hostname } = await import("node:os");
  return hostname();
}

function normalizeServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UsageError(`Not a URL: ${server}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new UsageError("The server must use https (plain http only works for localhost).");
  }
  return url.origin;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof NetworkError) return `Could not reach the server: ${error.message}`;
  if (error instanceof ApiError) return `The server refused: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

try {
  assertWebCryptoAvailable();
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`sendself: ${describeError(error)}\n`);
  if (error instanceof UsageError) process.stderr.write("Run sendself --help for usage.\n");
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
