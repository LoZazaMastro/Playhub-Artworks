import * as en from '../i18n/strings.json';
import * as ms from '../i18n/ms.json';
import * as ar from '../i18n/ar.json';
import * as id from '../i18n/id.json';
import * as vi from '../i18n/vi.json';
import * as th from '../i18n/th.json';
import * as bg from '../i18n/bg.json';
import * as cs from '../i18n/cs.json';
import * as da from '../i18n/da.json';
import * as de from '../i18n/de.json';
import * as el from '../i18n/el.json';
import * as es from '../i18n/es.json';
import * as es419 from '../i18n/es-419.json';
import * as fr from '../i18n/fr.json';
import * as fi from '../i18n/fi.json';
import * as it from '../i18n/it.json';
import * as ja from '../i18n/ja.json';
import * as ko from '../i18n/ko.json';
import * as nl from '../i18n/nl.json';
import * as pl from '../i18n/pl.json';
import * as pt from '../i18n/pt.json';
import * as ptBr from '../i18n/pt-br.json';
import * as ro from '../i18n/ro.json';
import * as ru from '../i18n/ru.json';
import * as sv from '../i18n/sv.json';
import * as tr from '../i18n/tr.json';
import * as uk from '../i18n/uk.json';
import * as zhCn from '../i18n/zh-cn.json';
import * as zhTw from '../i18n/zh-tw.json';
import * as no from '../i18n/no.json';
import * as hu from '../i18n/hu.json';

const simplifiedChinese = {
  name: '简体中文',
  strings: zhCn,
  credit: ['zhzy0077', 'XHXIAIEIN', 'simon3000'],
};

export const LANGS: {
  [key: string]: {
    name: string,
    strings: {
      [key: string]: string
    },
    credit: string[]
  }
} = {
  cs: {
    name: 'Čeština',
    strings: cs,
    credit: ['zenobit', 'theczechczech'],
  },
  da: {
    name: 'Dansk',
    strings: da,
    credit: ['Jakob Frank Mogensen'],
  },
  de: {
    name: 'Deutsch',
    strings: de,
    credit: ['Kurikuo', 'benutzer_artur7', 'Anja', 'FL0W', 'Remirax', 'LittleFreak', 'bignutty', 'Tom Taylor'],
  },
  fi: {
    name: 'Suomi',
    strings: fi,
    credit: ['Jage'],
  },
  el: {
    name: 'Ελληνικά',
    strings: el,
    credit: ['Emenesu'],
  },
  es: {
    name: 'Español-España',
    strings: es,
    credit: ['Andrea Laguillo', 'Kam', 'm0uch0'],
  },
  'es-419': {
    name: 'Español-Latinoamérica',
    strings: es419,
    credit: ['Kam', 'Knux03'],
  },
  fr: {
    name: 'Français',
    strings: fr,
    credit: ['Michael Jean', 'Xunkar'],
  },
  it: {
    name: 'Italiano',
    strings: it,
    credit: ['SpagottoB37', 'RodoMa92', 'federico-ntr'],
  },
  ja: {
    name: '日本語',
    strings: ja,
    credit: ['Nes', 'Hogman'],
  },
  ko: {
    name: '한국어',
    strings: ko,
    credit: ['yor42', 'sua (sua_owo)'],
  },
  nl: {
    name: 'Nederlands',
    strings: nl,
    credit: ['Phanpy100 (Fanny)', 'Jannes Verlinde'],
  },
  pl: {
    name: 'Polski',
    strings: pl,
    credit: ['DRS', 'Michał Kwiatkowski', 'MAX0R', 'minttuNB', 'Szymon Kucharski'],
  },
  pt: {
    name: 'Português',
    strings: pt,
    credit: ['Kokasgui', 'Ev1lbl0w'],
  },
  'pt-br': {
    name: 'Português-Brasil',
    strings: ptBr,
    credit: ['Oregano', 'Thomas Eric'],
  },
  ro: {
    name: 'Română',
    strings: ro,
    credit: ['Munt'],
  },
  ru: {
    name: 'Русский',
    strings: ru,
    credit: ['fycher', 'LostHikking'],
  },
  sv: {
    name: 'Svenska',
    strings: sv,
    credit: ['Moneyman Dan', 'Super', 'Daniel Nylander'],
  },
  tr: {
    name: 'Türkçe',
    strings: tr,
    credit: ['Bilgehan Ceviz', 'Sib | Twig'],
  },
  uk: {
    name: 'Українська',
    strings: uk,
    credit: ['Veydzher', 'Kefir'],
  },
  'zh-cn': simplifiedChinese,
  'sc-sc': simplifiedChinese, // sc-sc is "SteamChina" i think?, it's mapped to zh-cn in the client so doing the same here.
  'zh-tw': {
    name: '正體中文',
    strings: zhTw,
    credit: ['mingyc'],
  },
  no: {
    name: 'Norsk',
    strings: no,
    credit: ['minttuNB'],
  },
  hu: {
    name: 'Magyar',
    strings: hu,
    credit: ['minttuNB'],
  },
  th: { name: 'ไทย', strings: th, credit: [] },
  bg: { name: 'Български', strings: bg, credit: [] },
  vi: { name: 'Tiếng Việt', strings: vi, credit: [] },
  id: { name: 'Bahasa Indonesia', strings: id, credit: [] },
  en: { name: 'English', strings: en, credit: [] },
  ar: { name: 'العربية', strings: ar, credit: [] },
  ms: { name: 'Bahasa Melayu', strings: ms, credit: [] },
};

