import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readArg, readNumberArg } from './args.js';
import { ensureParentDir, readJsonl } from './jsonl.js';

interface WeightedInputRecord {
  '文本': string;
  '分类': string;
  '权重': number;
  cluster_id?: string;
  total_count?: number;
  first_window_count?: number;
  first_window_rate_per_minute?: number;
  unique_variant_count?: number;
  length?: number;
  emoji_count?: number;
  punctuation_count?: number;
}

interface MemeInputRecord {
  id: string;
  text: string;
  category?: string;
  tag_values?: string[];
  tag_labels?: string[];
  copy_count?: number;
  hot_24h_rank?: number | null;
  hot_24h_count?: number | null;
  hot_7d_rank?: number | null;
  hot_7d_count?: number | null;
  weight?: number;
  weight_cluster?: string;
  metrics?: {
    text_length?: number;
  };
}

interface TrainingRecord {
  text: string;
  category: string;
  weight: number;
  source: 'live_weighted' | 'sb6657_meme';
  source_id: string;
  tags: string[];
  quality_tier: 'core' | 'retrieval';
  use_for_sft: boolean;
  use_for_retrieval: boolean;
  counts: {
    total?: number;
    first_window?: number;
    copy?: number;
    hot_24h?: number | null;
    hot_7d?: number | null;
  };
  metrics: {
    length: number;
    emoji_count: number;
    punctuation_count: number;
    repeat_signal: number;
    risk_score: number;
  };
  flags: string[];
}

interface RejectedRecord {
  text: string;
  source: string;
  source_id: string;
  reasons: string[];
  flags: string[];
  weight: number;
}

const dataDir = readArg('data-dir', 'data') ?? 'data';
const roomId = readArg('room', '6657') ?? '6657';
const date = readArg('date', '2026-05-20') ?? '2026-05-20';
const maxCore = Math.max(1, Math.floor(readNumberArg('max-core', 25000)));
const maxRetrieval = Math.max(1, Math.floor(readNumberArg('max-retrieval', 25000)));

const weightedPath = join(dataDir, 'weighted', roomId, `${date}.jsonl`);
const memesPath = join(dataDir, 'memes', 'sb6657-memes.jsonl');
const outputDir = join(dataDir, 'training', roomId);
const corePath = join(outputDir, `${date}.core.jsonl`);
const retrievalPath = join(outputDir, `${date}.retrieval.jsonl`);
const sftPath = join(outputDir, `${date}.sft-messages.jsonl`);
const rejectedPath = join(outputDir, `${date}.rejected.jsonl`);
const summaryPath = join(outputDir, `${date}.summary.json`);

const blockPatterns = [
  { name: 'url', pattern: /https?:\/\/|www\.|[\w.-]+\.(?:com|cn|net|org)\b/i },
  { name: 'contact_or_id', pattern: /\b(?:qq|微信|vx|身份证|手机号|电话)\b/i },
  { name: 'long_number', pattern: /\d{8,}/ },
  { name: 'explicit_sexual', pattern: /(?:强奸|开房|卖淫|嫖|黄片|AV片|女优|波多野结衣|枫花恋)/i },
  { name: 'self_harm', pattern: /(?:自杀|跳楼|割腕)/ },
  { name: 'protected_attack', pattern: /(?:地域黑|种族|民族|宗教|残疾|同性恋|艾滋)/ },
  { name: 'severe_abuse', pattern: /(?:你妈死|死全家|户口本|畜生|杂种|傻逼|煞笔)/i },
  { name: 'doxxing', pattern: /(?:人肉|住址|家庭住址|身份证号)/ },
];

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

function cleanText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function riskFlags(text: string): string[] {
  return blockPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
}

function riskScore(flags: string[]): number {
  if (flags.length === 0) return 0;
  const severe = new Set(['explicit_sexual', 'self_harm', 'protected_attack', 'severe_abuse', 'doxxing']);
  return flags.reduce((score, flag) => score + (severe.has(flag) ? 0.45 : 0.25), 0);
}

function normalizeWeight(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(Math.min(1, value / Math.max(max, 0.000001)).toFixed(6));
}

function textKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').trim();
}

