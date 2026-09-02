import { DialogButton, Focusable } from '@decky/ui';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { HiArrowDownTray } from 'react-icons/hi2';

import t from '../utils/i18n';
import { SGDB_ASSET_TYPE_READABLE, SGDB_MIME_MAP, providerLabel } from '../constants';

/**
 * Full-height panel shown over the whole page.
 *
 * It runs as a modal on purpose: Steam traps focus inside it, so the artwork grid
 * underneath cannot be navigated (and cannot fight the focus ring) while it is open.
 */
const AssetDetailsModal: FC<{
  closeModal?: () => void;
  asset: any;
  assetType: SGDBAssetType;
  onApply: () => Promise<void>;
}> = ({ closeModal, asset, assetType, onApply }) => {
  const [applying, setApplying] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<any>(null);

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    // Let the slide-out finish before the modal is torn down.
    window.setTimeout(() => closeModal?.(), 170);
  }, [closeModal, closing]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    node.addEventListener('vgp_oncancel', onCancel);
    // Land straight on the action: one press applies the artwork.
    window.setTimeout(() => applyRef.current?.focus(), 0);
    return () => node.removeEventListener('vgp_oncancel', onCancel);
  }, [close]);

  const apply = async () => {
    if (applying) return;
    setApplying(true);
    try {
      await onApply();
    } finally {
      setApplying(false);
    }
  };

  const applyLabel = t('ACTION_ASSET_APPLY', 'Apply {assetType}')
    .replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType]);

  /* SGDB notes are markdown; strip it down to readable text rather than render it. */
  const plainNotes = String(asset.notes ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

  return (
    <Focusable
      ref={rootRef}
      className={`pa-details ${closing ? 'is-closing' : ''}`}
      flow-children="vertical"
      onCancel={close}
      onCancelButton={close}
      onCancelActionDescription="Chiudi"
    >
      {/* Clicking anywhere outside the panel closes it. */}
      <div className="pa-details-backdrop" onClick={close} />

      <div className="pa-details-panel">
        <div className="pa-details-head">
          <strong>Dettagli artwork</strong>
        </div>

        <div className={`pa-details-preview type-${assetType}`}>
          <img src={asset.url} alt="" />
        </div>

        <div className="pa-details-body">
          <dl className="pa-details-meta">
            <div><dt>Sorgente</dt><dd>{providerLabel(asset.provider) || asset.source || 'SteamGridDB'}</dd></div>
            <div><dt>Dimensioni</dt><dd>{asset.width > 0 ? `${asset.width} × ${asset.height}` : 'non dichiarate'}</dd></div>
            <div><dt>Formato</dt><dd>{SGDB_MIME_MAP[asset.mime] || String(asset.mime ?? '-').replace('image/', '').toUpperCase()}</dd></div>
            {asset.style && <div><dt>Stile</dt><dd>{String(asset.style).replace(/_/g, ' ')}</dd></div>}
            {asset.author?.name && <div><dt>Autore</dt><dd>{asset.author.name}</dd></div>}
          </dl>

          {/*
            Notes used to go through the Markdown component, which wraps its content in a
            Focusable - Steam then decorated the block with its own "Previous / Next"
            navigation hints and the note itself got lost in them. Plain text, no focus
            target, no hints.
          */}
          {plainNotes && (
            <div className="pa-details-notes">
              <span className="pa-details-notes-label">Note</span>
              <p>{plainNotes}</p>
            </div>
          )}
        </div>

        <DialogButton
          ref={applyRef}
          className="pa-details-apply"
          disabled={applying}
          onClick={() => void apply()}
          onOKActionDescription={applyLabel}
          onCancelActionDescription="Chiudi"
        >
          <HiArrowDownTray />
          <span>{applying ? 'Download in corso…' : 'Scarica e applica'}</span>
        </DialogButton>
      </div>
    </Focusable>
  );
};

export default AssetDetailsModal;
