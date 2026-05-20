export interface RawDanmuRecord {
  room_id: string;
  timestamp: string;
  text: string;
  source: 'douyu_live_danmu';
  session_id: string;
  collected_at: string;
  context_tags?: string[];
  cid?: string;
}

export interface CleanDanmuRecord {
  room_id: string;
  timestamp: string;
  raw_text: string;
  clean_text: string;
  length: number;
  session_id: string;
  repeat_count: number;
}

export interface CountItem {
  text: string;
  count: number;
}

export interface StatsSummary {
  room_id: string;
  date: string;
  total: number;
  valid: number;
  top_words: CountItem[];
  top_phrases: CountItem[];
  top_repeats: CountItem[];
  length_distribution: Record<string, number>;
}

export interface WeightedDanmuRecord {
  '文本': string;
  '分类': string;
  '权重': number;
  cluster_id: string;
  cluster_key: string;
  total_count: number;
  first_window_count: number;
  first_window_seconds: number;
  first_window_rate_per_minute: number;
  total_rate_per_minute: number;
  unique_variant_count: number;
  variants: Array<{
    text: string;
    count: number;
  }>;
  length: number;
  emoji_count: number;
  punctuation_count: number;
  first_seen: string;
  last_seen: string;
  score_parts: {
    first_window_log: number;
    total_count_log: number;
    length_factor: number;
    emoji_factor: number;
    burst_factor: number;
  };
}
