import { useParams } from '@decky/ui';
import { useEffect, useState, VFC, useCallback } from 'react';

import { AssetSearchContext } from '../../hooks/useAssetSearch';
import { useSGDB } from '../../hooks/useSGDB';
import useSettings from '../../hooks/useSettings';
import { DEFAULT_TABS } from '../../constants';
import style from '../../styles/style.scss';

import AssetTabs from './AssetTabs';

const SGDBPage: VFC = () => {
  const { get } = useSettings();
  const { setAppId, appOverview } = useSGDB();
  const { appid, assetType = 'grid_p' } = useParams<{ appid: string, assetType: SGDBAssetType | 'manage' }>();
  const [currentTab, setCurrentTab] = useState<string>();
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  const onShowTab = useCallback((tabID: string) => {
    setCurrentTab(tabID);
  }, []);

  useEffect(() => {
    const parsed = Number.parseInt(appid, 10);
    setAppId(Number.isFinite(parsed) ? parsed : 0);
  }, [appid, setAppId]);

  useEffect(() => {
    setCurrentTab(assetType === 'manage' ? 'manage' : assetType);
    void (async () => {
      const positions = await get('tabs_order', DEFAULT_TABS) as string[];
      const hidden = await get('tabs_hidden', []) as string[];
      let tabDefault = await get('tab_default', assetType) as string;
      const filtered = positions.filter((x) => !hidden.includes(x));

      // Set first tab as default if default is hidden
      if (!filtered.includes(tabDefault)) {
        tabDefault = filtered[0];
      }
      setCurrentTab(tabDefault || 'manage');
    })();
  }, [get, assetType]);

  useEffect(() => {
    setLoadTimedOut(false);
    const timer = window.setTimeout(() => setLoadTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [appid]);

  return (
    <>
      <style>
        {style}
      </style>
      <div id="sgdb-wrap">
        {appOverview && currentTab ? (
          <AssetSearchContext>
            <AssetTabs currentTab={currentTab} onShowTab={onShowTab} />
          </AssetSearchContext>
        ) : (
          <div className="pa-page-state">
            <img alt="" src="/images/steam_spinner.png" />
            <strong>{loadTimedOut ? 'Impossibile aprire questo gioco' : 'Caricamento artwork'}</strong>
            <span>{loadTimedOut ? 'Torna alla libreria e riapri Playhub Artworks.' : ''}</span>
          </div>
        )}
      </div>
    </>
  );
};

export default SGDBPage;
