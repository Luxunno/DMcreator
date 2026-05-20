import { spawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readArg, readCsvArg } from './args.js';
import { formatSessionId } from './time.js';

interface CollectorState {
  pid: number;
  roomId: string;
  loginRoomId: string;
  dataDir: string;
  sessionId: string;
  maxPerSecond?: string;
  sampleRate?: string;
  maxQueue?: string;
  startedAt: string;
  stdoutLog: string;
  stderrLog: string;
}

const rootDir = process.cwd();
const stateDir = join(rootDir, '.collector');
const logDir = join(rootDir, 'logs');
const defaultRoomId = readArg('room', '6657') ?? '6657';
const explicitLoginRoomId = readArg('login-room');
const defaultDataDir = readArg('data-dir', 'data') ?? 'data';
const contextTags = readCsvArg('context-tags');
const maxPerSecond = readArg('max-per-second');
const sampleRate = readArg('sample-rate');
const maxQueue = readArg('max-queue');
const debugEvents = process.argv.includes('--debug-events');
const command = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

const ROOM_ALIASES: Record<string, string> = {
  // Douyu /6657 can resolve to a topic page; current live player room is 6979222.
  '6657': '6979222',
};

function statePath(roomId: string): string {
  return join(stateDir, `${roomId}.json`);
}

async function readState(roomId: string): Promise<CollectorState | null> {
  try {
    const raw = await fs.readFile(statePath(roomId), 'utf8');
    return JSON.parse(raw) as CollectorState;
  } catch {
    return null;
  }
}

