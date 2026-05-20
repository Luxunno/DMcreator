import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readArg, readNumberArg } from './args.js';
import { ensureParentDir, readJsonl } from './jsonl.js';
import { dataPaths } from './stats.js';
import { formatLocalDate } from './time.js';
import type { RawDanmuRecord, WeightedDanmuRecord } from './types.js';

interface RawItem {
  text: string;
  timestampMs: number;
  timestamp: string;
}

interface Cluster {
  id: string;
  key: string;
  items: RawItem[];
  variants: Map<string, number>;
  firstSeenMs: number;
  lastSeenMs: number;
}

const roomId = readArg('room', '6657') ?? '6657';
const dataDir = readArg('data-dir', 'data') ?? 'data';
const date = readArg('date', formatLocalDate()) ?? formatLocalDate();
const firstWindowSeconds = Math.max(10, Math.floor(readNumberArg('first-window-seconds', 60)));
const minCount = Math.max(2, Math.floor(readNumberArg('min-count', 2)));
const maxOutput = Math.max(1, Math.floor(readNumberArg('max-output', 5000)));

const paths = dataPaths(dataDir, roomId, date);
const outputPath = join(dataDir, 'weighted', roomId, `${date}.jsonl`);
const summaryPath = join(dataDir, 'weighted', roomId, `${date}.summary.json`);

function charLength(text: string): number {
  return Array.from(text).length;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function emojiCount(text: string): number {
  return countMatches(text, /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu);
}

function punctuationCount(text: string): number {
  return countMatches(text, /[\p{P}\p{S}]/gu);
}

function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '');
}

function displayText(raw: string): string {
  return stripControl(raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function clusterKey(text: string): string {
  return displayText(text)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[~～·•]+/gu, '')
    .trim();
}

function categoryFor(text: string, totalCount: number, firstWindowRate: number): string {
  const length = charLength(text);
  const emojis = emojiCount(text);

  if (firstWindowRate >= 20 || totalCount >= 100) return '高频爆发复读';
  if (firstWindowRate >= 8 || totalCount >= 30) return '稳定复读';
  if (emojis > 0) return '表情梗';
  if (length <= 5) return '短句口号';
  if (length >= 30) return '长句段子';
  return '普通梗句';
}

function lengthFactor(length: number): number {
  if (length >= 3 && length <= 20) return 1.12;
  if (length <= 2) return 0.72;
  if (length <= 30) return 1;
  if (length <= 45) return 0.82;
  return 0.62;
}

function emojiFactor(emojis: number, totalCount: number, firstWindowRate: number): number {
  if (emojis === 0) return 1;
  const burst = firstWindowRate >= 8 || totalCount >= 30;
  return burst ? Math.min(1.18, 1 + emojis * 0.04) : Math.max(0.78, 1 - emojis * 0.06);
}

function burstFactor(firstWindowRate: number, totalRate: number): number {
  if (totalRate <= 0) return 1;
  const ratio = firstWindowRate / totalRate;
  return Math.max(0.85, Math.min(1.25, 0.95 + Math.log1p(ratio) * 0.12));
}

function buildClusters(records: RawDanmuRecord[]): Cluster[] {
  const clusters = new Map<string, Cluster>();

  for (const record of records) {
    const text = displayText(record.text);
    if (!text) continue;

    const key = clusterKey(text);
    if (!key) continue;

    const timestampMs = Date.parse(record.timestamp || record.collected_at);
    if (!Number.isFinite(timestampMs)) continue;

    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        id: `c_${date.replace(/-/g, '')}_${String(clusters.size + 1).padStart(6, '0')}`,
        key,
        items: [],
        variants: new Map(),
        firstSeenMs: timestampMs,
        lastSeenMs: timestampMs,
      };
      clusters.set(key, cluster);
    }

    cluster.items.push({ text, timestampMs, timestamp: new Date(timestampMs).toISOString() });
    cluster.variants.set(text, (cluster.variants.get(text) ?? 0) + 1);
    cluster.firstSeenMs = Math.min(cluster.firstSeenMs, timestampMs);
    cluster.lastSeenMs = Math.max(cluster.lastSeenMs, timestampMs);
  }

  return [...clusters.values()];
}

