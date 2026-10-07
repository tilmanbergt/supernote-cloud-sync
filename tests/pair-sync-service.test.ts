import SparkMD5 from "spark-md5";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudDirectory,
  CloudFile,
  CloudItem,
  DownloadDescriptor,
  UploadResult,
} from "../src/cloud/types";
import {
  emptyPairBaseline,
  PairInventoryIncompleteError,
  PairSyncService,
  type PairBaseline,
} from "../src/sync/pair-sync-service";
import type { VaultStore } from "../src/sync/vault-store";

const checksum = (bytes: Uint8Array): string =>
  SparkMD5.ArrayBuffer.hash(Uint8Array.from(bytes).buffer);

const remoteFile = (
  id: string,
  fileName: string,
  bytes: Uint8Array,
): CloudFile => ({
  id,
  directoryId: "pair",
  fileName,
  isFolder: false,
  md5: checksum(bytes),
  size: bytes.byteLength,
  createTime: 1,
  updateTime: 1,
});

const folder = (
  id: string,
  directoryId: string,
  fileName: string,
): CloudDirectory => ({
  id,
  directoryId,
  fileName,
  isFolder: true,
  md5: "",
  size: 0,
  createTime: 1,
  updateTime: 1,
});

const remoteFolder: CloudDirectory = {
  id: "pair",
  directoryId: "0",
  fileName: "Obsidian",
  isFolder: true,
  md5: "",
  size: 0,
  createTime: 1,
  updateTime: 1,
};

class MemoryPairVault implements VaultStore {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([
    "supernote",
    "supernote/Document",
    "supernote/Document/Obsidian",
  ]);
  readonly createDirectory = vi.fn(async (path: string): Promise<void> => {
    this.directories.add(path);
  });
  readonly listDirectories = vi.fn(async (path: string): Promise<string[]> => {
    const prefix = `${path}/`;
    return [...this.directories].filter((entry) => entry.startsWith(prefix));
  });
  readonly move = vi.fn(async (from: string, to: string): Promise<void> => {
    const content = this.files.get(from);
    if (!content) {
      throw new Error(`Missing ${from}`);
    }
    this.files.set(to, content);
    this.files.delete(from);
  });
  readonly delete = vi.fn(async (path: string): Promise<void> => {
    this.files.delete(path);
    this.directories.delete(path);
  });

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async getRevision(path: string): Promise<string | null> {
    return this.files.has(path) ? "revision" : null;
  }

  async readText(): Promise<string | null> {
    return null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeText(): Promise<void> {}

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(content));
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()].filter((file) => file.startsWith(prefix));
  }
}

class MemoryPairCloud {
  readonly items = new Map<string, CloudItem>([
    [remoteFolder.id, remoteFolder],
  ]);
  readonly bytes = new Map<string, Uint8Array>();
  readonly uploadFile = vi.fn(
    async (
      directoryId: string,
      fileName: string,
      content: Uint8Array,
    ): Promise<UploadResult> => {
      const file = remoteFile(`uploaded-${fileName}`, fileName, content);
      file.directoryId = directoryId;
      this.items.set(file.id, file);
      this.bytes.set(file.id, Uint8Array.from(content));
      return { md5: file.md5 };
    },
  );
  readonly replaceFile = vi.fn(
    async (file: CloudFile, content: Uint8Array): Promise<UploadResult> => {
      file.md5 = checksum(content);
      this.bytes.set(file.id, Uint8Array.from(content));
      return { md5: file.md5 };
    },
  );
  readonly recycleItem = vi.fn(async (item: CloudItem): Promise<void> => {
    this.items.delete(item.id);
    this.bytes.delete(item.id);
  });
  readonly createDirectory = vi.fn(
    async (directoryId: string, fileName: string): Promise<void> => {
      const directory = folder(
        `created-${directoryId}-${fileName}`,
        directoryId,
        fileName,
      );
      this.items.set(directory.id, directory);
    },
  );
  readonly listDirectory = vi.fn(
    async (directoryId: string): Promise<CloudItem[]> =>
      [...this.items.values()].filter(
        (item) => item.directoryId === directoryId,
      ),
  );

