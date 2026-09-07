import t, { localizeError } from '../../utils/i18n';
import {
  ConfirmModal, DialogButton, Field, Focusable, PanelSection, PanelSectionRow, showModal,
} from '@decky/ui';
import { call, toaster } from '@decky/api';
import {
  Fragment, useCallback, useEffect, useRef, useState, VFC,
} from 'react';
import {
  FaChevronDown, FaChevronUp, FaExternalLinkAlt, FaHome, FaImage, FaKey,
  FaArrowsAltV, FaFont, FaMagic, FaThLarge, FaTrash,
} from 'react-icons/fa';

import MenuIcon from '../Icons/MenuIcon';
import useSettings from '../../hooks/useSettings';
import { readApiKey } from '../../hooks/useSGDB';
import {
  COVER_SOURCES, coverSourceOrderKey, coverSourceSettingKey, CoverShape,
  normalizeCoverOrder, ZazaBatchKind, ZazaBatchProgress,
} from '../../utils/zazamastroBatch';
import { ArtworkProviderId, providerLabel } from '../../constants';
import { startBulkArtworkJob, useBulkArtworkJob } from '../../utils/bulkJobStore';
import { HomeRecentFormat, LibraryCoverFormat, refreshLayoutPatches } from '../../patches/layoutPatchController';
import { setInstantLibraryScroll } from '../../patches/instantLibraryScroll';
import { setDisableLibraryLetterHold } from '../../patches/disableLibraryLetterHold';
import { HOME_RECENT_COVER_SETTING_KEY, setHomeRecentCover } from '../../patches/homeRecentCover';

type BulkAction = {
  kind: ZazaBatchKind;
  title: string;
  description: string;
  icon: JSX.Element;
  confirm?: { title: string; body: string; ok: string };
};

const BULK_ACTIONS: BulkAction[] = [
  {
    kind: 'banner920',
    title: t('PA_OPTIMIZE_BANNERS', "Optimize banners"),
    description: t('PA_OPTIMIZE_BANNERS_DESC', 'Adds missing banners and upgrades low-resolution ones to 920 × 430.'),
    icon: <FaImage />,
  },
  {
    kind: 'missingLogos',
    title: t('PA_MISSING_LOGOS', "Missing logos"),
    description: t('PA_MISSING_LOGOS_DESC', 'Adds a logo to games that do not have one.'),
    icon: <FaMagic />,
  },
];

const RESET_ACTION: BulkAction = {
  kind: 'resetArtwork',
  title: t('PA_RESTORE_STEAM_ART', "Restore Steam artwork"),
  description: t('PA_REMOVE_CUSTOM_DESC', "Removes all custom artwork."),
  icon: <FaTrash />,
  confirm: {
    title: t('PA_REMOVE_ALL_CUSTOM_TITLE', 'Remove all custom artwork?'),
    body: t('PA_RESET_DESC', 'Covers, banners, backgrounds, logos and icons are restored to Steam defaults. Steam downloads them again automatically.'),
    ok: t('PA_REMOVE', "Remove"),
  },
};

const COVER_CARDS: Array<{
  shape: CoverShape;
  title: string;
  subtitle: string;
  replaceKind: ZazaBatchKind;
  missingKind: ZazaBatchKind;
  missingLabel?: string;
  replaceLabel?: string;
  replaceConfirm?: { title: string; body: string; ok: string };
}> = [
  {
    shape: 'portrait',
    title: t('PA_PORTRAIT_COVERS', "Portrait covers"),
    subtitle: t('PA_SOURCE_ORDER_DESC', 'Search active sources in the order below and use the first suitable result.'),
    replaceKind: 'portraitReplace',
    missingKind: 'portraitMissing',
  },
  {
    shape: 'square',
    title: t('PA_SQUARE_COVERS', "Square covers"),
    subtitle: t('PA_SOURCE_ORDER_DESC', 'Search active sources in the order below and use the first suitable result.'),
    replaceKind: 'squareReplace',
    missingKind: 'squareMissing',
  },
  {
    shape: 'hero',
    title: t('PA_BATCH_PERFECT_HERO', 'Perfect Hero'),
    subtitle: t('PA_PERFECT_HERO_QAM_DESC', 'A Perfect Hero merges background and logo into one image so the logo stays visible from Home when using the Playhub CSS Loader profile. ZazaMastro heroes are already prepared; Playhub Artworks creates the composition automatically for other games.'),
    replaceKind: 'perfectHeroReplace',
    missingKind: 'perfectHeroMissing',
    missingLabel: t('PA_APPLY_MISSING', "Apply missing"),
    replaceLabel: t('PA_REGENERATE_ALL', 'Regenerate all'),
    replaceConfirm: {
      title: t('PA_REMAKE_PERFECT_HERO_TITLE', 'Rebuild all Perfect Heroes?'),
      body: t('PA_REMAKE_PERFECT_HERO_DESC', 'Heroes for all games will be regenerated, including those already correct.'),
      ok: t('PA_REBUILD', 'Rebuild'),
    },
  },
];