function rejectReasons(record: TrainingRecord): string[] {
  const reasons: string[] = [];
  if (record.metrics.length < 2) reasons.push('too_short');
  if (record.metrics.length > 160) reasons.push('too_long_for_retrieval');
  if (record.metrics.risk_score >= 0.45) reasons.push('risk_high');
  if (record.source === 'live_weighted' && (record.counts.total ?? 0) < 2) reasons.push('repeat_count_lt_2');
  if (/^[\p{P}\p{S}\s]+$/u.test(record.text)) reasons.push('symbol_only');
  if (/^\d+$/u.test(record.text)) reasons.push('number_only');
  return reasons;
}

function toLiveRecords(records: WeightedInputRecord[], maxWeight: number): TrainingRecord[] {
  return records.map((record) => {
    const text = cleanText(record['文本'] ?? '');
    const repeatSignal = Math.log1p(record.first_window_count ?? record.total_count ?? 0);
    const flags = riskFlags(text);
    const length = charLength(text);

    return {
      text,
      category: record['分类'] || '直播复读',
      weight: normalizeWeight(record['权重'], maxWeight),
      source: 'live_weighted',
      source_id: record.cluster_id ?? textKey(text),
      tags: [record['分类'] || '直播复读'],
      quality_tier: length <= 160 && (record.total_count ?? 0) >= 2 ? 'core' : 'retrieval',
      use_for_sft: length <= 160 && (record.total_count ?? 0) >= 2,
      use_for_retrieval: true,
      counts: {
        total: record.total_count,
        first_window: record.first_window_count,
      },
      metrics: {
        length,
        emoji_count: record.emoji_count ?? emojiCount(text),
        punctuation_count: record.punctuation_count ?? punctuationCount(text),
        repeat_signal: Number(repeatSignal.toFixed(6)),
        risk_score: Number(riskScore(flags).toFixed(4)),
      },
      flags,
    };
  });
}

function toMemeRecords(records: MemeInputRecord[], maxWeight: number): TrainingRecord[] {
  return records.map((record) => {
    const text = cleanText(record.text ?? '');
    const copyCount = record.copy_count ?? 0;
    const hotSignal = Math.log1p((record.hot_24h_count ?? 0) + (record.hot_7d_count ?? 0));
    const repeatSignal = 1 + Math.log1p(copyCount) + hotSignal * 0.35;
    const flags = riskFlags(text);
    const length = charLength(text);
    const category = record.category || record.tag_labels?.[0] || '站点梗句';

    return {
      text,
      category,
      weight: normalizeWeight(record.weight ?? 0, maxWeight),
      source: 'sb6657_meme',
      source_id: record.id,
      tags: record.tag_labels?.length ? record.tag_labels : [category],
      quality_tier: length <= 160 ? 'core' : 'retrieval',
      use_for_sft: length <= 160,
      use_for_retrieval: true,
      counts: {
        copy: copyCount,
        hot_24h: record.hot_24h_count,
        hot_7d: record.hot_7d_count,
      },
      metrics: {
        length,
        emoji_count: emojiCount(text),
        punctuation_count: punctuationCount(text),
        repeat_signal: Number(repeatSignal.toFixed(6)),
        risk_score: Number(riskScore(flags).toFixed(4)),
      },
      flags,
    };
  });
}

function dedupe(records: TrainingRecord[]): TrainingRecord[] {
  const best = new Map<string, TrainingRecord>();
  for (const record of records) {
    const key = textKey(record.text);
    const current = best.get(key);
    if (!current || record.weight > current.weight || record.metrics.repeat_signal > current.metrics.repeat_signal) {
      best.set(key, record);
    }
  }
  return [...best.values()];
}

function buildSftMessage(record: TrainingRecord): unknown {
  const tagLine = record.tags.slice(0, 5).join('、') || record.category;
  return {
    messages: [
      {
        role: 'system',
        content:
          '你是斗鱼 6657 玩机器直播间弹幕风格生成器。只输出一条短弹幕，保留弹幕语气、emoji 和标点，不解释，不输出人身攻击、歧视、隐私或造谣内容。',
      },
      {
        role: 'user',
        content: `场景: 当前直播出现了与「${record.category}」相近的节奏。\n风格标签: ${tagLine}\n要求: 生成一条短、顺口、可复读的 6657 风格弹幕。`,
      },
      {
        role: 'assistant',
        content: record.text,
      },
    ],
    weight: record.weight,
    source: record.source,
    source_id: record.source_id,
  };
}

