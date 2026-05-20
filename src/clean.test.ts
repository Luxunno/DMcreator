import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDanmuText, toCleanRecord } from './clean.js';
import type { RawDanmuRecord } from './types.js';

test('cleanDanmuText filters empty, numeric, and symbol-only messages', () => {
  assert.equal(cleanDanmuText(''), null);
  assert.equal(cleanDanmuText('   '), null);
  assert.equal(cleanDanmuText('666'), null);
  assert.equal(cleanDanmuText('！！！？？？'), null);
});

test('cleanDanmuText normalizes width, whitespace, and punctuation', () => {
  assert.equal(cleanDanmuText('不是哥们这也能白给？'), '不是哥们这也能白给');
  assert.equal(cleanDanmuText('ＡＢＣ  白 给！！！'), 'ABC白给');
});

test('toCleanRecord keeps raw text and writes repeat count', () => {
  const raw: RawDanmuRecord = {
    room_id: '6657',
    timestamp: '2026-05-20T13:14:03.000Z',
    text: '不是哥们这也能白给？',
    source: 'douyu_live_danmu',
    session_id: '6657-20260520-211403',
    collected_at: '2026-05-20T13:14:03.120Z',
  };

  assert.deepEqual(toCleanRecord(raw, 2), {
    room_id: '6657',
    timestamp: '2026-05-20T13:14:03.000Z',
    raw_text: '不是哥们这也能白给？',
    clean_text: '不是哥们这也能白给',
    length: 9,
    session_id: '6657-20260520-211403',
    repeat_count: 2,
  });
});