const REPLACE_CONFIRM = {
  title: t('PA_REPLACE_ALL_COVERS_TITLE', 'Replace all covers?'),
  body: t('PA_REPLACE_ALL_COVERS_DESC', 'Current covers for all games will be replaced. Games without a new cover remain unchanged.'),
  ok: t('PA_REPLACE', "Replace"),
};

const openExternal = (url: string) => {
  const system = (window as any).SteamClient?.System;
  if (system?.OpenInSystemBrowser) system.OpenInSystemBrowser(url);
  else window.open(url, '_blank');
};

const Progress: VFC<{ value: ZazaBatchProgress }> = ({ value }) => {
  const percent = value.total ? Math.round((value.processed / value.total) * 100) : 0;
  return (
    <div className="pa-progress" aria-live="polite">
      <div className="pa-progress-track"><div style={{ width: `${percent}%` }} /></div>
      <div className="pa-progress-copy">
        <strong>{value.message}</strong>
        <span>
          {value.total > 0 ? `${value.processed} ${t('PA_OF', 'of')} ${value.total}` : t('PA_IN_PROGRESS', "In progress")}
          {' · '}{t('PA_PROGRESS_SUMMARY', '{changed} applied · {skipped} skipped{failed}').replace('{changed}', String(value.changed)).replace('{skipped}', String(value.skipped)).replace('{failed}', value.failed ? ` · ${value.failed} ${t('PA_ERRORS', 'errors')}` : '')}
        </span>
        {value.lastError && <span style={{ color: '#ff9a9a' }}>{value.lastError}</span>}
      </div>
    </div>
  );
};

