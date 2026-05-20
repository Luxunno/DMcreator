import { join } from 'node:path';
import { Client } from 'douyudm';
import { readArg, readCsvArg, readNumberArg } from './args.js';
import { toCleanRecord } from './clean.js';
import { closeWriter, createJsonlWriter, writeJsonl } from './jsonl.js';
import { rebuildStatsForDate, dataPaths } from './stats.js';
import { formatLocalDate, formatSessionId } from './time.js';
import type { CleanDanmuRecord, RawDanmuRecord } from './types.js';

const IGNORED_EVENTS = [
  'uenter',
  'upgrade',
  'rss',
  'bc_buy_deserve',
  'ssd',
  'spbc',
  'dgb',
  'gdp',
  'onlinegift',
  'ggbb',
  'rankup',
  'ranklist',
  'mrkl',
  'erquizisn',
  'blab',
  'rri',
  'synexp',
  'noble_num_info',
  'gbroadcast',
  'qausrespond',
  'wiru',
  'wirt',
  'mcspeacsite',
  'rank_change',
  'srres',
  'anbc',
  'frank',
  'nlkstatus',
  'pandoraboxinfo',
  'ro_game_succ',
  'lucky_wheel_star_pool',
  'tsgs',
  'fswrank',
  'tsboxb',
  'cthn',
  'configscreen',
  'rnewbc',
] as const;

const roomId = readArg('room', '6657') ?? '6657';
const loginRoomId = readArg('login-room', roomId) ?? roomId;
const dataDir = readArg('data-dir', 'data') ?? 'data';
const contextTags = readCsvArg('context-tags');
const maxPerSecond = Math.max(0, Math.floor(readNumberArg('max-per-second', 0)));
const sampleRate = Math.max(1, Math.floor(readNumberArg('sample-rate', 1)));
const maxQueue = Math.max(100, Math.floor(readNumberArg('max-queue', 20000)));
const debugEvents = process.argv.includes('--debug-events');
const date = formatLocalDate();
const sessionId = readArg('session', formatSessionId(roomId)) ?? formatSessionId(roomId);
const paths = dataPaths(dataDir, roomId, date);

let total = 0;
let valid = 0;
let received = 0;
let droppedByRate = 0;
let droppedByQueue = 0;
let acceptedThisSecond = 0;
let secondWindow = Math.floor(Date.now() / 1000);
let processingQueue = false;
let shuttingDown = false;
const repeats = new Map<string, number>();
const cleanRecords: CleanDanmuRecord[] = [];
const queue: RawDanmuRecord[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rawWriter = await createJsonlWriter(paths.raw);
const cleanWriter = await createJsonlWriter(paths.clean);
const client = new Client(loginRoomId, { ignore: debugEvents ? ['mrkl'] : [...IGNORED_EVENTS] });
const eventCounters = new Map<string, number>();

console.log(`[collector] room=${roomId} login_room=${loginRoomId} session=${sessionId}`);
console.log(`[collector] raw=${paths.raw}`);
console.log(`[collector] clean=${paths.clean}`);
console.log(`[collector] sample_rate=1/${sampleRate} max_per_second=${maxPerSecond || 'unlimited'} max_queue=${maxQueue}`);
console.log(`[collector] debug_events=${debugEvents ? 'on' : 'off'}`);
console.log('[collector] waiting for danmu; press Ctrl+C to stop');

client.on('connect', () => {
  console.log(`[collector] connected login_room=${loginRoomId}`);
});

client.on('disconnect', () => {
  console.log(`[collector] disconnected login_room=${loginRoomId}`);
});

client.on('error', (_client, err) => {
  console.error('[collector] connection error', err);
});

client.on('loginres', (message: Record<string, unknown>) => {
  const next = (eventCounters.get('loginres') ?? 0) + 1;
  eventCounters.set('loginres', next);
  if (debugEvents) {
    const keys = Object.keys(message).sort().join(',');
    console.log(`[event] type=loginres count=${next} keys=${keys}`);
    console.log(`[event] loginres live_stat=${String(message.live_stat ?? '')} roomgroup=${String(message.roomgroup ?? '')} sceneid=${String(message.sceneid ?? '')}`);
  }

  client.send({ type: 'joingroup', rid: loginRoomId, gid: '-9999' });
  console.log(`[collector] joined danmu group login_room=${loginRoomId}`);
});

if (debugEvents) {
  for (const event of IGNORED_EVENTS) {
    if (event === 'mrkl') continue;
    client.on(event, (message: Record<string, unknown>) => {
      const next = (eventCounters.get(event) ?? 0) + 1;
      eventCounters.set(event, next);
      if (next <= 3 || next % 100 === 0) {
        const keys = Object.keys(message).sort().join(',');
        console.log(`[event] type=${event} count=${next} keys=${keys}`);
      }
    });
  }
}

function shouldAcceptMessage(): boolean {
  received += 1;

  if (sampleRate > 1 && received % sampleRate !== 0) {
    droppedByRate += 1;
    return false;
  }

  if (maxPerSecond > 0) {
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond !== secondWindow) {
      secondWindow = currentSecond;
      acceptedThisSecond = 0;
    }

    if (acceptedThisSecond >= maxPerSecond) {
      droppedByRate += 1;
      return false;
    }

    acceptedThisSecond += 1;
  }

  return true;
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (queue.length > 0) {
      const rawRecord = queue.shift();
      if (!rawRecord) continue;

      total += 1;
      await writeJsonl(rawWriter, rawRecord);

      const cleanText = toCleanRecord(rawRecord, 1)?.clean_text;
      if (!cleanText) continue;

      const repeatCount = (repeats.get(cleanText) ?? 0) + 1;
      repeats.set(cleanText, repeatCount);

      const cleanRecord = toCleanRecord(rawRecord, repeatCount);
      if (!cleanRecord) continue;

      valid += 1;
      cleanRecords.push(cleanRecord);
      await writeJsonl(cleanWriter, cleanRecord);

      if (valid % 100 === 0) {
        const repeatKinds = [...repeats.values()].filter((count) => count > 1).length;
        console.log(`[collector] received=${received} total=${total} valid=${valid} queue=${queue.length} dropped_rate=${droppedByRate} dropped_queue=${droppedByQueue} repeats=${repeatKinds}`);
      }
    }
  } catch (error) {
    console.error('[collector] failed to persist danmu', error);
  } finally {
    processingQueue = false;
    if (queue.length > 0 && !shuttingDown) {
      void processQueue();
    }
  }
}

