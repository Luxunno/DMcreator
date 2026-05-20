import { readArg } from './args.js';
import { listCleanDates, rebuildStatsForDate } from './stats.js';
import { formatLocalDate } from './time.js';

const roomId = readArg('room', '6657') ?? '6657';
const dataDir = readArg('data-dir', 'data') ?? 'data';
const requestedDate = readArg('date');
const dates = requestedDate ? [requestedDate] : await listCleanDates(dataDir, roomId);
const targetDates = dates.length > 0 ? dates : [formatLocalDate()];

for (const date of targetDates) {
  const stats = await rebuildStatsForDate({ dataDir, roomId, date });
  console.log(`[stats] room=${roomId} date=${date} total=${stats.total} valid=${stats.valid}`);
}
