import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  LOCALE_STORAGE_KEY,
  type Locale,
  getLocale,
  readInitialLocale,
  setCurrentLocale,
  trText,
} from './locale';

export { type Locale, getLocale, trText };

interface TrFn {
  (zh: string, en: string): string;
  (zh: React.ReactNode, en: React.ReactNode): React.ReactNode;
}

interface I18nContextValue {
  locale: Locale;
  isEn: boolean;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  tr: TrFn;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  isEn: false,
  setLocale: () => {},
  toggleLocale: () => {},
  tr: ((zh: any) => zh) as TrFn,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale());

  setCurrentLocale(locale);

  useEffect(() => {
    setCurrentLocale(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
      document.title =
        locale === 'en'
          ? 'NomadDeck · Cluster Operations Control Plane'
          : 'NomadDeck · 集群运维控制面';
    }
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setCurrentLocale(next);
    setLocaleState(next);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next = prev === 'zh' ? 'en' : 'zh';
      setCurrentLocale(next);
      return next;
    });
  }, []);

  const tr = useCallback(((zh: React.ReactNode, en: React.ReactNode) => (locale === 'en' ? en : zh)) as TrFn, [locale]);

  return (
    <I18nContext.Provider value={{ locale, isEn: locale === 'en', setLocale, toggleLocale, tr }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
