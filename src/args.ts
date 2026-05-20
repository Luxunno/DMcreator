export function readArg(name: string, fallback?: string): string | undefined {
  const longName = `--${name}`;
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === longName) return args[i + 1] ?? fallback;
    if (current.startsWith(`${longName}=`)) return current.slice(longName.length + 1);
  }

  return fallback;
}

export function readCsvArg(name: string): string[] {
  return (readArg(name) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function readNumberArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
