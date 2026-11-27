export type Locale = 'zh' | 'en';

export const LOCALE_STORAGE_KEY = 'nd_locale';

export function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // ignore storage errors
  }
  return 'zh';
}

let currentLocale: Locale = readInitialLocale();

export function getLocale(): Locale {
  return currentLocale;
}

export function setCurrentLocale(next: Locale): void {
  currentLocale = next;
}

export function trText(zh: string, en: string, locale: Locale = currentLocale): string {
  return locale === 'en' ? en : zh;
}
