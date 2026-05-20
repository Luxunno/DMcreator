import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { closeWriter, createJsonlWriter, readJsonl, writeJsonl } from './jsonl.js';

test('jsonl writer writes parseable lines', async () => {
  const dir = join(process.cwd(), '.tmp-tests');
  const file = join(dir, 'records.jsonl');
  await fs.rm(dir, { recursive: true, force: true });

  const writer = await createJsonlWriter(file);
  await writeJsonl(writer, { a: 1 });
  await writeJsonl(writer, { b: 'x' });
  await closeWriter(writer);

  const raw = await fs.readFile(file, 'utf8');
  for (const line of raw.trim().split('\n')) {
    assert.doesNotThrow(() => JSON.parse(line));
  }

  assert.deepEqual(await readJsonl(file), [{ a: 1 }, { b: 'x' }]);
});