const STEAM_LANGUAGE_ALIASES: Record<string, string> = {
  english: 'en', german: 'de', french: 'fr', italian: 'it', koreana: 'ko', korean: 'ko',
  spanish: 'es', latam: 'es-419', schinese: 'zh-cn', tchinese: 'zh-tw', russian: 'ru',
  thai: 'th', japanese: 'ja', portuguese: 'pt', polish: 'pl', danish: 'da', dutch: 'nl',
  finnish: 'fi', norwegian: 'no', swedish: 'sv', hungarian: 'hu', czech: 'cs', romanian: 'ro',
  turkish: 'tr', brazilian: 'pt-br', bulgarian: 'bg', ukrainian: 'uk', greek: 'el',
  vietnamese: 'vi', indonesian: 'id', arabic: 'ar', malay: 'ms',
  'es-la': 'es-419', 'es_419': 'es-419', 'pt_br': 'pt-br', 'zh_cn': 'zh-cn', 'zh_tw': 'zh-tw',
  'sc-sc': 'zh-cn', 'sc-schinese': 'zh-cn', 'sc_schinese': 'zh-cn', 'zh-xc': 'zh-cn', 'zh-hans': 'zh-cn', 'zh-hant': 'zh-tw',
  'spanish-latinamerica': 'es-419', 'spanish-latin-america': 'es-419', vn: 'vi', 'vi-vn': 'vi',
  nb: 'no', 'nb-no': 'no', nn: 'no', 'nn-no': 'no', 'zh-sg': 'zh-cn', 'zh-hk': 'zh-tw', 'zh-mo': 'zh-tw',
};

export const normalizeSteamLanguage = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim().toLowerCase();
  const normalized = STEAM_LANGUAGE_ALIASES[raw] ?? raw.replace(/_/g, '-');
  if (LANGS[normalized]) return normalized;
  const base = normalized.split('-')[0];
  return LANGS[base] ? base : undefined;
};

const safeStringProperty = (target: any, key: string): string | undefined => {
  try {
    const value = target?.[key];
    return typeof value === 'string' ? value : undefined;
  } catch (_) {
    return undefined;
  }
};

const safeFirstLocale = (manager: any): string | undefined => {
  try {
    const locales = manager?.m_rgLocalesToUse;
    return locales && typeof locales[0] === 'string' ? locales[0] : undefined;
  } catch (_) {
    return undefined;
  }
};

const safeCallString = (target: any, key: string): string | undefined => {
  try {
    const fn = target?.[key];
    if (typeof fn !== 'function') return undefined;
    const value = fn.call(target);
    return typeof value === 'string' ? value : undefined;
  } catch (_) {
    return undefined;
  }
};

