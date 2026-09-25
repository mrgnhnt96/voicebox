/** "2h 14m": how long something has been running, to the minute. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${rest}m`;
  return minutes ? `${rest}m` : 'less than a minute';
}
