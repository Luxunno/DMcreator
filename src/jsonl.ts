import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

export async function createJsonlWriter(filePath: string): Promise<Writable> {
  await ensureParentDir(filePath);
  return createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
}

export function writeJsonl(writer: Writable, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      writer.off('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      writer.off('error', onError);
      resolve();
    };

    writer.once('error', onError);
    if (writer.write(line, 'utf8')) {
      writer.off('error', onError);
      resolve();
    } else {
      writer.once('drain', onDrain);
    }
  });
}

export function closeWriter(writer: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.end(() => resolve());
    writer.once('error', reject);
  });
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];

  try {
    await fs.access(filePath);
  } catch {
    return rows;
  }

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // Keep long-running collection resilient to a partially written line.
    }
  }

  return rows;
}