function representativeText(cluster: Cluster): string {
  return [...cluster.variants.entries()]
    .sort((a, b) => b[1] - a[1] || charLength(a[0]) - charLength(b[0]))[0]?.[0] ?? '';
}

function firstWindowCount(cluster: Cluster): number {
  const end = cluster.firstSeenMs + firstWindowSeconds * 1000;
  return cluster.items.filter((item) => item.timestampMs <= end).length;
}

function toWeightedRecord(cluster: Cluster): WeightedDanmuRecord | null {
  const totalCount = cluster.items.length;
  if (totalCount < minCount) return null;

  const text = representativeText(cluster);
  const length = charLength(text);
  const emojis = emojiCount(text);
  const punctuation = punctuationCount(text);
  const firstCount = firstWindowCount(cluster);
  const durationMinutes = Math.max(1 / 60, (cluster.lastSeenMs - cluster.firstSeenMs) / 60000);
  const firstRate = firstCount / (firstWindowSeconds / 60);
  const totalRate = totalCount / durationMinutes;
  const firstWindowLog = Math.log1p(firstCount);
  const totalCountLog = Math.log1p(totalCount);
  const lf = lengthFactor(length);
  const ef = emojiFactor(emojis, totalCount, firstRate);
  const bf = burstFactor(firstRate, totalRate);
  const base = 0.7 * firstWindowLog + 0.3 * totalCountLog;
  const weight = Number((base * lf * ef * bf).toFixed(4));

  return {
    '文本': text,
    '分类': categoryFor(text, totalCount, firstRate),
    '权重': weight,
    cluster_id: cluster.id,
    cluster_key: cluster.key,
    total_count: totalCount,
    first_window_count: firstCount,
    first_window_seconds: firstWindowSeconds,
    first_window_rate_per_minute: Number(firstRate.toFixed(4)),
    total_rate_per_minute: Number(totalRate.toFixed(4)),
    unique_variant_count: cluster.variants.size,
    variants: [...cluster.variants.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([variantText, count]) => ({ text: variantText, count })),
    length,
    emoji_count: emojis,
    punctuation_count: punctuation,
    first_seen: new Date(cluster.firstSeenMs).toISOString(),
    last_seen: new Date(cluster.lastSeenMs).toISOString(),
    score_parts: {
      first_window_log: Number(firstWindowLog.toFixed(4)),
      total_count_log: Number(totalCountLog.toFixed(4)),
      length_factor: lf,
      emoji_factor: Number(ef.toFixed(4)),
      burst_factor: Number(bf.toFixed(4)),
    },
  };
}

const records = await readJsonl<RawDanmuRecord>(paths.raw);
const clusters = buildClusters(records);
const weighted = clusters
  .map(toWeightedRecord)
  .filter((record): record is WeightedDanmuRecord => record !== null)
  .sort((a, b) => b['权重'] - a['权重'] || b.total_count - a.total_count)
  .slice(0, maxOutput);

await ensureParentDir(outputPath);
await fs.writeFile(outputPath, `${weighted.map((record) => JSON.stringify(record)).join('\n')}${weighted.length ? '\n' : ''}`, 'utf8');

const summary = {
  room_id: roomId,
  date,
  source: paths.raw,
  output: outputPath,
  total_raw_records: records.length,
  cluster_count: clusters.length,
  retained_count: weighted.length,
  min_count: minCount,
  first_window_seconds: firstWindowSeconds,
  formula: '权重 = (0.7 * log1p(first_window_count) + 0.3 * log1p(total_count)) * length_factor * emoji_factor * burst_factor',
  note: '文本字段保留 emoji 和标点；cluster_key 仅用于聚类，不作为展示文本。',
  top: weighted.slice(0, 20).map((record) => ({
    '文本': record['文本'],
    '分类': record['分类'],
    '权重': record['权重'],
    total_count: record.total_count,
    first_window_count: record.first_window_count,
  })),
};

await ensureParentDir(summaryPath);
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(`[weight] raw=${records.length} clusters=${clusters.length} retained=${weighted.length}`);
console.log(`[weight] output=${outputPath}`);
console.log(`[weight] summary=${summaryPath}`);
