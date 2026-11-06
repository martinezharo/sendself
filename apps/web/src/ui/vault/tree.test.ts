import type { VaultItemKind, VaultItemRecord } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../../state/vaultItems";
import { canMoveInto, flattenTree, folderOptions, groupChildren } from "./tree";

function item(
  id: string,
  kind: VaultItemKind,
  parentId: string | null,
  name: string | null,
  updatedAt = 0,
): VaultEntry {
  const record: VaultItemRecord = {
    id,
    parentId,
    kind,
    keyEpoch: 1,
    meta: "",
    metaIv: "",
    blobKey: kind === "folder" ? null : `blob-${id}`,
    blobSize: 0,
    revision: 1,
    createdAt: 0,
    updatedAt,
    trashedAt: null,
    seq: 1,
  };
  return { record, meta: name === null ? null : { name } };
}

const entries = [
  item("photos", "folder", null, "Photos"),
  item("archive", "folder", null, "archive"),
  item("old", "file", null, "old.txt", 1),
  item("new", "note", null, "Todo", 5),
  item("trip", "folder", "photos", "Trip"),
  item("beach", "file", "trip", "beach.jpg", 3),
  item("locked", "folder", null, null),
];
const records = new Map(entries.map((entry) => [entry.record.id, entry.record]));
const children = groupChildren(entries);

function names(rows: ReturnType<typeof flattenTree>): string[] {
  return rows.map((row) =>
    row.kind === "empty"
      ? `${"  ".repeat(row.depth)}(empty)`
      : `${"  ".repeat(row.depth)}${row.entry.meta?.name ?? "?"}`,
  );
}

describe("flattenTree", () => {
  it("lists folders by name, then the rest newest first, with closed folders shut", () => {
    expect(names(flattenTree(children, null, new Set()))).toEqual([
      "archive",
      "Photos",
      "?",
      "Todo",
      "old.txt",
    ]);
  });

  it("descends into open folders only, and marks an open empty one", () => {
    const rows = flattenTree(children, null, new Set(["photos", "trip", "archive"]));
    expect(names(rows)).toEqual([
      "archive",
      "  (empty)",
      "Photos",
      "  Trip",
      "    beach.jpg",
      "?",
      "Todo",
      "old.txt",
    ]);
  });

  it("hangs from a folder when given one", () => {
    expect(names(flattenTree(children, "photos", new Set(["trip"])))).toEqual([
      "Trip",
      "  beach.jpg",
    ]);
  });

  it("never opens a folder this device can't read", () => {
    const rows = flattenTree(children, null, new Set(["locked"]));
    expect(
      rows.find((row) => row.kind === "item" && row.entry.record.id === "locked"),
    ).toMatchObject({ expanded: false });
  });
});

describe("canMoveInto", () => {
  const get = (id: string): VaultEntry => {
    const found = entries.find((entry) => entry.record.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it("refuses where the item already is", () => {
    expect(canMoveInto(get("trip"), "photos", records)).toBe(false);
    expect(canMoveInto(get("old"), null, records)).toBe(false);
  });

  it("refuses a folder into itself or anything inside it", () => {
    expect(canMoveInto(get("photos"), "photos", records)).toBe(false);
    expect(canMoveInto(get("photos"), "trip", records)).toBe(false);
  });

  it("allows anywhere else", () => {
    expect(canMoveInto(get("trip"), null, records)).toBe(true);
    expect(canMoveInto(get("trip"), "archive", records)).toBe(true);
    expect(canMoveInto(get("beach"), "photos", records)).toBe(true);
  });
});

describe("folderOptions", () => {
  it("offers the readable folders as a tree, without the item's own subtree", () => {
    const options = folderOptions(children, entries[0] as VaultEntry, records);
    expect(options.map((option) => [option.entry.record.id, option.depth])).toEqual([
      ["archive", 0],
    ]);
    const forFile = folderOptions(children, entries[2] as VaultEntry, records);
    expect(forFile.map((option) => [option.entry.record.id, option.depth])).toEqual([
      ["archive", 0],
      ["photos", 0],
      ["trip", 1],
    ]);
  });
});
