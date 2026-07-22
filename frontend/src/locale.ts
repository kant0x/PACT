import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type LocaleCode = 'en' | 'ru' | 'es';

export interface LocaleDocument {
  code: LocaleCode;
  name: string;
  strings: Record<string, string>;
}

const DEFAULT_LOCALE: LocaleCode = 'en';
const STORAGE_KEY = 'pact-locale';
const LOCALE_DOCUMENT_VERSION = '16';
const originalTextByNode = new WeakMap<Text, string>();
const translatedTextByNode = new WeakMap<Text, string>();

interface LocaleContextValue {
  locale: LocaleCode;
  document: LocaleDocument;
  loading: boolean;
  setLocale: (locale: LocaleCode) => void;
  t: (source: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function isLocaleCode(value: string | null): value is LocaleCode {
  return value === 'en' || value === 'ru' || value === 'es';
}

// Some of the uploaded locale documents were saved as UTF-8 bytes decoded as
// Windows-1251 ("Рџ..." mojibake). Repair that at the document boundary so the
// source files remain editable documents and the UI receives real Cyrillic text.
function repairMojibake(value: string): string {
  if (!/(?:[РС][\u0400-\u04ff]|Г[^\s])/.test(value)) return value;
  try {
    const cp1251 = new TextDecoder('windows-1251').decode(Uint8Array.from({ length: 256 }, (_, index) => index));
    const byteByCharacter = new Map([...cp1251].map((character, index) => [character, index]));
    const bytes = Uint8Array.from([...value].map((character) => byteByCharacter.get(character) ?? character.charCodeAt(0)));
    const repaired = new TextDecoder('utf-8').decode(bytes);
    return repaired.includes('�') ? value : repaired;
  } catch {
    return value;
  }
}

function normalizeDocument(document: LocaleDocument): LocaleDocument {
  return {
    ...document,
    name: repairMojibake(document.name),
    strings: Object.fromEntries(Object.entries(document.strings).map(([key, value]) => [repairMojibake(key), repairMojibake(value)])),
  };
}

function cachedDocument(locale: LocaleCode): LocaleDocument | null {
  try {
    const raw = localStorage.getItem(`pact-locale:${LOCALE_DOCUMENT_VERSION}:${locale}`);
    return raw ? normalizeDocument(JSON.parse(raw) as LocaleDocument) : null;
  } catch {
    return null;
  }
}

async function fetchDocument(locale: LocaleCode): Promise<LocaleDocument> {
  const response = await fetch(`/locales/${locale}.json?v=${LOCALE_DOCUMENT_VERSION}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Locale document ${locale} could not be loaded`);
  const document = normalizeDocument(await response.json() as LocaleDocument);
  try { localStorage.setItem(`pact-locale:${LOCALE_DOCUMENT_VERSION}:${locale}`, JSON.stringify(document)); } catch { /* storage is optional */ }
  return document;
}

function applyDocumentTranslations(root: HTMLElement, strings: Record<string, string>) {
  const skip = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.parentElement && !skip.has(current.parentElement.tagName)) nodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const node of nodes) {
    const current = node.nodeValue ?? '';
    const raw = current.trim();
    if (!raw) continue;
    const previousSource = originalTextByNode.get(node);
    const previousTranslation = translatedTextByNode.get(node);
    // React may reuse a text node for a different route label. Preserve the
    // source when only the locale changed, but reset it when the component did.
    const source = previousSource && (
      raw === previousSource
      || raw === previousTranslation
      || raw === strings[previousSource]
    ) ? previousSource : raw;
    originalTextByNode.set(node, source);
    const translated = strings[source] ?? source;
    translatedTextByNode.set(node, translated);
    if (raw !== translated) node.nodeValue = current.replace(raw, translated);
  }
  // Text-node translation does not cover form affordances. Translate only
  // known user-facing attributes and only on exact document keys, preserving
  // user-entered values and URLs.
  const elements = root.querySelectorAll<HTMLElement>('[placeholder], [aria-label], [title]');
  for (const element of elements) {
    for (const attribute of ['placeholder', 'aria-label', 'title']) {
      const source = element.getAttribute(attribute);
      if (!source) continue;
      const translated = strings[source] ?? source;
      if (translated !== source) element.setAttribute(attribute, translated);
    }
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const initial = typeof window !== 'undefined' && isLocaleCode(localStorage.getItem(STORAGE_KEY))
    ? localStorage.getItem(STORAGE_KEY) as LocaleCode
    : DEFAULT_LOCALE;
  const [locale, setLocaleState] = useState<LocaleCode>(initial);
  const [localeDocument, setLocaleDocument] = useState<LocaleDocument>(() => cachedDocument(initial) ?? { code: initial, name: initial.toUpperCase(), strings: {} });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const cached = cachedDocument(locale);
    if (cached) setLocaleDocument(cached);
    void fetchDocument(locale)
      .then((next) => { if (!cancelled) setLocaleDocument(next); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage is optional */ }
    globalThis.document.documentElement.lang = locale;
    return () => { cancelled = true; };
  }, [locale]);

  useEffect(() => {
    const root = globalThis.document.getElementById('root');
    if (!root) return undefined;
    const translate = () => applyDocumentTranslations(root, localeDocument.strings);
    translate();
    const observer = new MutationObserver(translate);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [localeDocument]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    document: localeDocument,
    loading,
    setLocale: setLocaleState,
    t: (source) => localeDocument.strings[source] ?? source,
  }), [localeDocument, loading, locale]);

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside LocaleProvider');
  return context;
}