  add(fileName: string, content: Uint8Array): CloudFile {
    const file = remoteFile(`remote-${fileName}`, fileName, content);
    this.items.set(file.id, file);
    this.bytes.set(file.id, Uint8Array.from(content));
    return file;
  }

  addDirectory(fileName: string): CloudDirectory {
    const directory = folder(`remote-${fileName}`, "pair", fileName);
    this.items.set(directory.id, directory);
    return directory;
  }

  async getDownloadDescriptor(fileId: string): Promise<DownloadDescriptor> {
    const file = this.items.get(fileId);
    if (!file || file.isFolder) {
      throw new Error(`Missing ${fileId}`);
    }
    return { url: `https://download.example/${fileId}`, md5: file.md5 };
  }

  async download(url: string): Promise<Uint8Array> {
    const id = new URL(url).pathname.slice(1);
    const bytes = this.bytes.get(id);
    if (!bytes) {
      throw new Error(`Missing ${id}`);
    }
    return Uint8Array.from(bytes);
  }
}

const localPath = (name: string): string =>
  `supernote/Document/Obsidian/${name}`;

const baselineFor = (
  file: CloudFile,
  bytes: Uint8Array,
  localFileName = file.fileName,
): PairBaseline => ({
  version: 1,
  initialized: true,
  entries: {
    [localFileName]: {
      localRelativePath: localFileName,
      remoteRelativePath: file.fileName,
      remoteId: file.id,
      directoryId: file.directoryId,
      fileName: file.fileName,
      checksum: checksum(bytes),
    },
  },
  directories: {},
  conflicts: {},
});

const service = (
  vault: MemoryPairVault,
  cloud: MemoryPairCloud,
): PairSyncService =>
  new PairSyncService({
    vault,
    cloud,
    targetFolder: "supernote",
    remoteFolder: "Document/Obsidian",
    remoteDirectoryId: "pair",
  });

