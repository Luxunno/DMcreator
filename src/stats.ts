import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as jieba from '@node-rs/jieba';
import { readJsonl, ensureParentDir } from './jsonl.js';
import type { CleanDanmuRecord, CountItem, RawDanmuRecord, StatsSummary } from './types.js';

const STOP_WORDS = new Set([
  '了',
  '的',
  '啊',
  '吧',
  '吗',
  '呀',
  '呢',
  '这',
  '那',
  '一个',
  '一下',
]);

function topItems(counter: Map<string, number>, limit: number, minCount = 1): CountItem[] {
  return [...counter.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

function tokenize(text: string): string[] {
  const api = jieba as unknown as {
    cutForSearch?: (input: string) => string[];
    cut?: (input: string) => string[];
  };
  const parts = api.cutForSearch?.(text) ?? api.cut?.(text) ?? Array.from(text);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .filter((part) => !STOP_WORDS.has(part))
    .filter((part) => !/^\d+$/u.test(part));
}

function phraseCandidates(text: string): string[] {
  const chars = Array.from(text);
  const phrases: string[] = [];

  for (const size of [2, 3, 4, 5, 6]) {
    if (chars.length < size) continue;
    for (let i = 0; i <= chars.length - size; i += 1) {
      const phrase = chars.slice(i, i + size).join('');
      if (/^\d+$/u.test(phrase)) continue;
      phrases.push(phrase);
    }
  }

  return phrases;
}

function lengthBucket(length: number): string {
  if (length <= 5) return '1-5';
  if (length <= 10) return '6-10';
  if (length <= 15) return '11-15';
  if (length <= 20) return '16-20';
  return '21+';
}

export function computeStats(params: {
  roomId: string;
  date: string;
  total: number;
  records: CleanDanmuRecord[];
}): StatsSummary {
  const words = new Map<string, number>();
  const phrases = new Map<string, number>();
  const repeats = new Map<string, number>();
  const lengthDistribution: Record<string, number> = {
    '1-5': 0,
    '6-10': 0,
    '11-15': 0,
    '16-20': 0,
    '21+': 0,
  };

  for (const record of params.records) {
    for (const token of tokenize(record.clean_text)) {
      words.set(token, (words.get(token) ?? 0) + 1);
    }

    for (const phrase of phraseCandidates(record.clean_text)) {
      phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
    }

    repeats.set(record.clean_text, (repeats.get(record.clean_text) ?? 0) + 1);
    const bucket = lengthBucket(record.length);
    lengthDistribution[bucket] = (lengthDistribution[bucket] ?? 0) + 1;
  }

  return {
    room_id: params.roomId,
    date: params.date,
    total: params.total,
    valid: params.records.length,
    top_words: topItems(words, 50, 2),
    top_phrases: topItems(phrases, 50, 2),
    top_repeats: topItems(repeats, 50, 2),
    length_distribution: lengthDistribution,
  };
}

export function dataPaths(dataDir: string, roomId: string, date: string): {
  raw: string;
  clean: string;
  stats: string;
} {
  return {
    raw: join(dataDir, 'raw', roomId, `${date}.jsonl`),
    clean: join(dataDir, 'clean', roomId, `${date}.jsonl`),
    stats: join(dataDir, 'stats', roomId, `${date}.json`),
  };
}

export async function rebuildStatsForDate(params: {
  dataDir: string;
  roomId: string;
  date: string;
}): Promise<StatsSummary> {
  const paths = dataPaths(params.dataDir, params.roomId, params.date);
  const rawRecords = await readJsonl<RawDanmuRecord>(paths.raw);
  const cleanRecords = await readJsonl<CleanDanmuRecord>(paths.clean);
  const stats = computeStats({
    roomId: params.roomId,
    date: params.date,
    total: rawRecords.length || cleanRecords.length,
    records: cleanRecords,
  });

  await ensureParentDir(paths.stats);
  await fs.writeFile(paths.stats, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return stats;
}

export async function listCleanDates(dataDir: string, roomId: string): Promise<string[]> {
  const dir = join(dataDir, 'clean', roomId);

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.replace(/\.jsonl$/u, ''))
      .sort();
  } catch {
    return [];
  }
}