async function waitForQueueIdle(): Promise<void> {
  void processQueue();
  while (processingQueue || queue.length > 0) {
    await sleep(50);
  }
}

client.on('chatmsg', (message: Record<string, unknown>) => {
  const chatCount = (eventCounters.get('chatmsg') ?? 0) + 1;
  eventCounters.set('chatmsg', chatCount);
  const text = String(message.txt ?? '').trim();
  if (debugEvents && (chatCount <= 3 || chatCount % 100 === 0)) {
    const keys = Object.keys(message).sort().join(',');
    console.log(`[event] type=chatmsg count=${chatCount} has_txt=${text ? 'yes' : 'no'} keys=${keys}`);
  }
  if (!text) return;
  if (!shouldAcceptMessage()) return;

  const collectedAt = new Date().toISOString();
  const rawRecord: RawDanmuRecord = {
    room_id: roomId,
    timestamp: collectedAt,
    text,
    source: 'douyu_live_danmu',
    session_id: sessionId,
    collected_at: collectedAt,
    ...(contextTags.length > 0 ? { context_tags: contextTags } : {}),
    ...(typeof message.cid === 'string' && message.cid ? { cid: message.cid } : {}),
  };

  if (queue.length >= maxQueue) {
    droppedByQueue += 1;
    return;
  }

  queue.push(rawRecord);
  void processQueue();
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[collector] received ${signal}, shutting down`);
  client.close();
  await waitForQueueIdle();
  await closeWriter(rawWriter);
  await closeWriter(cleanWriter);

  const stats = await rebuildStatsForDate({ dataDir, roomId, date });
  const repeatKinds = stats.top_repeats.length;

  console.log(`[collector] session_total=${total}`);
  console.log(`[collector] session_valid=${valid}`);
  console.log(`[collector] session_received=${received}`);
  console.log(`[collector] dropped_by_rate=${droppedByRate}`);
  console.log(`[collector] dropped_by_queue=${droppedByQueue}`);
  console.log(`[collector] date_total=${stats.total}`);
  console.log(`[collector] date_valid=${stats.valid}`);
  console.log(`[collector] repeated_phrases=${repeatKinds}`);
  console.log(`[collector] stats=${join(dataDir, 'stats', roomId, `${date}.json`)}`);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

client.run();
