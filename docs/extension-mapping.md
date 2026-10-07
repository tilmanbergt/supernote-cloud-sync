# Design: `.txt` → `.md` extension mapping

Status: draft for review (phase 2). No code changes yet.

Goal: let selected plain-text Cloud files whose content is Markdown (for example
the gtdpara files `project.txt`, `area.txt`, `Inbox.txt`) appear in the vault as
`.md`, so Obsidian, Tasks and Dataview index them, while they stay `.txt` in
Supernote Cloud. Supernote Cloud refuses `.md` uploads that do not come from the
device ("This file cannot be uploaded").

## 1. What the code does today (phase 1 summary)

### 1.1 Mirror (one-way, `src/sync/sync-service.ts`, driven by `src/main.ts`)

- **Remote inventory.** `SupernoteSyncPlugin.collectCloudInventory` lists every
  folder in `data.mirroredFolders` recursively. Files inside the Paired folder
  are filtered out (`isInPushFolder`). A listing error for one mirrored folder
  sets `mirrorSnapshotComplete = false`.
- **Local state.** The Mirror manifest `<targetFolder>/.sync-manifest.json`
  (`src/sync/manifest.ts`, `SyncManifest`) keyed by **remote file id**. Each
  `SyncManifestFile` stores `remoteId`, `remotePath`, `fileName` (remote name),
  `md5` (Cloud checksum = checksum of the bytes written), and `vaultPath`. There
  is no local directory scan: the vault side is only read at the `vaultPath`
  recorded for each remote id.
- **Local path derivation.**
  `mirrorFilePath(targetFolder, remotePath, fileName)` replaces the last segment
  with `fileName` and runs every segment through `vaultSafeName`.
  `allocateMirrorPaths` resolves case-insensitive collisions by adding a
  `~<hex remote id>` suffix. `SyncService.planMirrorPaths` computes the paths
  for the whole inventory plus the manifest once per sync.
- **Additions/edits.** `SyncService.mirrorFile`: if the local file exists and
  its md5 differs from the manifest md5 (or it is not tracked, or tracked at a
  different path) → `protected` (never overwritten). Otherwise fetch the
  download descriptor; same md5 as the manifest and file present → `skipped`;
  else download and write.
- **Renames.** Identity is the remote id, so a Cloud rename or move only changes
  the planned `vaultPath`. `mirrorFile` then moves the old local copy to the new
  path (write new, trash old) **only if the old copy is unchanged and the new
  path is free**; otherwise `protected`.
- **Deletions.** `shouldRemoveMissingMirrorEntry` → `removeMirroredFile` trashes
  the local copy only when the snapshot is complete, the id is gone, and the
  local md5 still matches; an edited copy is `protected`.
- **Incomplete inventory.** Any failed folder listing → no removals and no
  directory creation/cleanup for that run (downloads of listed files continue).
- **Conflicts.** Mirror has none: local edits are protected and reported, the
  Cloud never receives anything.

### 1.2 Paired folder (two-way, `src/sync/pair-sync-service.ts`)

- **Scope.** One Cloud folder (`settings.pushFolder`, default
  `Document/Obsidian`) ↔ `<targetFolder>/<pushFolder>` in the vault.
- **Inventories.** `inventoryVault` reads every file under the folder and
  computes md5; `inventoryRemote`/`scanRemote` lists the Cloud folder
  recursively. Any read/list error, a duplicate Cloud name, or two remote items
  mapping to the same local path throws `PairInventoryIncompleteError` and the
  whole Pair run applies nothing.
- **Sync state.** `PairBaseline` in device-local instance state
  (`InstanceState.pairBaselines[<directoryId>:<pushFolder>]`,
  `src/sync/instance-state.ts`). `entries` are keyed by **local relative path**
  and store `localRelativePath`, `remoteRelativePath`, `remoteId`, `fileName`,
  `checksum` (last agreed md5). `directories` and `conflicts` likewise. After
  the run, Pair entries are also copied into the Mirror manifest (`main.ts`,
  `vaultPath = targetFolder/pushFolder/localRelativePath`).