export const getCurrentLanguage = (): string => {
  const steamWindow = typeof window !== 'undefined' ? window as any : undefined;
  const manager = steamWindow?.LocalizationManager;
  const browserLanguages = (() => {
    try {
      if (typeof navigator === 'undefined') return [] as string[];
      return Array.from(navigator.languages ?? []).filter((value): value is string => typeof value === 'string');
    } catch (_) {
      return [] as string[];
    }
  })();
  const documentLanguage = (() => {
    try {
      return typeof document !== 'undefined' && typeof document.documentElement?.lang === 'string'
        ? document.documentElement.lang
        : undefined;
    } catch (_) {
      return undefined;
    }
  })();

  /*
    `LocalizationManager` is not a stable public Steam API. Depending on the SteamUI build,
    fields such as GetLanguage/GetLocale may be strings, getters, functions, or absent.
    Never optional-call an unknown property: `value?.()` still throws when value exists but
    is not callable, which used to crash the whole plugin while rendering QAM/game pages.
  */
  const candidates: unknown[] = [
    safeFirstLocale(manager),
    safeStringProperty(manager, 'm_strLanguage'),
    safeStringProperty(manager, 'm_currentLocale'),
    safeStringProperty(manager, 'm_strLocale'),
    safeCallString(manager, 'GetLanguage'),
    safeCallString(manager, 'GetLocale'),
    safeStringProperty(steamWindow, 'g_strLanguage'),
    safeStringProperty(steamWindow, 'g_rgCurrentLanguage'),
    safeCallString(steamWindow?.SteamClient?.Settings, 'GetCurrentLanguage'),
    documentLanguage,
    ...browserLanguages,
    typeof navigator !== 'undefined' ? navigator.language : undefined,
  ];
  for (const candidate of candidates) {
    const language = normalizeSteamLanguage(candidate);
    if (language) return language;
  }
  return 'en';
};

export const getCredits = (lang?: string) => {
  const normalized = lang ? normalizeSteamLanguage(lang) : getCurrentLanguage();
  return normalized ? LANGS[normalized]?.credit : undefined;
};

export const getLanguageName = (lang?: string): string => {
  const normalized = lang ? normalizeSteamLanguage(lang) : getCurrentLanguage();
  return normalized ? (LANGS[normalized]?.name ?? LANGS.en.name) : LANGS.en.name;
};

/**
 * Very basic translation cause theres like 20 strings and i don't need anything more complex.
 *
 * @param {string} key Locale key
 * @param {string} originalString Original text
 * @param {boolean} steamToken If true, uses the key to query Steams token store.
 *    Good for actions like "Back" or "Cancel". Won't be dumped with the rest of the strings.
 *
 * @example
 * t('TITLE_FILTER_MODAL', 'Asset Filters')
 * @example
 * // if you need variables use .replace()
 * t('ACTION_REMOVE_GAME', 'Delete {gameName}').replaceAll('{gameName}', gameName)
 * @example
 * // Original Steam string
 * t('Button_Back', 'Back', true);
 */
const trans_string = (key: string, originalString: string, steamToken = false): string => {
  const lang = getCurrentLanguage();
  if (steamToken) {
    const manager = typeof window !== 'undefined' ? (window as any).LocalizationManager : undefined;
    const lookup = (store: any): string | undefined => {
      try {
        if (!store) return undefined;
        if (typeof store.get === 'function') {
          const value = store.get(key);
          return typeof value === 'string' ? value : undefined;
        }
        const value = store[key];
        return typeof value === 'string' ? value : undefined;
      } catch (_) {
        return undefined;
      }
    };
    return lookup(manager?.m_mapTokens) ?? lookup(manager?.m_mapFallbackTokens) ?? originalString;
  }
  const english = LANGS.en?.strings?.[key] ?? originalString;
  return LANGS[lang]?.strings?.[key] ?? english;
};

