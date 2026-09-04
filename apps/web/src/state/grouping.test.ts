import { describe, expect, it } from "vitest";
import type { LocalEvent, LocalMessage } from "../types";
import { albumCaption, chatEntries, groupMessages } from "./grouping";

function message(
  id: string,
  overrides: Partial<LocalMessage> & { batch?: LocalMessage["batch"] } = {},
): LocalMessage {
  return {
    id,
    direction: "in",
    senderDeviceId: "device-a",
    createdAt: 1_000,
    status: "sent",
    ...overrides,
  };
}

function batch(id: string, index: number, count: number): LocalMessage["batch"] {
  return { id, index, count };
}

describe("groupMessages", () => {
  it("leaves messages without a batch alone", () => {
    const list = [message("a", { text: "hi" }), message("b", { text: "there" })];

    expect(groupMessages(list)).toEqual([
      { kind: "single", key: "a", message: list[0] },
      { kind: "single", key: "b", message: list[1] },
    ]);
  });

  it("collapses a run of one batch into a single album", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 3) }),
      message("b", { batch: batch("b1", 1, 3) }),
      message("c", { batch: batch("b1", 2, 3) }),
    ];

    const entries = groupMessages(list);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "album", expected: 3 });
    expect((entries[0] as { messages: LocalMessage[] }).messages.map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("orders an album by the index it was picked with, not by arrival", () => {
    const list = [
      message("c", { batch: batch("b1", 2, 3) }),
      message("a", { batch: batch("b1", 0, 3) }),
      message("b", { batch: batch("b1", 1, 3) }),
    ];

    const [album] = groupMessages(list) as unknown as [{ messages: LocalMessage[] }];

    expect(album.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("reports a partial album rather than pretending it is complete", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 5) }),
      message("b", { batch: batch("b1", 1, 5) }),
    ];

    expect(groupMessages(list)[0]).toMatchObject({ kind: "album", expected: 5 });
  });

  it("never reorders the thread: an interleaved message splits the batch", () => {
    // The batch is several sends and `createdAt` comes from the server, so
    // another device's message really can land in the middle of one.
    const list = [
      message("a", { batch: batch("b1", 0, 3) }),
      message("interruption", { senderDeviceId: "device-b", text: "wait" }),
      message("b", { batch: batch("b1", 1, 3) }),
      message("c", { batch: batch("b1", 2, 3) }),
    ];

    const entries = groupMessages(list);

    expect(entries.map((e) => e.kind)).toEqual(["single", "single", "album"]);
    expect(entries[0]).toMatchObject({ key: "a" });
    expect(entries[2]).toMatchObject({ key: "batch:b" });
  });

  it("gives two runs of the same batch distinct keys", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 4) }),
      message("b", { batch: batch("b1", 1, 4) }),
      message("interruption", { senderDeviceId: "device-b" }),
      message("c", { batch: batch("b1", 2, 4) }),
      message("d", { batch: batch("b1", 3, 4) }),
    ];

    const keys = groupMessages(list).map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not draw an album around a lone survivor of a batch", () => {
    // The siblings were deleted, or have not arrived yet.
    const list = [message("a", { batch: batch("b1", 0, 3) })];

    expect(groupMessages(list)).toEqual([{ kind: "single", key: "a", message: list[0] }]);
  });

  it("does not merge batches from two different senders", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 2) }),
      message("b", { senderDeviceId: "device-b", batch: batch("b1", 1, 2) }),
    ];

    expect(groupMessages(list).map((e) => e.kind)).toEqual(["single", "single"]);
  });
});

describe("albumCaption", () => {
  it("takes the caption the sender attached to the selection", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 2), text: "the car papers" }),
      message("b", { batch: batch("b1", 1, 2) }),
    ];
    const [album] = groupMessages(list) as unknown as [Parameters<typeof albumCaption>[0]];

    expect(albumCaption(album)).toBe("the car papers");
  });

  it("still finds it when the first message of the batch is missing", () => {
    const list = [
      message("b", { batch: batch("b1", 1, 3), text: "here you go" }),
      message("c", { batch: batch("b1", 2, 3) }),
    ];
    const [album] = groupMessages(list) as unknown as [Parameters<typeof albumCaption>[0]];

    expect(albumCaption(album)).toBe("here you go");
  });

  it("is undefined when there was no caption", () => {
    const list = [
      message("a", { batch: batch("b1", 0, 2) }),
      message("b", { batch: batch("b1", 1, 2) }),
    ];
    const [album] = groupMessages(list) as unknown as [Parameters<typeof albumCaption>[0]];

    expect(albumCaption(album)).toBeUndefined();
  });
});

function notice(id: string, createdAt: number): LocalEvent {
  return { id, kind: "device-added", createdAt, deviceId: "device-b", deviceName: "iPhone" };
}

describe("chatEntries", () => {
  it("is just the grouped messages when the space has no notices", () => {
    const list = [message("a", { text: "hi" })];

    expect(chatEntries(list, [])).toEqual(groupMessages(list));
  });

  it("drops each notice where this device saw it", () => {
    const list = [message("a", { createdAt: 100 }), message("b", { createdAt: 300 })];

    expect(chatEntries(list, [notice("e1", 200)]).map((entry) => entry.key)).toEqual([
      "a",
      "event:e1",
      "b",
    ]);
  });

  it("never splits an album: a device joining says nothing about the files being sent", () => {
    const list = [
      message("a", { createdAt: 100, batch: batch("set", 0, 2) }),
      message("b", { createdAt: 300, batch: batch("set", 1, 2) }),
    ];

    const entries = chatEntries(list, [notice("e1", 200)]);

    expect(entries.map((entry) => entry.kind)).toEqual(["album", "notice"]);
  });

  it("keeps a notice that arrived after the last message at the end of the thread", () => {
    const list = [message("a", { createdAt: 100 })];

    expect(chatEntries(list, [notice("e1", 900)]).map((entry) => entry.key)).toEqual([
      "a",
      "event:e1",
    ]);
  });
});
