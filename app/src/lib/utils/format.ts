import { formatDistance } from 'date-fns';
import { es, fr, ja, zhCN, zhTW } from 'date-fns/locale';
import i18n from '@/i18n';

function getDateLocale() {
  switch (i18n.language) {
    case 'es':
      return es;
    case 'ja':
      return ja;
    case 'zh-CN':
      return zhCN;
    case 'zh-TW':
      return zhTW;
    case 'fr':
      return fr;
    default:
      return undefined;
  }
}

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
    locale: getDateLocale(),
  }).replace(/^about /i, '');
}

export function formatAbsoluteDate(date: string | Date): string {
  const dateObj = parseServerDate(date);
  return dateObj.toLocaleString(i18n.language, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