describe("PairSyncService", () => {
  it("adopts equal current content when both sides changed from the baseline", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const now = new Uint8Array([2]);
    const file = cloud.add("equal.pdf", now);
    vault.files.set(localPath("equal.pdf"), now);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );

    expect(result.conflicts).toEqual([]);
    expect(result.unchanged).toEqual(["Document/Obsidian/equal.pdf"]);
    expect(result.baseline.entries["equal.pdf"]?.checksum).toBe(checksum(now));
    expect(cloud.replaceFile).not.toHaveBeenCalled();
  });

  it("recycles an unchanged Remote file deleted from the Vault", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("deleted-local.pdf", content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.deletedRemote).toEqual([
      "Document/Obsidian/deleted-local.pdf",
    ]);
    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(result.baseline.entries).toEqual({});
  });

  it("moves an unchanged Vault file to Trash after Remote deletion", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const missing = remoteFile("missing", "deleted-remote.pdf", content);
    vault.files.set(localPath("deleted-remote.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(missing, content),
    );

    expect(result.deletedLocal).toEqual([
      "Document/Obsidian/deleted-remote.pdf",
    ]);
    expect(vault.delete).toHaveBeenCalledWith(localPath("deleted-remote.pdf"));
    expect(result.baseline.entries).toEqual({});
  });

  it("preserves an edit when the other side deleted", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const edited = new Uint8Array([2]);
    const missing = remoteFile("missing", "edited.pdf", before);
    vault.files.set(localPath("edited.pdf"), edited);

    const result = await service(vault, cloud).reconcile(
      baselineFor(missing, before),
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "vault-edited-remote-deleted",
        localRelativePath: "edited.pdf",
      }),
    ]);
    expect(vault.files.get(localPath("edited.pdf"))).toEqual(edited);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it("does no work when a Remote inventory is incomplete", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    vault.files.set(localPath("local.pdf"), content);
    cloud.listDirectory.mockRejectedValueOnce(new Error("offline"));

    await expect(
      service(vault, cloud).reconcile(emptyPairBaseline()),
    ).rejects.toBeInstanceOf(PairInventoryIncompleteError);

    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.recycleItem).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it("requires confirmation before uploading a local-only first baseline item", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.files.set(localPath("local-only.pdf"), new Uint8Array([1]));

    const result = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "first-baseline-local-only",
        localRelativePath: "local-only.pdf",
      }),
    ]);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it("resolves a content conflict by using the Vault copy", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "use-vault" } },
    );

    expect(resolved.conflicts).toEqual([]);
    expect(resolved.uploaded).toEqual(["Document/Obsidian/resolve.pdf"]);
    expect(cloud.bytes.get(file.id)).toEqual(local);
  });

  it("resolves a content conflict by using the Remote copy", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "use-remote" } },
    );

    expect(resolved.conflicts).toEqual([]);
    expect(resolved.downloaded).toEqual(["Document/Obsidian/resolve.pdf"]);
    expect(vault.files.get(localPath("resolve.pdf"))).toEqual(remote);
  });

  it("keeps both divergent copies under stable Pair paths", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = new Uint8Array([1]);
    const local = new Uint8Array([2]);
    const remote = new Uint8Array([3]);
    const file = cloud.add("resolve.pdf", remote);
    vault.files.set(localPath("resolve.pdf"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before),
    );
    const conflict = conflicted.conflicts[0]!;

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflict.id]: "keep-both" } },
    );

    const copyName = `resolve (Vault ${checksum(local).slice(0, 8)}).pdf`;
    expect(resolved.conflicts).toEqual([]);
    expect(vault.files.get(localPath("resolve.pdf"))).toEqual(remote);
    expect(vault.files.get(localPath(copyName))).toEqual(local);
    expect(
      [...cloud.items.values()].find(
        (item) => !item.isFolder && item.fileName === copyName,
      ),
    ).toMatchObject({ md5: checksum(local) });
    expect(Object.keys(resolved.baseline.entries).sort()).toEqual(
      [copyName, "resolve.pdf"].sort(),
    );
  });

  it("propagates one unambiguous byte-identical Vault rename", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("after.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.movedRemote).toEqual([
      "Document/Obsidian/before.pdf → Document/Obsidian/after.pdf",
    ]);
    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(
      [...cloud.items.values()].find(
        (item) => !item.isFolder && item.fileName === "after.pdf",
      ),
    ).toMatchObject({ md5: checksum(content) });
    expect(Object.keys(result.baseline.entries)).toEqual(["after.pdf"]);
  });

  it("moves the Vault copy when the Remote item was renamed", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("before.pdf"), content);
    const baseline = baselineFor(file, content);
    file.fileName = "after.pdf";

    const result = await service(vault, cloud).reconcile(baseline);

    expect(result.movedLocal).toEqual([
      "Document/Obsidian/before.pdf → Document/Obsidian/after.pdf",
    ]);
    expect(vault.move).toHaveBeenCalledWith(
      localPath("before.pdf"),
      localPath("after.pdf"),
    );
    expect(Object.keys(result.baseline.entries)).toEqual(["after.pdf"]);
  });

  it("does not guess a Vault rename when identical candidates are ambiguous", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = new Uint8Array([1]);
    const file = cloud.add("before.pdf", content);
    vault.files.set(localPath("candidate-a.pdf"), content);
    vault.files.set(localPath("candidate-b.pdf"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "ambiguous-rename",
        localRelativePath: "before.pdf",
      }),
    ]);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.recycleItem).not.toHaveBeenCalled();
  });

  it("preserves an empty Remote directory in the Vault", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    cloud.addDirectory("Empty");

    const result = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(vault.createDirectory).toHaveBeenCalledWith(
      "supernote/Document/Obsidian/Empty",
    );
    expect(result.createdLocalDirectories).toEqual(["Document/Obsidian/Empty"]);
    expect(result.baseline.directories.Empty).toMatchObject({
      remoteRelativePath: "Empty",
    });
  });

  it("creates a new empty Vault directory in the Remote Pair after baseline", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.directories.add("supernote/Document/Obsidian/Empty");
    const baseline = emptyPairBaseline();
    baseline.initialized = true;

    const result = await service(vault, cloud).reconcile(baseline);

    expect(cloud.createDirectory).toHaveBeenCalledWith("pair", "Empty");
    expect(result.createdRemoteDirectories).toEqual([
      "Document/Obsidian/Empty",
    ]);
  });

  it("requires confirmation before uploading a first-baseline empty local directory", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.directories.add("supernote/Document/Obsidian/Empty");

    const first = await service(vault, cloud).reconcile(emptyPairBaseline());

    expect(first.conflicts).toEqual([
      expect.objectContaining({
        kind: "first-baseline-local-only-directory",
        localRelativePath: "Empty",
      }),
    ]);
    expect(cloud.createDirectory).not.toHaveBeenCalled();

    const resolved = await service(vault, cloud).reconcile(first.baseline, {
      resolutions: { [first.conflicts[0]!.id]: "use-vault" },
    });
    expect(cloud.createDirectory).toHaveBeenCalledWith("pair", "Empty");
    expect(resolved.baseline.conflicts).toEqual({});
  });

  it("propagates deletion of an unchanged empty Vault directory", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const directory = cloud.addDirectory("Empty");
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    baseline.directories.Empty = {
      localRelativePath: "Empty",
      remoteRelativePath: "Empty",
      remoteId: directory.id,
      directoryId: directory.directoryId,
      fileName: directory.fileName,
    };

    const result = await service(vault, cloud).reconcile(baseline);

    expect(cloud.recycleItem).toHaveBeenCalledWith(directory);
    expect(result.deletedRemoteDirectories).toEqual([
      "Document/Obsidian/Empty",
    ]);
  });

  it("checkpoints each verified success before a later operation fails", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.files.set(localPath("a.pdf"), new Uint8Array([1]));
    vault.files.set(localPath("b.pdf"), new Uint8Array([2]));
    const baseline = emptyPairBaseline();
    baseline.initialized = true;
    cloud.uploadFile.mockImplementationOnce(
      async (directoryId, fileName, content) => {
        const file = remoteFile(`uploaded-${fileName}`, fileName, content);
        file.directoryId = directoryId;
        cloud.items.set(file.id, file);
        cloud.bytes.set(file.id, Uint8Array.from(content));
        return { md5: file.md5 };
      },
    );
    cloud.uploadFile.mockRejectedValueOnce(new Error("network stopped"));
    const checkpoints: PairBaseline[] = [];

    await expect(
      service(vault, cloud).reconcile(baseline, {
        onBaselineChange: (next) => {
          checkpoints.push(next);
        },
      }),
    ).rejects.toThrow("network stopped");

    expect(checkpoints.at(-1)?.entries["a.pdf"]).toBeDefined();
    expect(checkpoints.at(-1)?.entries["b.pdf"]).toBeUndefined();
  });
});