const QuickAccessSettings: VFC = () => {
  const { get, set } = useSettings();
  const [apiKey, setApiKey] = useState('');
  const [savedApiKey, setSavedApiKey] = useState('');
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [libraryCoverFormat, setLibraryCoverFormat] = useState<LibraryCoverFormat>('portrait');
  const [homeRecentCover, setHomeRecentCoverState] = useState(false);
  const [centerHomeHero, setCenterHomeHero] = useState(false);
  const [instantLibraryScroll, setInstantLibraryScrollState] = useState(false);
  const [disableLibraryLetterHold, setDisableLibraryLetterHoldState] = useState(false);
  const [sourceFlags, setSourceFlags] = useState<Record<string, boolean>>({});
  const [sourceOrder, setSourceOrder] = useState<Record<CoverShape, ArtworkProviderId[]>>({
    square: COVER_SOURCES.square,
    portrait: COVER_SOURCES.portrait,
    hero: COVER_SOURCES.hero,
  });
  const secretFocusRef = useRef<HTMLDivElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const batchProgress = useBulkArtworkJob();

  useEffect(() => {
    void Promise.all([
      readApiKey(),
      get('library_cover_format', 'portrait'),
      get('home_hero_center', false),
      get('instant_library_scroll', false),
      get('disable_library_letter_hold', false),
      get(HOME_RECENT_COVER_SETTING_KEY, false),
    ])
      .then(([key, coverFormat, centerHero, instantScroll, disableLetterHold, storedHomeRecentCover]) => {
        const storedKey = String(key ?? '');
        setApiKey(storedKey);
        setSavedApiKey(storedKey);
        setLibraryCoverFormat(coverFormat === 'square' ? 'square' : 'portrait');
        setCenterHomeHero(centerHero === true);
        setInstantLibraryScrollState(instantScroll === true);
        setDisableLibraryLetterHoldState(disableLetterHold === true);
        setHomeRecentCoverState(storedHomeRecentCover === true);
      })
      .catch(() => undefined);
  }, [get]);

  useEffect(() => {
    void (async () => {
      const shapes: CoverShape[] = ['square', 'portrait', 'hero'];
      const orders = await Promise.all(shapes.map(async (shape) =>
        normalizeCoverOrder(shape, await get(coverSourceOrderKey(shape), null).catch(() => null))));
      setSourceOrder({ square: orders[0], portrait: orders[1], hero: orders[2] });

      const entries = await Promise.all(
        shapes.flatMap((shape) => COVER_SOURCES[shape].map(async (provider) => {
          const key = coverSourceSettingKey(shape, provider);
          const value = await get(key, true).catch(() => true);
          return [key, value !== false] as const;
        }))
      );
      setSourceFlags(Object.fromEntries(entries));
    })();
  }, [get]);

  const toggleSource = useCallback((shape: CoverShape, provider: string) => {
    const key = coverSourceSettingKey(shape, provider);
    setSourceFlags((current) => {
      const next = !(current[key] ?? true);
      void set(key, next, true);
      return { ...current, [key]: next };
    });
  }, [set]);

  const moveSource = useCallback((shape: CoverShape, provider: ArtworkProviderId, delta: number) => {
    setSourceOrder((current) => {
      const list = [...current[shape]];
      const index = list.indexOf(provider);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= list.length) return current;
      list.splice(target, 0, ...list.splice(index, 1));
      void set(coverSourceOrderKey(shape), list, true);
      return { ...current, [shape]: list };
    });
  }, [set]);

  useEffect(() => {
    const input = secretInputRef.current;
    if (!input) return;
    const leaveInput = (event: Event) => {
      event.stopPropagation();
      secretFocusRef.current?.focus();
    };
    input.addEventListener('vgp_oncancel', leaveInput);
    input.addEventListener('vgp_onok', leaveInput);
    return () => {
      input.removeEventListener('vgp_oncancel', leaveInput);
      input.removeEventListener('vgp_onok', leaveInput);
    };
  }, []);

  const saveApiKey = useCallback(async () => {
    const normalized = apiKey.trim();
    if (normalized === savedApiKey) return;
    setSavingApiKey(true);
    try {
      const result = await call<[string], { saved: boolean }>('save_steamgriddb_api_key', normalized);
      if (!result?.saved) throw new Error(t('PA_KEY_BACKEND_UNCONFIRMED', 'The key was not confirmed by the backend.'));
      setSavedApiKey(normalized);
      toaster.toast({ title: 'Playhub Artworks', body: normalized ? t('PA_KEY_SAVED', "Key saved.") : t('PA_KEY_REMOVED', "Key removed."), icon: <MenuIcon /> });
    } catch (error: any) {
      toaster.toast({ title: t('PA_KEY_NOT_SAVED', "API key not saved"), body: localizeError(error, 'PA_TRY_RESTART'), icon: <MenuIcon fill="#ff5d5d" /> });
    } finally {
      setSavingApiKey(false);
    }
  }, [apiKey, savedApiKey]);

  const runBulk = useCallback(async (kind: ZazaBatchKind, label: string) => {
    if (batchProgress?.running) return;
    if (kind !== 'resetArtwork') {
      const configuredKey = apiKey.trim() || await readApiKey();
      if (!configuredKey) {
        toaster.toast({ title: t('PA_KEY_MISSING', "Missing key"), body: t('PA_ENTER_KEY', "Enter your SteamGridDB key."), icon: <FaKey /> });
        return;
      }
    }
    try {
      const result = await startBulkArtworkJob(kind, 2);
      toaster.toast({
        title: label,
        body: t('PA_PROGRESS_SUMMARY', '{changed} applied · {skipped} skipped{failed}').replace('{changed}', String(result.changed)).replace('{skipped}', String(result.skipped)).replace('{failed}', result.failed ? ` · ${result.failed} ${t('PA_ERRORS', 'errors')}` : ''),
        icon: <MenuIcon />,
        duration: 5000,
      });
    } catch (error: any) {
      toaster.toast({ title: label, body: localizeError(error, 'PA_FAILED'), icon: <MenuIcon fill="#ff5d5d" />, duration: 6000 });
    }
  }, [apiKey, batchProgress?.running]);

  const startAction = useCallback((action: BulkAction) => {
    if (!action.confirm) {
      void runBulk(action.kind, action.title);
      return;
    }
    showModal(
      <ConfirmModal
        strTitle={action.confirm.title}
        strDescription={action.confirm.body}
        strOKButtonText={action.confirm.ok}
        strCancelButtonText={t('PA_CANCEL', "Cancel")}
        onOK={() => void runBulk(action.kind, action.title)}
      />
    );
  }, [runBulk]);

  const saveLayout = useCallback(async (
    key: string,
    value: LibraryCoverFormat | HomeRecentFormat | boolean,
    update: (next: any) => void
  ) => {
    update(value);
    await set(key, value, true);
    await refreshLayoutPatches();
  }, [set]);

  const saveInstantScroll = useCallback(async (value: boolean) => {
    setInstantLibraryScrollState(value);
    setInstantLibraryScroll(value);
    await set('instant_library_scroll', value, true);
  }, [set]);

  const saveDisableLetterHold = useCallback(async (value: boolean) => {
    setDisableLibraryLetterHoldState(value);
    setDisableLibraryLetterHold(value);
    await set('disable_library_letter_hold', value, true);
  }, [set]);

  const saveHomeRecentCover = useCallback(async (value: boolean) => {
    setHomeRecentCoverState(value);
    setHomeRecentCover(value);
    await set(HOME_RECENT_COVER_SETTING_KEY, value, true);
  }, [set]);

  return (
    <PanelSection>
      <style>{`
        .pa-qam,.pa-qam *{box-sizing:border-box}.pa-qam{width:100%;max-width:100%;min-width:0;display:flex;flex-direction:column;gap:14px;padding:0 2px 18px;overflow:hidden}.pa-intro{min-width:0;display:flex;align-items:center;gap:12px;padding:14px;border-radius:8px;background:linear-gradient(125deg,rgba(255,183,24,.18),rgba(44,145,255,.10));border:1px solid rgba(255,255,255,.10)}.pa-intro svg{width:27px;height:27px;color:#f6b928;flex:0 0 auto}.pa-intro strong,.pa-card strong{display:block;font-size:16px;line-height:1.2;color:#fff}.pa-intro span,.pa-card span,.pa-help{display:block;margin-top:4px;color:rgba(255,255,255,.62);font-size:12px;line-height:1.35}.pa-heading{margin:4px 2px -5px;color:rgba(255,255,255,.70);font-size:13px;font-weight:700}.pa-list{min-width:0;display:flex;flex-direction:column;gap:7px}.pa-card{width:100%!important;min-width:0!important;min-height:66px!important;height:auto!important;padding:11px 13px!important;border-radius:8px!important;background:rgba(255,255,255,.075)!important}.pa-card:focus,.pa-card.gpfocus{background:#f2b526!important;color:#171717!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,.85)!important}.pa-card:focus strong,.pa-card:focus span,.pa-card.gpfocus strong,.pa-card.gpfocus span{color:#171717!important}.pa-card-content{width:100%;min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center;gap:10px;text-align:left}.pa-card-content>svg{width:19px;height:19px;justify-self:center}.pa-card-content strong,.pa-card-content span{overflow-wrap:anywhere}.pa-key{width:100%;min-width:0;max-width:100%;padding:12px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.16);border-radius:8px;overflow:hidden}.pa-secret-focus{display:block;width:100%;min-width:0;max-width:100%;height:44px;border:1px solid rgba(255,255,255,.18);border-radius:6px;outline:0;background:rgba(0,0,0,.32);overflow:hidden}.pa-secret-focus.gpfocus,.pa-secret-focus:focus,.pa-secret-focus:focus-within{border-color:#f6b928;box-shadow:0 0 0 2px #f6b928}.pa-secret-input{display:block;width:100%;min-width:0;max-width:100%;height:42px;padding:0 12px;border:0;border-radius:5px;outline:0;background:transparent;color:#fff;font:inherit;letter-spacing:.08em;-webkit-text-security:disc}.pa-key-actions{width:100%;min-width:0;display:grid;grid-template-columns:1fr;gap:7px;margin-top:8px}.pa-key-actions button{width:100%!important;min-width:0!important;min-height:44px!important;border-radius:8px!important}.pa-progress{min-width:0;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px;background:rgba(0,0,0,.22)}.pa-progress-track{height:6px;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.14)}.pa-progress-track>div{height:100%;background:#f6b928;transition:width .18s ease}.pa-progress-copy{display:flex;flex-direction:column;gap:2px;font-size:11px;color:rgba(255,255,255,.58)}.pa-progress-copy strong{color:#fff;font-size:12px}.pa-choice{width:100%;min-width:0;padding:11px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(0,0,0,.16)}.pa-choice-label{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:#fff;font-size:14px}.pa-choice-label svg{color:#f6b928}.pa-choice-buttons{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.pa-choice-buttons button{min-width:0!important;height:42px!important;border-radius:7px!important}.pa-choice-buttons button.active{background:#f2b526!important;color:#171717!important}.pa-choice-buttons button:focus,.pa-choice-buttons button.gpfocus{box-shadow:inset 0 0 0 2px #fff!important}.pa-choice-buttons button.active:focus,.pa-choice-buttons button.active.gpfocus{color:#171717!important}.pa-choice-toggle{width:100%!important;min-width:0!important;height:44px!important;border-radius:7px!important}.pa-choice-toggle.active{background:#f2b526!important;color:#171717!important}.pa-glow{width:100%;min-width:0;padding:12px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.16);border-radius:8px;display:grid;grid-template-columns:minmax(0,1fr) 42px;align-items:center;gap:10px}.pa-glow:focus,.pa-glow.gpfocus{box-shadow:inset 0 0 0 2px #f6b928}.pa-glow-label{grid-column:1/-1;font-size:14px;color:#fff}.pa-glow input[type=range]{width:100%!important;min-width:0!important;margin:0!important;display:block}.pa-glow strong{justify-self:end;font-size:13px;color:rgba(255,255,255,.72);font-variant-numeric:tabular-nums}.pa-panel{width:100%;min-width:0;padding:12px;border:1px solid rgba(255,255,255,.10);border-radius:10px;background:rgba(0,0,0,.20);display:flex;flex-direction:column;gap:10px}.pa-panel-head strong{display:block;font-size:15px;color:#fff}.pa-panel-head span{display:block;margin-top:3px;font-size:12px;line-height:1.35;color:rgba(255,255,255,.60)}.pa-sources{display:flex;flex-direction:column;gap:5px}.pa-source-row{display:grid!important;grid-template-columns:minmax(0,1fr) 38px 38px;gap:5px}.pa-source-name{min-width:0!important;height:40px!important;padding:0 10px!important;border-radius:7px!important;display:grid!important;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;text-align:left!important;background:rgba(255,255,255,.07)!important}.pa-source-name.off .pa-source-label,.pa-source-name.off .pa-source-state,.pa-source-name.off .pa-source-index{opacity:.5}.pa-source-name:focus,.pa-source-name.gpfocus{background:rgba(255,255,255,.22)!important;box-shadow:inset 0 0 0 2px #f6b928!important}.pa-source-index{font-size:11px;color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums}.pa-source-label{font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pa-source-state{font-size:11px;color:rgba(255,255,255,.55)}.pa-source-name:focus .pa-source-label,.pa-source-name.gpfocus .pa-source-label{color:#fff}.pa-source-move{min-width:0!important;width:38px!important;height:40px!important;padding:0!important;border-radius:7px!important;display:flex!important;align-items:center;justify-content:center}.pa-panel-actions{display:flex;flex-direction:column;gap:6px}.pa-panel-actions button{width:100%!important;min-width:0!important;height:42px!important;border-radius:7px!important}.pa-danger{width:100%!important;min-width:0!important;min-height:46px!important;border-radius:8px!important;display:flex!important;align-items:center;justify-content:center;gap:9px;background:rgba(200,42,42,.20)!important;border:1px solid rgba(232,72,72,.55)!important;color:#ff9a9a!important;font-weight:600}.pa-danger:focus,.pa-danger.gpfocus{background:#c62828!important;color:#fff!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,.85)!important}
      `}</style>
      <PanelSectionRow>
        <div className="pa-qam">
          <div className="pa-intro"><FaMagic /><div><strong>Playhub Artworks</strong><span>{t('PA_TAGLINE', "Covers, backgrounds and logos. Exactly how you want them.")}</span></div></div>
          <div className="pa-heading">SteamGridDB</div>
          <div className="pa-key">
            <Field label={t('PA_PERSONAL_API_KEY', "Personal API key")} childrenLayout="below">
              <Focusable ref={secretFocusRef} className="pa-secret-focus" focusClassName="gpfocus" noFocusRing onActivate={() => secretInputRef.current?.focus()}>
                <input
                  ref={secretInputRef}
                  className="pa-secret-input"
                  type="password"
                  value={apiKey}
                  tabIndex={-1}
                  aria-label={t('PA_SGDB_API_KEY', "SteamGridDB API key")}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
              </Focusable>
            </Field>
            <Focusable className="pa-key-actions" flow-children="horizontal">
              <DialogButton onClick={() => openExternal('https://www.steamgriddb.com/profile/preferences/api')}><FaExternalLinkAlt /> {t('PA_GET_KEY', 'Get key')}</DialogButton>
              <DialogButton disabled={savingApiKey || apiKey.trim() === savedApiKey} onClick={() => void saveApiKey()}><FaKey /> {savingApiKey ? t('PA_SAVING', "Saving…") : t('PA_SAVE', "Save")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-heading">{t('PA_ARTWORK', "Artwork")}</div>
          {COVER_CARDS.map((card) => (
            <div className="pa-panel" key={card.shape}>
              <div className="pa-panel-head">
                <strong>{card.title}</strong>
                <span>{card.subtitle}</span>
              </div>

              <Focusable className="pa-sources" flow-children="vertical">
                {sourceOrder[card.shape].map((provider, index) => {
                  const key = coverSourceSettingKey(card.shape, provider);
                  const on = sourceFlags[key] ?? true;
                  return (
                    <Focusable className="pa-source-row" key={provider} flow-children="horizontal">
                      <DialogButton
                        className={`pa-source-name ${on ? '' : 'off'}`}
                        onClick={() => toggleSource(card.shape, provider)}
                      >
                        <span className="pa-source-index">{index + 1}</span>
                        <span className="pa-source-label">{providerLabel(provider)}</span>
                        <span className="pa-source-state">{on ? t('PA_ENABLED', "Enabled") : t('PA_DISABLED', "Disabled")}</span>
                      </DialogButton>
                      <DialogButton
                        className="pa-source-move"
                        disabled={index === 0}
                        aria-label={t('PA_MOVE_SOURCE_UP', 'Move source up')}
                        onOKActionDescription={t('PA_MOVE_SOURCE_UP', 'Move source up')}
                        onClick={() => moveSource(card.shape, provider, -1)}
                      >
                        <FaChevronUp />
                      </DialogButton>
                      <DialogButton
                        className="pa-source-move"
                        disabled={index === sourceOrder[card.shape].length - 1}
                        aria-label={t('PA_MOVE_SOURCE_DOWN', 'Move source down')}
                        onOKActionDescription={t('PA_MOVE_SOURCE_DOWN', 'Move source down')}
                        onClick={() => moveSource(card.shape, provider, 1)}
                      >
                        <FaChevronDown />
                      </DialogButton>
                    </Focusable>
                  );
                })}
              </Focusable>

              <Focusable className="pa-panel-actions" flow-children="vertical">
                <DialogButton
                  disabled={batchProgress?.running}
                  onClick={() => startAction({
                    kind: card.missingKind,
                    title: `${card.title}: ${t('PA_MISSING', 'missing')}`,
                    description: '',
                    icon: <FaImage />,
                  })}
                >
                  {card.missingLabel ?? t('PA_APPLY_MISSING', "Apply missing")}
                </DialogButton>
                <DialogButton
                  disabled={batchProgress?.running}
                  onClick={() => startAction({
                    kind: card.replaceKind,
                    title: `${card.title}: ${t('PA_REPLACEMENT', 'replacement')}`,
                    description: '',
                    icon: <FaImage />,
                    confirm: card.replaceConfirm ?? REPLACE_CONFIRM,
                  })}
                >
                  {card.replaceLabel ?? t('PA_APPLY_REPLACE', "Apply and replace")}
                </DialogButton>
              </Focusable>

              {(batchProgress?.kind === card.missingKind || batchProgress?.kind === card.replaceKind)
                && <Progress value={batchProgress} />}
            </div>
          ))}

          <div className="pa-heading">{t('PA_OTHER_ARTWORK', "Other artwork")}</div>
          <Focusable className="pa-list" flow-children="vertical">
            {BULK_ACTIONS.map((action) => (
              <Fragment key={action.kind}>
                <DialogButton
                  className="pa-card"
                  disabled={batchProgress?.running}
                  onClick={() => startAction(action)}
                >
                  <div className="pa-card-content">
                    {action.icon}
                    <div><strong>{action.title}</strong><span>{action.description}</span></div>
                  </div>
                </DialogButton>
                {batchProgress?.kind === action.kind && <Progress value={batchProgress} />}
              </Fragment>
            ))}
          </Focusable>

          <div className="pa-heading">{t('PA_APPEARANCE', "Appearance")}</div>
          <div className="pa-choice">
            <span className="pa-choice-label"><FaThLarge /> {t('PA_COVER_SHAPE', 'Cover shape')}</span>
            <Focusable className="pa-choice-buttons" flow-children="horizontal">
              <DialogButton className={libraryCoverFormat === 'portrait' ? 'active' : ''} onClick={() => void saveLayout('library_cover_format', 'portrait', setLibraryCoverFormat)}>{t('PA_PORTRAIT', "Portrait")}</DialogButton>
              <DialogButton className={libraryCoverFormat === 'square' ? 'active' : ''} onClick={() => void saveLayout('library_cover_format', 'square', setLibraryCoverFormat)}>{t('PA_SQUARE', "Square")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-choice">
            <span className="pa-choice-label"><FaImage /> {t('PA_HOME_RECENT_COVER', 'Last played game as cover')}</span>
            <Focusable className="pa-choice-buttons" flow-children="horizontal">
              <DialogButton className={homeRecentCover ? '' : 'active'} onClick={() => void saveHomeRecentCover(false)}>{t('PA_NO', "No")}</DialogButton>
              <DialogButton className={homeRecentCover ? 'active' : ''} onClick={() => void saveHomeRecentCover(true)}>{t('PA_YES', "Yes")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-choice">
            <span className="pa-choice-label"><FaHome /> {t('PA_CENTER_HOME_HERO', 'Centered Home hero')}</span>
            <span className="pa-help">{t('PA_CENTER_HOME_HERO_DESC', 'Useful with the Playhub theme, which aligns the hero to the top.')}</span>
            <Focusable className="pa-choice-buttons" flow-children="horizontal">
              <DialogButton className={centerHomeHero ? '' : 'active'} onClick={() => void saveLayout('home_hero_center', false, setCenterHomeHero)}>{t('PA_NO', "No")}</DialogButton>
              <DialogButton className={centerHomeHero ? 'active' : ''} onClick={() => void saveLayout('home_hero_center', true, setCenterHomeHero)}>{t('PA_YES', "Yes")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-choice">
            <span className="pa-choice-label"><FaArrowsAltV /> {t('PA_INSTANT_LIBRARY_SCROLL', 'Instant library navigation')}</span>
            <span className="pa-help">{t('PA_INSTANT_LIBRARY_SCROLL_DESC', 'Moves directly to the focused game instead of smoothly scrolling between library rows.')}</span>
            <Focusable className="pa-choice-buttons" flow-children="horizontal">
              <DialogButton className={instantLibraryScroll ? '' : 'active'} onClick={() => void saveInstantScroll(false)}>{t('PA_NO', "No")}</DialogButton>
              <DialogButton className={instantLibraryScroll ? 'active' : ''} onClick={() => void saveInstantScroll(true)}>{t('PA_YES', "Yes")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-choice">
            <span className="pa-choice-label"><FaFont /> {t('PA_DISABLE_LIBRARY_LETTER_HOLD', 'Disable alphabetical index')}</span>
            <span className="pa-help">{t('PA_DISABLE_LIBRARY_LETTER_HOLD_DESC', 'Prevents the alphabetical index from opening when you hold Up or Down in the Steam library.')}</span>
            <Focusable className="pa-choice-buttons" flow-children="horizontal">
              <DialogButton className={disableLibraryLetterHold ? '' : 'active'} onClick={() => void saveDisableLetterHold(false)}>{t('PA_NO', "No")}</DialogButton>
              <DialogButton className={disableLibraryLetterHold ? 'active' : ''} onClick={() => void saveDisableLetterHold(true)}>{t('PA_YES', "Yes")}</DialogButton>
            </Focusable>
          </div>
          <div className="pa-heading">{t('PA_RESET', "Reset")}</div>
          <DialogButton
            className="pa-danger"
            disabled={batchProgress?.running}
            onClick={() => startAction(RESET_ACTION)}
          >
            <FaTrash /> {RESET_ACTION.title}
          </DialogButton>
          {batchProgress?.kind === 'resetArtwork' && <Progress value={batchProgress} />}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
};

export default QuickAccessSettings;
