import { describe, expect, it } from "vitest";

import {
  localPathForRemote,
  remotePathForLocal,
} from "../src/sync/writable-paths";

describe("writable Pair paths", () => {
  it.each([
    ["project.md", "project.txt"],
    ["Inbox.md", "Inbox.txt"],
    ["gtd/area.md", "gtd/area.txt"],
    ["a/b/c/deep.md", "a/b/c/deep.txt"],
    ["Notes.MD", "Notes.txt"],
    ["project (Vault 0123abcd).md", "project (Vault 0123abcd).txt"],
    ["drawing.note", "drawing.note"],
    ["plain.txt", "plain.txt"],
    ["backup.md.bak", "backup.md.bak"],
    ["notes.md/inside.pdf", "notes.md/inside.pdf"],
  ])("uploads Vault %j as Remote %j", (local, remote) => {
    expect(remotePathForLocal(local)).toBe(remote);
  });

  it.each([
    ["project.txt", "project.md"],
    ["Inbox.txt", "Inbox.md"],
    ["gtd/area.txt", "gtd/area.md"],
    ["a/b/c/deep.txt", "a/b/c/deep.md"],
    ["LOG.TXT", "LOG.md"],
    ["project (Vault 0123abcd).txt", "project (Vault 0123abcd).md"],
    ["drawing.note", "drawing.note"],
    ["already.md", "already.md"],
    ["archive.txt.zip", "archive.txt.zip"],
    ["notes.txt/inside.pdf", "notes.txt/inside.pdf"],
  ])("downloads Remote %j as Vault %j", (remote, local) => {
    expect(localPathForRemote(remote)).toBe(local);
  });

  it.each(["project.md", "gtd/Inbox.md", "a/b/area.md"])(
    "round-trips %j through the Remote name",
    (local) => {
      expect(localPathForRemote(remotePathForLocal(local))).toBe(local);
    },
  );

  it("does not round-trip an upper-case Vault extension", () => {
    // Documents current behaviour: the Remote name gets a lower-case
    // ".txt" and maps back to a lower-case ".md".
    expect(localPathForRemote(remotePathForLocal("Notes.MD"))).toBe("Notes.md");
  });
});
