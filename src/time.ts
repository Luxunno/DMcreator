function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatLocalDate(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatSessionId(roomId: string, date = new Date()): string {
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${roomId}-${ymd}-${hms}`;
}
