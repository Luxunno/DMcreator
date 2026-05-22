import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE_URL = "https://hguofichp.cn:10086";
const SOURCE_URL = "https://sb6657.cn/#/memes/AllBarrage";
const OUT_DIR = path.resolve("data", "memes");

type ApiEnvelope<T> = {
  code: number;
  msg?: string | null;
  data: T;
};

type ApiMeme = {
  id?: number | string | null;
  barrageId?: number | string | null;
  barrage: string;
  cnt?: number | string | null;
  tags?: string | null;
  submitTime?: string | null;
  hotDateTime?: string | null;
};

type PageData = {
  list: ApiMeme[];
  total: number;
  lastPage: boolean;
};

type ApiTag = {
  dictCode?: string | null;
  dictLabel: string;
  dictValue: string;
  dictType?: string | null;
  iconUrl?: string | null;
};

type HotMeta = {
  rank: number;
  count: number;
  hot_date_time?: string | null;
};

type MemeDraft = {
  source: "sb6657";
  source_url: string;
  id: string;
  text: string;
  category: string;
  tag_values: string[];
  tag_labels: string[];
  tags: Array<{ value: string; label: string; icon_url: string | null }>;
  copy_count: number;
  submit_time?: string | null;
  hot_24h_rank?: number | null;
  hot_24h_count?: number | null;
  hot_7d_rank?: number | null;
  hot_7d_count?: number | null;
  hot_date_time?: string | null;
  metrics: {
    text_length: number;
    curated_base: number;
    copy_score: number;
    heat_score: number;
    tag_score: number;
    length_factor: number;
    raw_weight: number;
  };
};

type MemeRecord = MemeDraft & {
  weight: number;
  weight_cluster: "s" | "a" | "b" | "c";
  crawled_at: string;
};

type CrawlOptions = {
  pageSize: number;
  delayMs: number;
  maxPages?: number;
};

function parseArgs(argv: string[]): CrawlOptions {
  return {
    pageSize: Number(readArg(argv, "--page-size") ?? 100),
    delayMs: Number(readArg(argv, "--delay-ms") ?? 250),
    maxPages: readArg(argv, "--max-pages")
      ? Number(readArg(argv, "--max-pages"))
      : undefined,
  };
}

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];

  const prefix = `${name}=`;
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg?.slice(prefix.length);
}

