import { formatDistance } from 'date-fns';

// Backend timestamps are naive UTC — append `Z` so JS doesn't parse a
// timezone-less date-time string as local time.
function parseServerDate(date: string | Date): Date {
  if (typeof date !== 'string') {
    return date;
  }
  const dateStr = date.trim();
  if (!dateStr.includes('Z') && !dateStr.match(/[+-]\d{2}:\d{2}$/)) {
    return new Date(`${dateStr}Z`);
  }
  return new Date(dateStr);
}

export function formatDate(date: string | Date): string {
  return formatDistance(parseServerDate(date), new Date(), {
    addSuffix: true,
  }).replace(/^about /i, '');
}

export function formatAbsoluteDate(date: string | Date): string {
  const dateObj = parseServerDate(date);
  return dateObj.toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
