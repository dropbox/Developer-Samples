// Dropbox content_hash: SHA-256 of each 4 MiB block, then SHA-256 of the
// concatenated block hashes, as hex.
import {createHash, type Hash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

export const BLOCK_SIZE = 4 * 1024 * 1024;

export class ContentHasher {
  private readonly overall: Hash = createHash('sha256');
  private block: Hash = createHash('sha256');
  private blockBytes = 0;

  update(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      const n = Math.min(BLOCK_SIZE - this.blockBytes, data.length - offset);
      this.block.update(data.subarray(offset, offset + n));
      this.blockBytes += n;
      offset += n;
      if (this.blockBytes === BLOCK_SIZE) {
        this.finishBlock();
      }
    }
  }

  digest(): string {
    if (this.blockBytes > 0) {
      this.finishBlock();
    }
    return this.overall.digest('hex');
  }

  private finishBlock(): void {
    this.overall.update(this.block.digest());
    this.block = createHash('sha256');
    this.blockBytes = 0;
  }
}

export function hashBuffer(data: Uint8Array): string {
  const hasher = new ContentHasher();
  hasher.update(data);
  return hasher.digest();
}

// Hashes a file. Fails if the path is a symlink, so it never reads outside the project.
export async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hasher = new ContentHasher();
    for await (const chunk of file.createReadStream({autoClose: false})) {
      hasher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return hasher.digest();
  } finally {
    await file.close();
  }
}