async function writeState(state: CollectorState): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath(state.roomId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function removeState(roomId: string): Promise<void> {
  await fs.rm(statePath(roomId), { force: true });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function isCollectorRunning(state: CollectorState): Promise<boolean> {
  if (!pidExists(state.pid)) return false;

  if (process.platform !== 'win32') return true;

  try {
    const escapedSession = state.sessionId.replace(/'/g, "''");
    const command = `Get-CimInstance Win32_Process -Filter "ProcessId = ${state.pid}" | Select-Object -ExpandProperty CommandLine`;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
    const cmd = stdout.trim();
    return cmd.includes('src\\collect.ts') || cmd.includes('src/collect.ts') || cmd.includes(escapedSession);
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function resolveLoginRoomId(roomId: string, previous?: CollectorState | null): string {
  return explicitLoginRoomId ?? previous?.loginRoomId ?? ROOM_ALIASES[roomId] ?? roomId;
}

async function startCollector(roomId = defaultRoomId, dataDir = defaultDataDir): Promise<void> {
  const existing = await readState(roomId);
  if (existing && await isCollectorRunning(existing)) {
    console.log(`[cli] collector already running room=${roomId} pid=${existing.pid}`);
    console.log(`[cli] login_room=${existing.loginRoomId ?? roomId}`);
    console.log(`[cli] log=${existing.stdoutLog}`);
    return;
  }

  const loginRoomId = resolveLoginRoomId(roomId, existing);
  const effectiveMaxPerSecond = maxPerSecond ?? existing?.maxPerSecond;
  const effectiveSampleRate = sampleRate ?? existing?.sampleRate;
  const effectiveMaxQueue = maxQueue ?? existing?.maxQueue;

  if (existing) await removeState(roomId);

  await fs.mkdir(logDir, { recursive: true });
  const sessionId = readArg('session', formatSessionId(roomId)) ?? formatSessionId(roomId);
  const stdoutLog = join(logDir, `collector-${roomId}.out.log`);
  const stderrLog = join(logDir, `collector-${roomId}.err.log`);
  const stdoutFd = openSync(stdoutLog, 'a');
  const stderrFd = openSync(stderrLog, 'a');
  const args = [
    '--import',
    'tsx',
    join('src', 'collect.ts'),
    '--room',
    roomId,
    '--data-dir',
    dataDir,
    '--session',
    sessionId,
  ];

  if (loginRoomId !== undefined) {
    args.push('--login-room', loginRoomId);
  }

  if (contextTags.length > 0) {
    args.push('--context-tags', contextTags.join(','));
  }

  if (effectiveMaxPerSecond !== undefined) {
    args.push('--max-per-second', effectiveMaxPerSecond);
  }

  if (effectiveSampleRate !== undefined) {
    args.push('--sample-rate', effectiveSampleRate);
  }

  if (effectiveMaxQueue !== undefined) {
    args.push('--max-queue', effectiveMaxQueue);
  }

  if (debugEvents) {
    args.push('--debug-events');
  }

  try {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });

    if (!child.pid) {
      throw new Error('Failed to start collector process');
    }

    child.unref();

    const state: CollectorState = {
      pid: child.pid,
      roomId,
      loginRoomId,
      dataDir,
      sessionId,
      ...(effectiveMaxPerSecond !== undefined ? { maxPerSecond: effectiveMaxPerSecond } : {}),
      ...(effectiveSampleRate !== undefined ? { sampleRate: effectiveSampleRate } : {}),
      ...(effectiveMaxQueue !== undefined ? { maxQueue: effectiveMaxQueue } : {}),
      startedAt: new Date().toISOString(),
      stdoutLog,
      stderrLog,
    };

    await writeState(state);
    console.log(`[cli] started room=${roomId} pid=${child.pid}`);
    console.log(`[cli] login_room=${loginRoomId}`);
    console.log(`[cli] session=${sessionId}`);
    console.log(`[cli] log=${stdoutLog}`);
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function stopCollector(roomId = defaultRoomId): Promise<void> {
  const state = await readState(roomId);
  if (!state) {
    console.log(`[cli] collector is not registered room=${roomId}`);
    return;
  }

  if (!await isCollectorRunning(state)) {
    await removeState(roomId);
    console.log(`[cli] stale state removed room=${roomId} pid=${state.pid}`);
    return;
  }

  console.log(`[cli] stopping room=${roomId} pid=${state.pid}`);
  process.kill(state.pid, 'SIGTERM');

  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!await isCollectorRunning(state)) {
      await removeState(roomId);
      console.log(`[cli] stopped room=${roomId}`);
      return;
    }
  }

  console.log('[cli] stop signal sent, but process still appears alive');
  console.log('[cli] check logs or stop it manually if needed');
}

async function statusCollector(roomId = defaultRoomId): Promise<void> {
  const state = await readState(roomId);
  if (!state) {
    console.log(`[cli] status=stopped room=${roomId}`);
    return;
  }

  const running = await isCollectorRunning(state);
  console.log(`[cli] status=${running ? 'running' : 'stale'} room=${roomId} pid=${state.pid}`);
  console.log(`[cli] login_room=${state.loginRoomId ?? roomId}`);
  console.log(`[cli] session=${state.sessionId}`);
  console.log(`[cli] started_at=${state.startedAt}`);
  console.log(`[cli] log=${state.stdoutLog}`);

  if (!running) await removeState(roomId);
}

async function showLogs(roomId = defaultRoomId): Promise<void> {
  const state = await readState(roomId);
  const stdoutLog = state?.stdoutLog ?? join(logDir, `collector-${roomId}.out.log`);
  const stderrLog = state?.stderrLog ?? join(logDir, `collector-${roomId}.err.log`);

  for (const file of [stdoutLog, stderrLog]) {
    console.log(`\n[cli] ${file}`);
    try {
      const text = await fs.readFile(file, 'utf8');
      const lines = text.trimEnd().split(/\r?\n/u).slice(-80);
      console.log(lines.join('\n') || '(empty)');
    } catch {
      console.log('(missing)');
    }
  }
}

async function interactive(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    for (;;) {
      console.log('\n6657 collector');
      console.log('1. status');
      console.log('2. start');
      console.log('3. stop');
      console.log('4. logs');
      console.log('5. exit');

      const answer = (await rl.question('select> ')).trim();
      if (answer === '1' || answer.toLowerCase() === 'status') await statusCollector();
      else if (answer === '2' || answer.toLowerCase() === 'start') await startCollector();
      else if (answer === '3' || answer.toLowerCase() === 'stop') await stopCollector();
      else if (answer === '4' || answer.toLowerCase() === 'logs') await showLogs();
      else if (answer === '5' || answer.toLowerCase() === 'exit' || answer.toLowerCase() === 'q') break;
      else console.log('[cli] unknown option');
    }
  } finally {
    rl.close();
  }
}

switch (command) {
  case 'start':
    await startCollector();
    break;
  case 'stop':
    await stopCollector();
    break;
  case 'status':
    await statusCollector();
    break;
  case 'logs':
    await showLogs();
    break;
  case undefined:
    await interactive();
    break;
  default:
    console.log('Usage: npm run collector -- [start|stop|status|logs] [--room 6657] [--data-dir data]');
    process.exitCode = 1;
}
