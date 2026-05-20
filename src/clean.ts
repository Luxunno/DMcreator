import type { CleanDanmuRecord, RawDanmuRecord } from './types.js';

const CONTROL_AND_ZERO_WIDTH = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]+/gu;
const ONLY_PUNCT_OR_SYMBOL = /^[\p{P}\p{S}]+$/u;
const ONLY_DIGITS = /^\d+$/u;

export function cleanDanmuText(raw: string): string | null {
  const compact = raw
    .normalize('NFKC')
    .replace(CONTROL_AND_ZERO_WIDTH, '')
    .replace(/\s+/g, '')
    .trim();

  if (!compact) return null;
  if (ONLY_DIGITS.test(compact)) return null;
  if (ONLY_PUNCT_OR_SYMBOL.test(compact)) return null;

  const clean = compact.replace(PUNCT_OR_SYMBOL, '').trim();
  if (!clean) return null;
  if (ONLY_DIGITS.test(clean)) return null;

  return clean;
}

export function toCleanRecord(raw: RawDanmuRecord, repeatCount: number): CleanDanmuRecord | null {
  const cleanText = cleanDanmuText(raw.text);
  if (!cleanText) return null;

  return {
    room_id: raw.room_id,
    timestamp: raw.timestamp,
    raw_text: raw.text,
    clean_text: cleanText,
    length: Array.from(cleanText).length,
    session_id: raw.session_id,
    repeat_count: repeatCount,
  };
}