const ERROR_FALLBACKS: Record<string, string> = {
  PA_TRY_AGAIN: 'Try again.',
  PA_TRY_RESTART: 'Try again after restarting the plugin.',
  PA_FAILED: 'Failed.',
  PA_KEY_BACKEND_UNCONFIRMED: 'The key was not confirmed by the backend.',
  PA_CANT_OPEN_GAME: 'Unable to open this game',
  PA_ERROR_API_KEY_SETTINGS: 'Enter your SteamGridDB API key in Playhub Artworks settings.',
  PA_ERROR_API_KEY_AUTOMATION: 'Configure your SteamGridDB API key before starting an automatic artwork operation.',
  PA_ERROR_SGDB_UNREACHABLE: 'SteamGridDB could not be reached. Check your connection.',
  PA_ERROR_SGDB_NO_RESPONSE: 'SteamGridDB did not respond.',
  PA_ERROR_SGDB_UNREADABLE: 'The SteamGridDB response could not be read.',
  PA_ERROR_SGDB_REQUEST: 'SteamGridDB request failed{status}.',
  PA_ERROR_RETRIEVE_ASSET: 'The artwork could not be retrieved.',
  PA_ERROR_DECODE_ARTWORK: 'The artwork could not be decoded.',
  PA_ERROR_INVALID_ARTWORK: 'The artwork is invalid.',
  PA_ERROR_WAIT_ARTWORK_JOB: 'Wait for the current artwork operation to finish.',
  PA_ERROR_IMAGE_UNAVAILABLE: 'The image is unavailable.',
  PA_ERROR_COMPOSITING_UNAVAILABLE: 'Image compositing is unavailable.',
  PA_ERROR_COMPOSITION_FAILED: 'The image could not be composed.',
  PA_ERROR_EMPTY_IMAGE: 'The resulting image is empty.',
  PA_ERROR_OPERATION_TIMEOUT: 'The operation took too long.',
  PA_ERROR_INTERNAL_ARTWORK: 'The artwork operation could not be completed.',
  PA_ERROR_COVER_BACKUP_FAILED: 'The current cover could not be backed up safely, so it was left unchanged.',
  PA_ERROR_DERIVED_COVER_RESTORE_FAILED: 'The previous cover could not be restored. Its backup has been kept.',
  PA_ERROR_ARTWORK_TOO_LARGE: 'This artwork is too large to process safely. Choose a smaller image.',
  PA_ERROR_ARTWORK_FORMAT_UNKNOWN: 'The artwork format is not recognized.',
  PA_ERROR_IMAGE_CHECK_TIMEOUT: 'Checking the image took too long.',
  PA_ERROR_DIRECT_IMAGE_URL: 'Enter the direct HTTP or HTTPS address of an image.',
  PA_ERROR_INVALID_IMAGE_LINK: 'The link does not contain a valid image, or the website blocks the download.',
  PA_ERROR_WRONG_ASPECT: 'The image proportions are not suitable for this tab.',
  PA_ERROR_IMAGE_TOO_SMALL: 'The image is smaller than the selected minimum quality.',
  PA_ERROR_FORMAT_FILTERED: 'The image format is excluded by the current filters.',
  PA_ERROR_GENERIC: 'The operation failed.',
};

export const localizeError = (error: unknown, fallbackKey = 'PA_ERROR_GENERIC'): string => {
  const raw = typeof error === 'string'
    ? error.trim()
    : String((error as any)?.message ?? error ?? '').trim();

  if (ERROR_FALLBACKS[raw]) return trans_string(raw, ERROR_FALLBACKS[raw]);

  // Some callers have already translated a known error before wrapping it in Error.
  const alreadyLocalized = Object.entries(ERROR_FALLBACKS).some(
    ([key, fallback]) => raw === trans_string(key, fallback)
  );
  if (alreadyLocalized) return raw;

  const statusMatch = raw.match(/(?:SteamGridDB).*?(\d{3})/i);
  if (statusMatch) {
    return trans_string('PA_ERROR_SGDB_REQUEST', ERROR_FALLBACKS.PA_ERROR_SGDB_REQUEST)
      .replace('{status}', ` (${statusMatch[1]})`);
  }

  const fallback = ERROR_FALLBACKS[fallbackKey] ?? ERROR_FALLBACKS.PA_ERROR_GENERIC;
  return trans_string(fallbackKey, fallback);
};

// using "trans_string" so it can be found by dump-strings
export default trans_string;
