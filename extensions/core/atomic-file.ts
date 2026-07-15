import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWriteFileSync(file: string, contents: string): void {
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { /* new private file */ }
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    renamed = true;

    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(dirname(file), "r");
      fsyncSync(directoryFd);
    } catch {
      // Some platforms do not allow fsync on directories; the atomic rename still holds.
    } finally {
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) {
      try { unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
    }
  }
}