- **Matching.** For each remote file, the local path is the baseline's
  `localRelativePath` if an entry matches by `remoteId` **or**
  `remoteRelativePath`; otherwise `localPathForRemote(remoteRelativePath)`.
  (Matching by path matters because `CloudClient.replaceFile` uploads a staging
  copy, deletes the old file and renames, so the remote id changes on every
  upload.)
- **Decisions** (three-way, per local path, against `prior.checksum`):
  local-only/remote-only with a baseline → delete on the other side if the
  survivor is unchanged, else conflict (`vault-deleted-remote-edited`,
  `vault-edited-remote-deleted`); both present → upload, download, unchanged, or
  `both-edited`. Without a baseline: equal → adopt; different →
  `first-baseline-different`; remote-only → download; local-only →
  `first-baseline-local-only` until the first baseline exists, then upload.
- **Renames.** Vault rename (`reconcileVaultRenames`): a baseline path that
  disappeared, whose remote is unchanged, and exactly one untracked local file
  with the same md5 → upload under `remotePathForLocal(new)` and recycle the old
  remote; several candidates → `ambiguous-rename`. Cloud rename: the baseline
  entry matches by id but the remote path changed → move the local file to
  `localPathForRemote(newRemotePath)` if unchanged and the destination is free,
  else `ambiguous-rename`.
- **Conflict resolution** (`resolveConflict`): `use-vault`, `use-remote`,
  `keep-both`. `keep-both` writes a local copy `name (Vault <md5 prefix>).ext`
  (`conflictCopyPath`) and uploads it to `remotePathForLocal(copy)`.

### 1.3 Important finding: the Paired folder already maps every `.txt`

`src/sync/writable-paths.ts` (present since the first public beta, untested):

```ts
remotePathForLocal(path); // "*.md"  → "*.txt" (case-insensitive suffix)
localPathForRemote(path); // "*.txt" → "*.md"
```

`PairSyncService` uses them everywhere. Verified with a throwaway test against
the existing in-memory fakes:

- remote `project.txt`, empty vault → downloads to local `project.md`;
- a new local `x.md` uploads as `x.txt`; edits upload to `x.txt`; conflict
  copies are `x (Vault …).md` locally and `x (Vault …).txt` remotely;
- **bug:** local `project.txt` **and** `project.md` with remote `project.txt` →
  `project.md` pairs with the remote, and the local `project.txt` is treated as
  a new local file whose remote name is also `project.txt`; once the baseline is
  initialized it is **uploaded as a second `project.txt`**.
