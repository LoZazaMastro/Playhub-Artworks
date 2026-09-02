import { FC } from 'react';
import { Focusable, FocusableProps, FooterLegendProps, joinClassNames } from '@decky/ui';

import t from '../../utils/i18n';
import { providerLabel } from '../../constants';
import FooterGlyph from '../FooterGlyph';
import Chips from '../Chips';
import Chip from '../Chips/Chip';

import { LazyImage } from './LazyImage';

export interface AssetProps extends FooterLegendProps, Omit<FocusableProps, 'children'> {
  assetType: SGDBAssetType;
  width: number;
  height: number;
  src: string;
  author?: any;
  provider?: string;
  isAnimated: boolean;
  isDownloading?: boolean;
  downloadProgress?: number;
  downloadStatus?: 'running' | 'success' | 'error';
  onActivate?: FocusableProps['onActivate'];
  scrollContainer?: Element;
  notes?: string;
  nsfw?: boolean;
  humor?: boolean;
  epilepsy?: boolean;
  onImgError?: React.ReactEventHandler<HTMLImageElement>;
}

/**
 * Provider first, author only when it adds something. Scrapers that have no real
 * author set it to their own name, which used to render as "google · Google".
 */
const assetCredit = (provider?: string, author?: string) => {
  const source = provider ? providerLabel(provider) : '';
  const name = String(author ?? '').trim();
  if (source && name && name.toLowerCase() !== source.toLowerCase()) return `${source} · ${name}`;
  return source || name || 'Artwork';
};

const Asset: FC<AssetProps> = ({
  assetType,
  width,
  height,
  src,
  author,
  provider,
  isAnimated,
  onActivate,
  isDownloading = false,
  downloadProgress,
  downloadStatus = 'running',
  scrollContainer,
  notes = null,
  nsfw,
  humor,
  epilepsy,
  onImgError,
  ...rest
}) => (
  <div className="asset-box-wrap">
    <Focusable
      onActivate={onActivate}
      className={joinClassNames('image-wrap', `type-${assetType}`)}
      style={{ paddingBottom: `${(width === height) ? 100 : (height / width * 100)}%` }}
      {...rest}
    >
      <Chips>
        {notes ? (
          <Chip color="#8a8a8a">
            <FooterGlyph button={11} type={0} size={0} style={{ width: '1em' }} /> {t('LABEL_NOTES', 'Notes')}
          </Chip>
        ) : null}
        {isAnimated ? (
          <Chip color="#e2a256">
            {t('LABEL_ANIMATED', 'Animated')}
          </Chip>
        ) : null}
        {nsfw ? (
          <Chip color="#e5344c">
            {t('LABEL_NSFW', 'Adult Content')}
          </Chip>
        ) : null}
        {humor ? (
          <Chip color="#eec314" colorText="#434343">
            {t('LABEL_HUMOR', 'Humor')}
          </Chip>
        ) : null}
        {epilepsy ? (
          <Chip color="#735f9f">
            {t('LABEL_EPILEPSY', 'Epilepsy')}
          </Chip>
        ) : null}
      </Chips>
      <LazyImage
        src={src}
        isVideo={isAnimated}
        scrollContainer={scrollContainer}
        wrapperProps={{
          className: 'thumb',
        }}
        marginOffset="100px"
        unloadWhenOutside
        blurBackground
        onError={onImgError}
      />
    </Focusable>
    <div className="asset-facts">
      <span>{width > 0 && height > 0 ? `${width} × ${height}` : 'Dimensioni non dichiarate'}</span>
      <span>{assetCredit(provider, author?.name)}</span>
    </div>
    {(isDownloading || downloadProgress !== undefined) && (
      <div className={joinClassNames('asset-download-progress', downloadStatus, downloadProgress === undefined ? 'indeterminate' : '')} aria-label="Avanzamento download">
        <div style={downloadProgress === undefined ? undefined : { width: `${Math.max(2, Math.min(100, downloadProgress))}%` }} />
      </div>
    )}
    {author?.avatar && (
      <div className="author">
        <LazyImage src={author.avatar} alt="" />
      </div>
    )}
  </div>
);

export default Asset;