describe("PairSyncService text mapping", () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  const addIn = (
    cloud: MemoryPairCloud,
    directoryId: string,
    fileName: string,
    content: Uint8Array,
  ): CloudFile => {
    const file = remoteFile(
      `remote-${directoryId}-${fileName}`,
      fileName,
      content,
    );
    file.directoryId = directoryId;
    cloud.items.set(file.id, file);
    cloud.bytes.set(file.id, Uint8Array.from(content));
    return file;
  };

  const remoteFileNames = (cloud: MemoryPairCloud): string[] =>
    [...cloud.items.values()]
      .filter((item) => !item.isFolder)
      .map((item) => item.fileName)
      .sort();

  const uploadedNames = (cloud: MemoryPairCloud): string[] =>
    cloud.uploadFile.mock.calls.map(([, fileName]) => fileName);

  const initializedBaseline = (): PairBaseline => ({
    ...emptyPairBaseline(),
    initialized: true,
  });

  const pairedEntry = (
    baseline: PairBaseline,
    localRelativePath: string,
    remoteRelativePath: string,
    file: CloudFile,
    content: Uint8Array,
  ): PairBaseline => {
    baseline.entries[localRelativePath] = {
      localRelativePath,
      remoteRelativePath,
      remoteId: file.id,
      directoryId: file.directoryId,
      fileName: file.fileName,
      checksum: checksum(content),
    };
    return baseline;
  };

  it("downloads a Remote .txt file as a Vault .md file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = text("- [ ] task\n");
    cloud.add("project.txt", content);

    const result = await service(vault, cloud).reconcile(initializedBaseline());

    expect(result.downloaded).toEqual(["Document/Obsidian/project.txt"]);
    expect(vault.files.get(localPath("project.md"))).toEqual(content);
    expect(vault.files.has(localPath("project.txt"))).toBe(false);
    expect(result.baseline.entries["project.md"]).toMatchObject({
      localRelativePath: "project.md",
      remoteRelativePath: "project.txt",
      fileName: "project.txt",
    });
  });

  it("uploads a new Vault .md file as a Remote .txt file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = text("# Inbox\n");
    vault.files.set(localPath("Inbox.md"), content);

    const result = await service(vault, cloud).reconcile(initializedBaseline());

    expect(uploadedNames(cloud)).toEqual(["Inbox.txt"]);
    expect(result.uploaded).toEqual(["Document/Obsidian/Inbox.txt"]);
    expect(remoteFileNames(cloud)).toEqual(["Inbox.txt"]);
    expect(result.baseline.entries["Inbox.md"]).toMatchObject({
      remoteRelativePath: "Inbox.txt",
    });
  });

  it("replaces the Remote .txt file when the Vault .md file is edited", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = text("- [ ] a\n");
    const after = text("- [x] a\n");
    const file = cloud.add("area.txt", before);
    vault.files.set(localPath("area.md"), after);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, before, "area.md"),
    );

    expect(cloud.replaceFile).toHaveBeenCalledWith(file, after);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual(["Document/Obsidian/area.txt"]);
    expect(cloud.bytes.get(file.id)).toEqual(after);
    expect(remoteFileNames(cloud)).toEqual(["area.txt"]);
  });

  it("writes a Remote .txt edit to the Vault .md file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = text("- [ ] a\n");
    const after = text("- [ ] a\n- [ ] b\n");
    const file = cloud.add("area.txt", after);
    vault.files.set(localPath("area.md"), before);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, before, "area.md"),
    );

    expect(result.downloaded).toEqual(["Document/Obsidian/area.txt"]);
    expect(vault.files.get(localPath("area.md"))).toEqual(after);
    expect(vault.files.has(localPath("area.txt"))).toBe(false);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.replaceFile).not.toHaveBeenCalled();
  });

  it("recycles the Remote .txt file when the unchanged Vault .md file is deleted", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = text("old\n");
    const file = cloud.add("old.txt", content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content, "old.md"),
    );

    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(result.deletedRemote).toEqual(["Document/Obsidian/old.txt"]);
  });

  it("uploads a Vault .md rename under the renamed Remote .txt name", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = text("same\n");
    const file = cloud.add("before.txt", content);
    vault.files.set(localPath("after.md"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content, "before.md"),
    );

    expect(uploadedNames(cloud)).toEqual(["after.txt"]);
    expect(cloud.recycleItem).toHaveBeenCalledWith(file);
    expect(result.movedRemote).toEqual([
      "Document/Obsidian/before.txt → Document/Obsidian/after.txt",
    ]);
    expect(Object.keys(result.baseline.entries)).toEqual(["after.md"]);
  });

  it("maps .txt files inside nested Remote folders", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const gtd = cloud.addDirectory("gtd");
    const archive = folder("remote-gtd-archive", gtd.id, "archive");
    cloud.items.set(archive.id, archive);
    const project = text("project\n");
    const old = text("old\n");
    addIn(cloud, gtd.id, "project.txt", project);
    addIn(cloud, archive.id, "2025.txt", old);

    const result = await service(vault, cloud).reconcile(initializedBaseline());

    expect(vault.files.get(localPath("gtd/project.md"))).toEqual(project);
    expect(vault.files.get(localPath("gtd/archive/2025.md"))).toEqual(old);
    expect(result.downloaded.sort()).toEqual([
      "Document/Obsidian/gtd/archive/2025.txt",
      "Document/Obsidian/gtd/project.txt",
    ]);
    expect(result.baseline.entries["gtd/archive/2025.md"]).toMatchObject({
      remoteRelativePath: "gtd/archive/2025.txt",
    });
  });

  it("uploads a new nested Vault .md file as .txt into the matching Remote folder", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const gtd = cloud.addDirectory("gtd");
    vault.directories.add(localPath("gtd"));
    const content = text("new\n");
    vault.files.set(localPath("gtd/Inbox.md"), content);

    const result = await service(vault, cloud).reconcile(initializedBaseline());

    expect(cloud.uploadFile).toHaveBeenCalledWith(gtd.id, "Inbox.txt", content);
    expect(result.uploaded).toEqual(["Document/Obsidian/gtd/Inbox.txt"]);
    expect(result.baseline.entries["gtd/Inbox.md"]).toMatchObject({
      remoteRelativePath: "gtd/Inbox.txt",
    });
  });

  it("does not rename a Remote folder whose name ends in .txt", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const notes = cloud.addDirectory("notes.txt");
    const content = text("inside\n");
    addIn(cloud, notes.id, "inside.txt", content);

    await service(vault, cloud).reconcile(initializedBaseline());

    expect(vault.createDirectory).toHaveBeenCalledWith(localPath("notes.txt"));
    expect(vault.files.get(localPath("notes.txt/inside.md"))).toEqual(content);
  });

  it("follows a Remote folder rename for a mapped file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const renamed = cloud.addDirectory("gtd-2026");
    vault.directories.add(localPath("gtd"));
    const content = text("same\n");
    const file = addIn(cloud, renamed.id, "project.txt", content);
    vault.files.set(localPath("gtd/project.md"), content);
    const baseline = pairedEntry(
      initializedBaseline(),
      "gtd/project.md",
      "gtd/project.txt",
      file,
      content,
    );

    const result = await service(vault, cloud).reconcile(baseline);

    expect(vault.move).toHaveBeenCalledWith(
      localPath("gtd/project.md"),
      localPath("gtd-2026/project.md"),
    );
    expect(Object.keys(result.baseline.entries)).toEqual([
      "gtd-2026/project.md",
    ]);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.recycleItem).not.toHaveBeenCalled();
  });

  it("keeps both conflicting copies as .md in the Vault and .txt in the Remote", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = text("before\n");
    const local = text("vault edit\n");
    const remote = text("device edit\n");
    const file = cloud.add("project.txt", remote);
    vault.files.set(localPath("project.md"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before, "project.md"),
    );
    expect(conflicted.conflicts).toEqual([
      expect.objectContaining({
        kind: "both-edited",
        localRelativePath: "project.md",
        remoteRelativePath: "project.txt",
      }),
    ]);

    const resolved = await service(vault, cloud).reconcile(
      conflicted.baseline,
      { resolutions: { [conflicted.conflicts[0]!.id]: "keep-both" } },
    );

    const stem = `project (Vault ${checksum(local).slice(0, 8)})`;
    expect(resolved.conflicts).toEqual([]);
    expect(vault.files.get(localPath("project.md"))).toEqual(remote);
    expect(vault.files.get(localPath(`${stem}.md`))).toEqual(local);
    expect(vault.files.has(localPath(`${stem}.txt`))).toBe(false);
    expect(uploadedNames(cloud)).toEqual([`${stem}.txt`]);
    expect(remoteFileNames(cloud)).toEqual([`${stem}.txt`, "project.txt"]);
    expect(resolved.baseline.entries[`${stem}.md`]).toMatchObject({
      remoteRelativePath: `${stem}.txt`,
    });
  });

  it("resolves a mapped conflict with the Vault copy by replacing the Remote .txt", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const before = text("before\n");
    const local = text("vault edit\n");
    const file = cloud.add("project.txt", text("device edit\n"));
    vault.files.set(localPath("project.md"), local);
    const conflicted = await service(vault, cloud).reconcile(
      baselineFor(file, before, "project.md"),
    );

    await service(vault, cloud).reconcile(conflicted.baseline, {
      resolutions: { [conflicted.conflicts[0]!.id]: "use-vault" },
    });

    expect(cloud.replaceFile).toHaveBeenCalledWith(file, local);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(remoteFileNames(cloud)).toEqual(["project.txt"]);
  });

  it("keeps a legacy baseline entry that tracks a Vault .txt file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    const content = text("legacy\n");
    const file = cloud.add("legacy.txt", content);
    vault.files.set(localPath("legacy.txt"), content);

    const result = await service(vault, cloud).reconcile(
      baselineFor(file, content),
    );

    expect(result.unchanged).toEqual(["Document/Obsidian/legacy.txt"]);
    expect(Object.keys(result.baseline.entries)).toEqual(["legacy.txt"]);
    expect(vault.files.has(localPath("legacy.md"))).toBe(false);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it("stops when Remote .txt and .md files map to the same Vault file", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    cloud.add("project.txt", text("txt\n"));
    cloud.add("project.md", text("md\n"));

    await expect(
      service(vault, cloud).reconcile(initializedBaseline()),
    ).rejects.toBeInstanceOf(PairInventoryIncompleteError);
    expect(vault.files.size).toBe(0);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  // Known bug in the current Pair mapping (docs/extension-mapping.md, 1.3):
  // switch to `it` once the Pair blocks this case instead of uploading.
  it.fails(
    "does not upload a second Remote .txt when the Vault holds x.txt and a paired x.md",
    async () => {
      const vault = new MemoryPairVault();
      const cloud = new MemoryPairCloud();
      const content = text("- [ ] task\n");
      const file = cloud.add("project.txt", content);
      vault.files.set(localPath("project.md"), content);
      vault.files.set(localPath("project.txt"), text("stale copy\n"));

      await service(vault, cloud).reconcile(
        baselineFor(file, content, "project.md"),
      );

      expect(cloud.uploadFile).not.toHaveBeenCalled();
      expect(cloud.recycleItem).not.toHaveBeenCalled();
      expect(remoteFileNames(cloud)).toEqual(["project.txt"]);
      expect(cloud.bytes.get(file.id)).toEqual(content);
    },
  );

  // Known bug in the current Pair mapping (docs/extension-mapping.md, 1.3):
  // switch to `it` once the Pair blocks this case instead of uploading.
  it.fails(
    "does not upload a second Remote .txt on a first baseline with Vault x.txt and x.md",
    async () => {
      const vault = new MemoryPairVault();
      const cloud = new MemoryPairCloud();
      const content = text("- [ ] task\n");
      cloud.add("project.txt", content);
      vault.files.set(localPath("project.md"), content);
      vault.files.set(localPath("project.txt"), text("stale copy\n"));

      const first = await service(vault, cloud).reconcile(emptyPairBaseline());
      const resolutions = Object.fromEntries(
        first.conflicts.map((conflict) => [conflict.id, "use-vault" as const]),
      );
      await service(vault, cloud).reconcile(first.baseline, { resolutions });

      expect(cloud.uploadFile).not.toHaveBeenCalled();
      expect(remoteFileNames(cloud)).toEqual(["project.txt"]);
    },
  );

  // Known bug in the current Pair mapping (docs/extension-mapping.md, 1.3):
  // switch to `it` once the Pair blocks this case instead of uploading.
  it.fails(
    "does not delete the paired Remote .txt when the Vault x.md is removed but x.txt remains",
    async () => {
      const vault = new MemoryPairVault();
      const cloud = new MemoryPairCloud();
      const content = text("- [ ] task\n");
      const file = cloud.add("project.txt", content);
      vault.files.set(localPath("project.txt"), content);

      await service(vault, cloud).reconcile(
        baselineFor(file, content, "project.md"),
      );

      expect(cloud.recycleItem).not.toHaveBeenCalled();
      expect(cloud.uploadFile).not.toHaveBeenCalled();
      expect(remoteFileNames(cloud)).toEqual(["project.txt"]);
    },
  );

  it("never uploads a file name ending in .md", async () => {
    const vault = new MemoryPairVault();
    const cloud = new MemoryPairCloud();
    vault.files.set(localPath("a.md"), text("a\n"));
    vault.files.set(localPath("B.MD"), text("b\n"));
    vault.files.set(localPath("nested/c.md"), text("c\n"));

    await service(vault, cloud).reconcile(initializedBaseline());

    expect(uploadedNames(cloud).sort()).toEqual(["B.txt", "a.txt", "c.txt"]);
    expect(uploadedNames(cloud).filter((name) => /\.md$/i.test(name))).toEqual(
      [],
    );
  });
});
