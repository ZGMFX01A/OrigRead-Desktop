import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function readUtf8FileOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/**
 * Writes a complete sibling temp file, flushes it, then atomically replaces the destination.
 * Readers therefore observe either the previous complete JSON or the new complete JSON, never a
 * truncate-in-progress intermediate file.
 */
export function writeUtf8FileAtomic(path: string, content: string): void {
  const temp = join(dirname(path), '.' + basename(path) + '.tmp-' + randomUUID())
  try {
    writeFileSync(temp, content, 'utf8')
    // Windows implements fsync via FlushFileBuffers, which requires a write-capable handle.
    // The temp file already exists and is complete, so r+ preserves its bytes while granting
    // the access needed to flush them durably before the atomic rename.
    const fd = openSync(temp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
  }
}