async function getJson<T>(
  endpoint: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const url = new URL(endpoint, API_BASE_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      referer: "https://sb6657.cn/",
      "user-agent": "6657-bulletchat-creator/0.1 crawler",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.toString()}`);
  }

  const body = (await response.json()) as ApiEnvelope<T>;
  if (body.code !== 200) {
    throw new Error(`API code ${body.code} from ${url.toString()}: ${body.msg ?? ""}`);
  }

  return body.data;
}

async function fetchTags(): Promise<ApiTag[]> {
  return getJson<ApiTag[]>("/machine/dictList");
}

async function fetchPage(pageNum: number, pageSize: number): Promise<PageData> {
  return getJson<PageData>("/machine/Page", { pageNum, pageSize });
}

async function fetchHot(endpoint: string): Promise<ApiMeme[]> {
  try {
    return await getJson<ApiMeme[]>(endpoint);
  } catch (error) {
    console.warn(`[warn] failed to fetch ${endpoint}: ${(error as Error).message}`);
    return [];
  }
}

function toCount(value: number | string | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function splitTags(tags: string | null | undefined): string[] {
  return (tags ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeHotMap(items: ApiMeme[]): Map<string, HotMeta> {
  const map = new Map<string, HotMeta>();
  items.forEach((item, index) => {
    const id = String(item.barrageId ?? item.id ?? "");
    if (!id) return;

    map.set(id, {
      rank: index + 1,
      count: toCount(item.cnt),
      hot_date_time: item.hotDateTime,
    });
  });
  return map;
}

function textLength(text: string): number {
  return Array.from(text).length;
}

function lengthFactor(length: number): number {
  if (length <= 0) return 0;
  if (length <= 80) return 1;
  if (length <= 160) return 0.95;
  if (length <= 255) return 0.88;
  return 0.8;
}

function rankBoost(rank: number | undefined | null, listSize: number): number {
  if (!rank || listSize <= 0) return 0;
  return Math.max(0, (listSize - rank + 1) / listSize);
}

function round(value: number, digits = 6): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function cappedLogScore(value: number, cap: number): number {
  return Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(cap));
}

function buildDrafts(
  memes: ApiMeme[],
  tags: ApiTag[],
  hot24h: Map<string, HotMeta>,
  hot7d: Map<string, HotMeta>,
): MemeDraft[] {
  const tagMap = new Map(tags.map((tag) => [tag.dictValue, tag]));
  const hot24hSize = hot24h.size;
  const hot7dSize = hot7d.size;

  return memes
    .map((item): MemeDraft | null => {
      const id = String(item.id ?? item.barrageId ?? "");
      const text = item.barrage?.trim() ?? "";
      if (!id || !text) return null;

      const tagValues = splitTags(item.tags);
      const resolvedTags = tagValues.map((value) => {
        const tag = tagMap.get(value);
        return {
          value,
          label: tag?.dictLabel ?? value,
          icon_url: tag?.iconUrl ?? null,
        };
      });
      const tagLabels = resolvedTags.map((tag) => tag.label);
      const copyCount = toCount(item.cnt);
      const copyScore = cappedLogScore(copyCount, 300);
      const h24 = hot24h.get(id);
      const h7 = hot7d.get(id);
      const hot24hScore = h24
        ? cappedLogScore(h24.count, 300) * 0.65 + rankBoost(h24.rank, hot24hSize) * 0.35
        : 0;
      const hot7dScore = h7
        ? cappedLogScore(h7.count, 1500) * 0.65 + rankBoost(h7.rank, hot7dSize) * 0.35
        : 0;
      const heatScore = Math.max(hot24hScore * 0.6, hot7dScore * 0.4);
      const tagScore = tagValues.length > 0
        ? 0.75 + (Math.log1p(Math.min(tagValues.length, 5)) / Math.log1p(5)) * 0.25
        : 0.7;
      const length = textLength(text);
      const factor = lengthFactor(length);
      const curatedBase = 1;
      const rawWeight =
        (curatedBase * 0.55 + copyScore * 0.22 + heatScore * 0.15 + tagScore * 0.08) * factor;

      return {
        source: "sb6657" as const,
        source_url: SOURCE_URL,
        id,
        text,
        category: tagLabels[0] ?? "unknown",
        tag_values: tagValues,
        tag_labels: tagLabels,
        tags: resolvedTags,
        copy_count: copyCount,
        submit_time: item.submitTime ?? null,
        hot_24h_rank: h24?.rank ?? null,
        hot_24h_count: h24?.count ?? null,
        hot_7d_rank: h7?.rank ?? null,
        hot_7d_count: h7?.count ?? null,
        hot_date_time: h24?.hot_date_time ?? h7?.hot_date_time ?? null,
        metrics: {
          text_length: length,
          curated_base: curatedBase,
          copy_score: round(copyScore),
          heat_score: round(heatScore),
          tag_score: round(tagScore),
          length_factor: factor,
          raw_weight: round(rawWeight),
        },
      };
    })
    .filter((item): item is MemeDraft => item !== null);
}

function assignWeights(drafts: MemeDraft[], crawledAt: string): MemeRecord[] {
  const sortedWeights = drafts
    .map((item) => item.metrics.raw_weight)
    .sort((a, b) => a - b);
  const min = sortedWeights[0] ?? 0;
  const max = sortedWeights.at(-1) ?? 1;
  const spread = Math.max(max - min, 0.000001);

  return drafts.map((item) => {
    const percentile =
      lowerBound(sortedWeights, item.metrics.raw_weight) / Math.max(sortedWeights.length - 1, 1);
    const cluster = percentile >= 0.95 ? "s" : percentile >= 0.8 ? "a" : percentile >= 0.5 ? "b" : "c";
    const clusterMultiplier = cluster === "s" ? 1.2 : cluster === "a" ? 1.1 : cluster === "b" ? 1 : 0.9;
    const normalized = (item.metrics.raw_weight - min) / spread;

    return {
      ...item,
      weight: round(Math.min(1.2, Math.max(0.35, 0.35 + normalized * 0.65 * clusterMultiplier)), 6),
      weight_cluster: cluster,
      crawled_at: crawledAt,
    };
  });
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (values[mid] < target) left = mid + 1;
    else right = mid;
  }
  return left;
}

async function crawlAllMemes(options: CrawlOptions): Promise<ApiMeme[]> {
  const all: ApiMeme[] = [];
  let total = Number.POSITIVE_INFINITY;

  for (let pageNum = 1; pageNum <= (options.maxPages ?? Number.MAX_SAFE_INTEGER); pageNum += 1) {
    const page = await fetchPage(pageNum, options.pageSize);
    total = page.total;
    all.push(...page.list);

    console.log(
      `[crawl] page=${pageNum} fetched=${page.list.length} total=${all.length}/${total}`,
    );

    if (page.lastPage || all.length >= total || page.list.length === 0) break;
    await sleep(options.delayMs);
  }

  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.pageSize) || options.pageSize <= 0) {
    throw new Error("--page-size must be a positive number");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }

  await mkdir(OUT_DIR, { recursive: true });

  const crawledAt = new Date().toISOString();
  const [tags, hot24hItems, hot7dItems] = await Promise.all([
    fetchTags(),
    fetchHot("/machine/hotBarrageOf24H"),
    fetchHot("/machine/hotBarrageOf7Day"),
  ]);
  const memes = await crawlAllMemes(options);

  const records = assignWeights(
    buildDrafts(memes, tags, makeHotMap(hot24hItems), makeHotMap(hot7dItems)),
    crawledAt,
  );
  const clusterCounts = records.reduce<Record<string, number>>((acc, item) => {
    acc[item.weight_cluster] = (acc[item.weight_cluster] ?? 0) + 1;
    return acc;
  }, {});

  const jsonl = records.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(path.join(OUT_DIR, "sb6657-memes.jsonl"), jsonl, "utf8");
  await writeFile(
    path.join(OUT_DIR, "sb6657-tags.json"),
    JSON.stringify({ source: "sb6657", crawled_at: crawledAt, tags }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(OUT_DIR, "sb6657-memes.summary.json"),
    JSON.stringify(
      {
        source: "sb6657",
        source_url: SOURCE_URL,
        crawled_at: crawledAt,
        api_base_url: API_BASE_URL,
        total_records: records.length,
        tag_count: tags.length,
        hot_24h_count: hot24hItems.length,
        hot_7d_count: hot7dItems.length,
        cluster_counts: clusterCounts,
        output_files: {
          memes_jsonl: "data/memes/sb6657-memes.jsonl",
          tags_json: "data/memes/sb6657-tags.json",
          summary_json: "data/memes/sb6657-memes.summary.json",
        },
        weight_formula:
          "精品库权重: raw_weight=(0.55*curated_base+0.22*capped_log(copy_count)+0.15*heat_score+0.08*tag_score)*length_factor; copy/heat 只增强排序，不作为低质过滤；final weight=max(0.35, 0.35+minmax(raw_weight)*0.65*cluster_multiplier)",
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `[done] records=${records.length} tags=${tags.length} hot24h=${hot24hItems.length} hot7d=${hot7dItems.length}`,
  );
  console.log(`[done] wrote ${path.join(OUT_DIR, "sb6657-memes.jsonl")}`);
}

main().catch((error) => {
  console.error(`[error] ${(error as Error).stack ?? String(error)}`);
  process.exitCode = 1;
});