function writeJsonl(path: string, records: unknown[]): Promise<void> {
  const body = records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  return fs.writeFile(path, body, 'utf8');
}

const [weightedInput, memeInput] = await Promise.all([
  readJsonl<WeightedInputRecord>(weightedPath),
  readJsonl<MemeInputRecord>(memesPath),
]);

const liveMax = Math.max(...weightedInput.map((record) => record['权重'] ?? 0), 1);
const memeMax = Math.max(...memeInput.map((record) => record.weight ?? 0), 1);
const candidates = dedupe([
  ...toLiveRecords(weightedInput, liveMax),
  ...toMemeRecords(memeInput, memeMax),
]);

const accepted: TrainingRecord[] = [];
const rejected: RejectedRecord[] = [];
for (const record of candidates) {
  const reasons = rejectReasons(record);
  if (reasons.length > 0) {
    rejected.push({
      text: record.text,
      source: record.source,
      source_id: record.source_id,
      reasons,
      flags: record.flags,
      weight: record.weight,
    });
  } else {
    accepted.push(record);
  }
}

const core = accepted
  .filter((record) => record.use_for_sft && record.quality_tier === 'core')
  .sort((a, b) => b.weight - a.weight || b.metrics.repeat_signal - a.metrics.repeat_signal)
  .slice(0, maxCore);

const retrieval = accepted
  .sort((a, b) => b.weight - a.weight || b.metrics.repeat_signal - a.metrics.repeat_signal)
  .slice(0, maxRetrieval);

await ensureParentDir(corePath);
await Promise.all([
  writeJsonl(corePath, core),
  writeJsonl(retrievalPath, retrieval),
  writeJsonl(sftPath, core.map(buildSftMessage)),
  writeJsonl(rejectedPath, rejected),
]);

const bySource = accepted.reduce<Record<string, number>>((acc, record) => {
  acc[record.source] = (acc[record.source] ?? 0) + 1;
  return acc;
}, {});
const byCategory = core.reduce<Record<string, number>>((acc, record) => {
  acc[record.category] = (acc[record.category] ?? 0) + 1;
  return acc;
}, {});
const rejectReasonsCount = rejected.reduce<Record<string, number>>((acc, record) => {
  for (const reason of record.reasons) acc[reason] = (acc[reason] ?? 0) + 1;
  return acc;
}, {});

await fs.writeFile(
  summaryPath,
  `${JSON.stringify(
    {
      room_id: roomId,
      date,
      inputs: {
        weighted: weightedPath,
        memes: memesPath,
      },
      outputs: {
        core: corePath,
        retrieval: retrievalPath,
        sft_messages: sftPath,
        rejected: rejectedPath,
      },
      source_counts: {
        weighted_input: weightedInput.length,
        meme_input: memeInput.length,
        candidates: candidates.length,
        accepted: accepted.length,
        rejected: rejected.length,
        core: core.length,
        retrieval: retrieval.length,
      },
      accepted_by_source: bySource,
      core_by_category: Object.fromEntries(
        Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 30),
      ),
      rejected_by_reason: rejectReasonsCount,
      rules: [
        '保留 emoji 和标点，仅移除控制字符并压缩异常空白。',
        '站点梗视为精品来源，不因 copy_count 低被过滤；copy_count 只影响排序权重。',
        '直播监听样本 total_count < 2 不进入训练或检索。',
        '全量训练模式：core/SFT 集保留 160 字以内的有效精品梗，不再只截取短句。',
        'retrieval 集同样保留 160 字以内有效样本。',
        '明显 URL、联系方式、隐私、人身攻击、歧视、露骨性内容、自伤内容进入 rejected。',
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`[prepare] candidates=${candidates.length} accepted=${accepted.length} rejected=${rejected.length}`);
console.log(`[prepare] core=${core.length} retrieval=${retrieval.length}`);
console.log(`[prepare] output=${outputDir}`);