- an old baseline whose entry is keyed `project.txt` keeps the local `.txt` name
  forever (the baseline's `localRelativePath` wins).

So inside the Paired folder your three files already appear as `.md`, for
**all** `.txt` files, not only listed ones. Send to Supernote's "plain text"
mode also renames `.md` → `.txt` (`send-to-supernote.ts`).

### 1.4 Every place that matches local ↔ remote by name or path

| Where                                                                                                                 | What                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `sync-service.ts` `mirrorFilePath`                                                                                    | remote path + `fileName` → vault path                                             |
| `sync-service.ts` `allocateMirrorPaths`, `allocatedVaultPath`, `SyncService.planMirrorPaths`                          | collision allocation on the derived vault paths (uses manifest `fileName`)        |
| `sync-service.ts` `SyncService.mirrorFile`                                                                            | compares planned vs `existing.vaultPath`; move-on-rename; `isNote` by remote name |
| `sync-service.ts` `removeMirroredFile`, `shouldRemoveMissingMirrorEntry`                                              | by remote id + `remotePath` prefix; deletes `vaultPath`                           |
| `manifest.ts` `matchingEntry` (merge)                                                                                 | matches entries by `vaultPath` **or** `remotePath`                                |
| `main.ts` Mirror loop, directory creation                                                                             | `remotePath` → vault folder via `vaultSafeName`                                   |
| `main.ts` `isInPushFolder` / `collectCloudInventory`                                                                  | remote path excludes the Pair folder from Mirror                                  |
| `main.ts` Pair → manifest copy                                                                                        | `vaultPath` from `entry.localRelativePath`                                        |
| `main.ts` `openDownloadedCloudFile`                                                                                   | manifest lookup by id or `remotePath`                                             |
| `pair-sync-service.ts` `reconcile` (remoteByLocalPath, collisions, display path)                                      | `localPathForRemote`, `remotePathForLocal`, `vaultSafeRelativePath`               |
| `pair-sync-service.ts` Cloud-rename branch in `reconcile`                                                             | destination = `localPathForRemote(new remote path)`                               |
| `reconcileVaultRenames`                                                                                               | new remote path = `remotePathForLocal(new local path)`                            |
| `resolveConflict` keep-both, `availableConflictCopyPath`, `conflictCopyPath`, `findRemoteFile`, `ensureUploadedLocal` | copy name locally and remotely                                                    |
| `uploadLocal`, `replaceRemote`                                                                                        | remote name, verified by re-listing `fileName`                                    |
| `reconcileDirectoryCreations/Deletions`, `directoryEntry`                                                             | directory paths are identical on both sides (no mapping)                          |
| `PairBaseline` keys, `conflictId`                                                                                     | keyed by local relative path                                                      |
| `cloud/client.ts` `replaceFile`                                                                                       | staging name keeps the remote extension                                           |

## 2. Proposal

### 2.1 One mapping module

New `src/sync/extension-mapping.ts` replaces `writable-paths.ts` (which is
deleted; its two functions become the "all text files" mode):

```ts
export type TextFileMapping =
  | { kind: "none" }
  | { kind: "names"; names: ReadonlySet<string> } // exact Cloud names, e.g. "Inbox.txt"
  | { kind: "all-text" };                          // current Pair behaviour

/** Cloud name → vault name. Only the final path segment is ever changed. */
export const vaultNameForCloudName = (name: string, mapping: TextFileMapping): string;
/** Vault name → Cloud name. Returns null when the vault name must not be uploaded. */
export const cloudNameForVaultName = (name: string, mapping: TextFileMapping): string | null;
export const vaultPathForCloudPath = (path: string, mapping: TextFileMapping): string;
export const cloudPathForVaultPath = (path: string, mapping: TextFileMapping): string | null;
/** Validates the setting; rejects wildcards, slashes, non-.txt names, duplicates. */
export const parseMappedTextFileNames = (lines: readonly string[]): { names: string[]; errors: string[] };
```

Rules:

- `names`: Cloud `X.txt` maps to vault `X.md` **only if** `X.txt` is exactly
  (case-sensitive) in the list. Vault `X.md` maps back to `X.txt` only if
  `X.txt` is in the list; any other `.md` is returned unchanged.
- `all-text`: exactly today's `writable-paths.ts` behaviour.
- `cloudNameForVaultName` returns `null` for any result that still ends in `.md`
  (case-insensitive). Callers treat `null` as "blocked: would upload a `.md`
  file". This is the single guard behind the "never upload `.md`" rule.
- Directories are never mapped.

Every derivation in the table in 1.4 that today calls `mirrorFilePath`'s
`fileName`, `localPathForRemote` or `remotePathForLocal` goes through these
functions. Identity stays remote: Mirror keys by remote id and stores the remote
`fileName`/`remotePath`; Pair keeps `remoteRelativePath`/`remoteId` in each
entry. Only the stored vault/local path is derived.

### 2.2 Setting

In `SupernoteSyncSettings` (synced `data.json`):

```ts
mapTextFilesToMarkdown: boolean;   // default false
mappedTextFileNames: string[];     // default [], e.g. ["project.txt", "area.txt", "Inbox.txt"]
```

UI: in Settings → Sync, a toggle "Show selected text files as Markdown" and,
when on, a text area with one exact Cloud file name per line, validated by
`parseMappedTextFileNames` (must end with `.txt`, no `/`, `*`, `?`, no
duplicates ignoring case). Invalid lines are shown and not saved. Turning the
toggle off keeps the list. Effective mapping:
`enabled && names.length > 0 ? {kind: "names"} : {kind: "none"}`.

### 2.3 Mirror

- `SyncService` takes the mapping in its options; `mirrorFilePath` and
  `allocateMirrorPaths` apply `vaultNameForCloudName` to the last segment before
  `vaultSafeName`. A mapped `…/project.txt` mirrors to `…/project.md`. The
  manifest still records `fileName: "project.txt"` and the Cloud `remotePath`;
  only `vaultPath` changes.
- **Switching on** with an existing mirrored `project.txt`: nothing new is
  needed — the planned path changes and the existing move-on-rename logic in
  `mirrorFile` applies:
  - local `project.txt` unchanged (md5 = manifest) and `project.md` absent →
    write `project.md`, trash `project.txt`, update `vaultPath` in the manifest
    (saved by the sync transaction). Nothing is uploaded or deleted in the Cloud
    (Mirror has no upload path).
  - local `project.txt` edited → `protected`, reported, nothing moved.
  - a local `project.md` already exists → `protected`, nothing moved or
    overwritten.
  - interrupted between write and trash → next run sees both files →
    `protected`; no deletion.
- **Switching off** is the same move in the other direction.
- Cloud deletion of a mapped file trashes the local `.md` under the existing
  rules (complete snapshot, unchanged).
- **Ambiguity:** if a mapped `X.txt` would land on the same vault path
  (case-insensitive) as another Cloud file in the same folder (for example
  `X.md` created on the device), the mapping is **not** applied silently with a
  `~hex` suffix. Instead `planMirrorPaths` marks that remote id as blocked;
  `mirrorFile` returns a new status `blocked` (no download, no move, no trash)
  and the run reports
  `X.txt: not mapped because X.md also exists in Supernote Cloud`. Because the
  id is still listed, it is never removed.
- Mirror stays one-way: edits to a mirrored `project.md` are protected, not
  uploaded. Two-way editing requires the Paired folder (see 2.4).

### 2.4 Paired folder

Recommended (**option A**, needs your OK — see open question 1): the Pair keeps
its existing `all-text` mapping regardless of the new setting, now routed
through the module. Your required behaviour is already what it does:

- local `x.md` ↔ remote `x.txt` both directions; uploads and replacements go to
  `x.txt`;
- a local `x.md` without a remote `x.txt` uploads as `x.txt`;
- conflict copies are `x (Vault …).md` locally, `x (Vault …).txt` remotely.

Because nothing about the Pair mapping changes, switching the setting on or off
has no effect on the Pair and its baseline.

Hardening added (applies to existing behaviour, closes the bug in 1.3):

1. **Two local files claim one Cloud file.** Before decisions, compute
   `cloudPathForVaultPath` for every local path that has no baseline entry. If
   it equals the remote path of another local path (tracked, or matched by the
   remote inventory) or of another untracked local path — e.g. local `x.txt` and
   `x.md` both → `x.txt` — those untracked paths are **blocked**: no upload, no
   delete, no conflict entry, reported in a new
   `PairSyncResult.blocked: string[]` list ("`x.txt` in the vault is not synced:
   `x.md` already pairs with Cloud `x.txt`. Rename or delete one."). Blocked
   paths are added to `handledPaths` so nothing else touches them, and they are
   excluded from directory deletion (they keep their folder).
2. **Never upload `.md`.** `uploadLocal` and the rename/keep-both paths use
   `cloudPathForVaultPath`; a `null` result blocks the file the same way.
   `replaceRemote` of a Cloud `.md` (created on the device) is also blocked
   instead of sending a staging `*.md` upload that Supernote refuses.
3. Remote collisions (Cloud `x.txt` **and** `x.md` → both local `x.md`) keep the
   existing behaviour: `PairInventoryIncompleteError`, the whole Pair run stops.
   This is stricter than per-file and already tested.
4. An existing baseline entry keyed `x.txt` (local `.txt`) is left as is; the
   baseline's `localRelativePath` keeps winning. No automatic rename in the
   Pair.

If you prefer **option B** (Pair also limited to the listed names), the switch
has to migrate the Pair baseline: turning the setting on would rename every
_unlisted_ paired `.txt` back from `.md` to `.txt` locally. I do not recommend
it: it changes upstream behaviour for every Pair user and renames files you did
not list.

### 2.5 Edge cases

| Case                                                 | Mirror                                                                 | Pair                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Both `x.txt` and `x.md` local                        | unrelated `x.md` → mapped `x.txt` protected, reported                  | untracked one blocked (2.4-1)                                       |
| Cloud also has `x.md`                                | mapped file blocked (2.3)                                              | whole Pair stops (existing)                                         |
| Containing folder renamed in Cloud                   | new path keeps the mapped name; moved if unchanged                     | existing Cloud-rename branch, destination through the module        |
| Containing folder renamed in vault                   | n/a (Mirror is Cloud-owned, existing behaviour)                        | existing per-file rename detection; names mapped through the module |
| Mapped file renamed in vault to an unlisted `.md`    | n/a                                                                    | Pair: `all-text` → uploads as `.txt` (today)                        |
| `inbox.txt` listed but Cloud has `Inbox.txt`         | not mapped (exact, case-sensitive); setting UI shows the list as typed | n/a                                                                 |
| Case-only collision on a case-insensitive filesystem | handled by the collision check (lower-case compare) → blocked          | existing remote collision check                                     |
| Cloud rename `project.txt` → `project-old.txt`       | unlisted name → mirrors as `project-old.txt` (moved back if unchanged) | n/a (all-text)                                                      |

### 2.6 Safety rules → mechanisms

- No remote delete caused by mapping: Mirror never calls Cloud write APIs; in
  the Pair the mapping is unchanged and blocked paths skip every branch.
- No `.md` upload: `cloudNameForVaultName` returns `null`, all upload paths
  check it (unit-tested by asserting `uploadFile` names).
- Ambiguity → per-file `blocked`/`protected` + report; never a suffix guess.
- Incomplete inventory: unchanged (`mirrorSnapshotComplete`,
  `PairInventoryIncompleteError`).

## 3. Tests (vitest, existing setup, `pnpm test`)

- `tests/extension-mapping.test.ts` (new): both directions for `none`, `names`,
  `all-text`; exact case; only the last segment; `.md` → `null`; directory
  untouched; `parseMappedTextFileNames` (wildcards, slashes, non-`.txt`,
  duplicates, whitespace).
- `tests/sync-service.test.ts` (extend, existing `MemoryVault` fakes): mapping
  off → `x.txt`; on → `x.md` with manifest `fileName` `x.txt`; unlisted `.txt`
  untouched; switch on with unchanged / edited / pre-existing `.md`; switch off;
  Cloud deletion of mapped file; Cloud `x.md` + `x.txt` → blocked and not
  removed; `allocateMirrorPaths` with mapping.
- `tests/pair-sync-service.test.ts` (extend): pin current behaviour (remote
  `.txt` → local `.md`, local `.md` → upload `.txt`, edit → `replaceFile` on
  `.txt`, keep-both copy names); local `x.txt` + `x.md` → blocked, no
  `uploadFile`; Cloud `.md` edited locally → blocked; across all tests no
  `uploadFile` name ends in `.md`.
- `tests/settings-*.test.ts`: default off and empty list; persisted values
  loaded with validation.

## 4. Open questions

1. **Pair scope (decisive).** Option A (setting governs Mirror only; Pair keeps
   mapping every `.txt`, plus hardening) or option B (setting governs both)?
2. **Where are the gtdpara files?** Two-way editing only exists in the Paired
   folder, which is a single Cloud folder. Is the folder containing
   `project.txt`, `area.txt`, `Inbox.txt` (e.g. under `Document/…`) your Paired
   folder today? If yes, they should already appear as `.md` there — do you see
   `.txt` instead? If so, please tell me (without sharing data) whether both
   `x.txt` and `x.md` exist in that vault folder: that is the duplicate case
   from 1.3.
3. Case: is exact, case-sensitive matching OK (`Inbox.txt` ≠ `inbox.txt`)?
4. Mirror switch: OK to reuse the existing "write new, trash old" move (Obsidian
   does not rewrite links to `project.txt`), or should the switch use Obsidian's
   rename so links update?
5. Pair: on a Cloud `x.txt`/`x.md` collision keep today's "stop the whole Pair"
   or narrow it to the two files?
6. Should the setting live in Settings → Sync or in the Setup flow next to the
   Paired folder?
