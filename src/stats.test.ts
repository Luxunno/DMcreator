import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from './stats.js';
import type { CleanDanmuRecord } from './types.js';

function record(cleanText: string, repeatCount: number): CleanDanmuRecord {
  return {
    room_id: '6657',
    timestamp: '2026-05-20T13:14:03.000Z',
    raw_text: cleanText,
    clean_text: cleanText,
    length: Array.from(cleanText).length,
    session_id: '6657-20260520-211403',
    repeat_count: repeatCount,
  };
}

test('computeStats keeps duplicates as repeat stats', () => {
  const stats = computeStats({
    roomId: '6657',
    date: '2026-05-20',
    total: 4,
    records: [
      record('不是哥们这也能白给', 1),
      record('不是哥们这也能白给', 2),
      record('这把给机器干静音了', 1),
    ],
  });

  assert.equal(stats.total, 4);
  assert.equal(stats.valid, 3);
  assert.deepEqual(stats.top_repeats[0], { text: '不是哥们这也能白给', count: 2 });
  assert.equal(stats.length_distribution['6-10'], 3);
});
