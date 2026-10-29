import { Directory, File, FileMode, Paths } from "expo-file-system";

import type { FileGateway } from "@/core/engine";

// Caches, not Documents: neither iCloud nor Android backups include it. The OS
// may purge it under storage pressure; the engine treats a missing copy as
// "pick the file again" rather than guessing.
function folder(): Directory {
  const directory = new Directory(Paths.cache, "statement-imports");
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

// iOS hands over a copy the picker already made inside our sandbox
// (tmp/…-Inbox); Android hands over a content:// URI with a read grant that
// lasts until the app process dies.
const inSandbox = (uri: string) => uri.startsWith("file://");

export const deviceFiles: FileGateway = {
  async adopt(sourceUri, opId) {
    // Named by the operation, without the original name or extension.
    const target = new File(folder(), opId);
    const source = new File(sourceUri);
    // Moving the iOS inbox copy leaves exactly one copy behind; a content://
    // source is streamed natively, never through JS memory.
    if (inSandbox(sourceUri)) await source.move(target, { overwrite: true });
    else await source.copy(target, { overwrite: true });
    return target.uri;
  },

  discardSource(sourceUri) {
    if (!inSandbox(sourceUri)) return;
    const source = new File(sourceUri);
    if (source.exists) source.delete();
  },

  size(uri) {
    const file = new File(uri);
    return file.exists ? file.size : null;
  },

  async head(uri, length) {
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      return await handle.readBytes(length);
    } finally {
      handle.close();
    }
  },

  sha256: (uri) => new File(uri).digest("SHA-256"),

  remove(uri) {
    const file = new File(uri);
    if (file.exists) file.delete();
  },

  sweep(keep) {
    const keepName = keep ? new File(keep).name : null;
    let removed = 0;
    for (const entry of folder().list()) {
      if (entry.name === keepName) continue;
      entry.delete();
      removed += 1;
    }
    return removed;
  },
};
