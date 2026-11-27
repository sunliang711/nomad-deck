import { getLocale, type Locale } from './locale.ts';

// 将常见 5 段式 Cron 表达式转成人类可读描述；复杂表达式返回 null。

const descriptorsZh: Record<string, string> = {
  '@yearly': '每年 1 月 1 日 00:00',
  '@annually': '每年 1 月 1 日 00:00',
  '@monthly': '每月 1 日 00:00',
  '@weekly': '每周日 00:00',
  '@daily': '每天 00:00',
  '@midnight': '每天 00:00',
  '@hourly': '每小时整点',
};

const descriptorsEn: Record<string, string> = {
  '@yearly': 'Jan 1 every year at 00:00',
  '@annually': 'Jan 1 every year at 00:00',
  '@monthly': 'Day 1 of every month at 00:00',
  '@weekly': 'Every Sunday at 00:00',
  '@daily': 'Every day at 00:00',
  '@midnight': 'Every day at 00:00',
  '@hourly': 'Every hour on the hour',
};

const weekdaysZh = ['日', '一', '二', '三', '四', '五', '六', '日'];
const weekdaysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isNum = (value: string) => /^\d+$/.test(value);
const pad = (value: string) => value.padStart(2, '0');

function list(value: string, format: (item: string) => string, rangeSep: string, itemSep: string): string | null {
  const parts = value.split(',');
  const out: string[] = [];
  for (const part of parts) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) out.push(`${format(range[1])}${rangeSep}${format(range[2])}`);
    else if (isNum(part)) out.push(format(part));
    else return null;
  }
  return out.join(itemSep);
}

export function describeCron(expr: string, locale: Locale = getLocale()): string | null {
  const text = expr.trim();
  if (!text) return null;
  const en = locale === 'en';

  if (text.startsWith('@')) {
    const every = /^@every\s+(.+)$/.exec(text);
    if (every) return en ? `Every ${every[1]}` : `每隔 ${every[1]}`;
    return (en ? descriptorsEn : descriptorsZh)[text] ?? null;
  }

  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  if (month !== '*') return null;

  if (hour === '*' && dom === '*' && dow === '*') {
    if (minute === '*') return en ? 'Every minute' : '每分钟';
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return en ? `Every ${step[1]} min` : `每 ${step[1]} 分钟`;
    if (isNum(minute)) {
      return minute === '0'
        ? (en ? 'Every hour on the hour' : '每小时整点')
        : (en ? `Every hour at minute ${minute}` : `每小时第 ${minute} 分`);
    }
    return null;
  }
  if (!isNum(minute)) return null;

  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && dom === '*' && dow === '*') {
    return minute === '0'
      ? (en ? `Every ${hourStep[1]} hours on the hour` : `每 ${hourStep[1]} 小时整点`)
      : (en ? `Every ${hourStep[1]} hours at :${pad(minute)}` : `每 ${hourStep[1]} 小时，第 ${minute} 分`);
  }

  const times = list(hour, (h) => `${pad(h)}:${pad(minute)}`, en ? ' to ' : '至', en ? ', ' : '、');
  if (!times) return null;

  if (dom === '*' && dow === '*') return en ? `Daily at ${times}` : `每天 ${times}`;
  if (dom === '*') {
    const days = list(
      dow,
      (d) => (en ? (weekdaysEn[Number(d)] ?? d) : `周${weekdaysZh[Number(d)] ?? d}`),
      en ? '–' : '至',
      en ? ', ' : '、',
    );
    if (!days) return null;
    return en ? `Every ${days} at ${times}` : `每${days} ${times}`;
  }
  if (dow === '*') {
    const days = list(dom, (d) => (en ? `day ${d}` : `${d} 日`), en ? ' to ' : '至', en ? ', ' : '、');
    if (!days) return null;
    return en ? `Monthly on ${days} at ${times}` : `每月 ${days} ${times}`;
  }
  return null;
}
