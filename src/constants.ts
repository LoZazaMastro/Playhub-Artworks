import t from './utils/i18n';

export const ASSET_TYPE: Record<SGDBAssetType, eAssetType> = {
  grid_p: 0,
  grid_l: 3,
  hero: 1,
  logo: 2,
  icon: 4,
};

export const SGDB_ASSET_TYPE_READABLE: Record<SGDBAssetType, string> = {
  grid_p: t('ASSET_TYPE_CAPSULE', 'Capsule'),
  grid_l: t('ASSET_TYPE_WIDECAPSULE', 'Wide Capsule'),
  hero: t('ASSET_TYPE_HERO', 'Hero'),
  logo: t('ASSET_TYPE_LOGO', 'Logo'),
  icon: t('ASSET_TYPE_ICON', 'Icon'),
};

export const ASSET_TAB_LABEL: Record<string, string> = {
  grid_p: t('PA_COVER', 'Cover'),
  grid_l: t('PA_BANNER', 'Banner'),
  hero: t('PA_BACKGROUND', 'Background'),
  logo: t('ASSET_TYPE_LOGO', 'Logo'),
  icon: t('ASSET_TYPE_ICON', 'Icon'),
  manage: t('LABEL_TAB_MANAGE', 'Manage'),
};

const gridStyles = {
  options: [
    { label: t('PA_STYLE_ALTERNATE', 'Alternate'), value: 'alternate' },
    { label: t('PA_STYLE_WHITE_LOGO', 'White logo'), value: 'white_logo' },
    { label: t('PA_STYLE_NO_LOGO', 'No logo'), value: 'no_logo' },
    { label: t('PA_STYLE_BLURRED', 'Blurred'), value: 'blurred' },
    { label: t('PA_STYLE_MINIMAL', 'Minimal'), value: 'material' },
  ],
  default: ['alternate', 'white_logo', 'no_logo', 'blurred', 'material'],
};

export const STYLES = {
  grid_p: gridStyles,
  grid_l: gridStyles,
  hero: {
    options: [
      { label: t('PA_STYLE_ALTERNATE', 'Alternate'), value: 'alternate' },
      { label: t('PA_STYLE_BLURRED', 'Blurred'), value: 'blurred' },
      { label: t('PA_STYLE_MINIMAL', 'Minimal'), value: 'material' },
    ],
    default: ['alternate', 'blurred', 'material'],
  },
  logo: {
    options: [
      { label: t('PA_STYLE_OFFICIAL', 'Official'), value: 'official' },
      { label: t('PA_STYLE_WHITE', 'White'), value: 'white' },
      { label: t('PA_STYLE_BLACK', 'Black'), value: 'black' },
      { label: t('PA_STYLE_CUSTOM', 'Custom'), value: 'custom' },
    ],
    default: ['official', 'white', 'black', 'custom'],
  },
  icon: {
    options: [
      { label: t('PA_STYLE_OFFICIAL', 'Official'), value: 'official' },
      { label: t('PA_STYLE_CUSTOM', 'Custom'), value: 'custom' },
    ],
    default: ['official', 'custom'],
  },
};

const STYLE_LABELS: Record<string, [string, string]> = {
  alternate: ['PA_STYLE_ALTERNATE', 'Alternate'],
  white_logo: ['PA_STYLE_WHITE_LOGO', 'White logo'],
  no_logo: ['PA_STYLE_NO_LOGO', 'No logo'],
  blurred: ['PA_STYLE_BLURRED', 'Blurred'],
  material: ['PA_STYLE_MINIMAL', 'Minimal'],
  minimal: ['PA_STYLE_MINIMAL', 'Minimal'],
  official: ['PA_STYLE_OFFICIAL', 'Official'],
  white: ['PA_STYLE_WHITE', 'White'],
  black: ['PA_STYLE_BLACK', 'Black'],
  custom: ['PA_STYLE_CUSTOM', 'Custom'],
};

/** Localized display label for style metadata returned by artwork providers. */
export const styleLabel = (style: unknown): string => {
  const normalized = String(style ?? '').trim().toLowerCase().replace(/ /g, '_');
  const known = STYLE_LABELS[normalized];
  return known ? t(known[0], known[1]) : t('PA_STYLE_OTHER', 'Other');
};

export const SGDB_MIME_MAP: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/vnd.microsoft.icon': 'ICO',
};

const allMimes = {
  options: [
    { label: 'PNG', value: 'image/png' },
    { label: 'JPEG', value: 'image/jpeg' },
    { label: 'WebP', value: 'image/webp' },
  ],
  default: ['image/png', 'image/jpeg', 'image/webp'],
};

export const MIMES = {
  grid_p: allMimes,
  grid_l: allMimes,
  hero: allMimes,
  logo: {
    options: [
      { label: 'PNG', value: 'image/png' },
      { label: 'WebP', value: 'image/webp' },
    ],
    default: ['image/png', 'image/webp'],
  },
  icon: {
    options: [
      { label: 'PNG', value: 'image/png' },
      { label: 'ICO', value: 'image/vnd.microsoft.icon' },
    ],
    default: ['image/png', 'image/vnd.microsoft.icon'],
  },
};

const validIconSizes = [1024,768,512,310,256,194,192,180,160,152,150,144,128,120,114,100,96,90,80,76,72,64,60,57,56,54,48,40,35,32,28,24,20,16,14,10,8];

/** Sizes worth surfacing as always-visible checks; the long tail stays implicit. */
export const ICON_SIZE_HIGHLIGHTS = [1024, 512, 256, 192, 128, 96, 64, 32];

export const DIMENSIONS = {
  grid_p: {
    options: ['600x900', '342x482', '660x930', '512x512', '1024x1024'].map((x) => ({ label: x.replace('x', '×'), value: x })),
    default: ['600x900', '342x482', '660x930'],
  },
  grid_l: {
    options: ['460x215', '920x430', '512x512', '1024x1024'].map((x) => ({ label: x.replace('x', '×'), value: x })),
    default: ['460x215', '920x430'],
  },
  hero: {
    options: ['1920x620', '3840x1240', '1600x650'].map((x) => ({ label: x.replace('x', '×'), value: x })),
    default: ['1920x620', '3840x1240', '1600x650'],
  },
  logo: {
    options: [],
    default: [],
  },
  icon: {
    options: ICON_SIZE_HIGHLIGHTS.map((x) => ({ label: `${x}×${x}`, value: x })),
    default: validIconSizes,
  },
};

export const ALL_ICON_SIZES = validIconSizes;

export type ArtworkProviderId = 'steamgriddb' | 'playstation' | 'igdb' | 'alphacoders' | 'nintendo' | 'xbox' | 'iidb' | 'ign';

export type ProviderFilterOption = {
  label: string;
  value: string;
};

export type ArtworkProvider = {
  label: string;
  value: ArtworkProviderId;
  assets: SGDBAssetType[];
  exactDimensions?: boolean;
  qualityLevels?: string[];
  qualityLevelsByAsset?: Partial<Record<SGDBAssetType, string[]>>;
  fileTypes?: boolean;
  contentTypes?: Partial<Record<SGDBAssetType, ProviderFilterOption[]>>;
  aspectModes?: Partial<Record<SGDBAssetType, ProviderFilterOption[]>>;
  /** Where the game-name suggestions come from. */
  gameSearch?: 'steamgriddb' | 'provider';
  /** Offer the text typed by the user as a stable, literal first choice. */
  exactSearch?: boolean;
  /*
    Which cover shapes this source actually has.

    PlayStation, Nintendo and IGN publish SQUARE covers (the PS5 tile is 1024x1024);
    asking them for portrait covers is why they "found nothing", and offering a "Portrait
    only" option on them is a promise the search cannot keep. This list decides both
    what is searched and what the interface may offer.
  */
  coverShapes?: Array<'portrait' | 'square'>;
  /*
    The game is looked up in the provider's own store instead of SteamGridDB.

    Passing a SteamGridDB title to a store search is a game of telephone: when the two
    databases spell a game differently the store finds nothing at all. These providers get
    their own picker, which selects the best store match on its own and lets the user
    change it.
  */
  storeSearch?: boolean;
  defaultAspectMode?: Partial<Record<SGDBAssetType, string>>;
  description: string;
};

const landscapeContent = {
  grid_l: [
    { label: t('PA_ART_AND_SCREENSHOTS', 'Artwork and screenshots'), value: 'all' },
    { label: t('PA_ARTWORK_ONLY', 'Artwork only'), value: 'artwork' },
    { label: t('PA_SCREENSHOTS_ONLY', 'Screenshots only'), value: 'screenshot' },
  ],
  hero: [
    { label: t('PA_ART_AND_SCREENSHOTS', 'Artwork and screenshots'), value: 'all' },
    { label: t('PA_ARTWORK_ONLY', 'Artwork only'), value: 'artwork' },
    { label: t('PA_SCREENSHOTS_ONLY', 'Screenshots only'), value: 'screenshot' },
  ],
};

const mixedCoverAspects = {
  grid_p: [
    { label: t('PA_BOTH_PORTRAIT_SQUARE', 'Portrait and square'), value: 'both' },
    { label: t('PA_PORTRAIT_ONLY', 'Portrait only'), value: 'portrait' },
    { label: t('PA_SQUARE_ONLY', 'Square only'), value: 'square' },
  ],
};

export const ARTWORK_PROVIDERS: { options: ArtworkProvider[]; default: ArtworkProviderId } = {
  options: [
    { label: 'SteamGridDB', value: 'steamgriddb', assets: ['grid_p', 'grid_l', 'hero', 'logo', 'icon'], exactDimensions: true, fileTypes: true, coverShapes: ['portrait', 'square'], gameSearch: 'steamgriddb', description: t('PA_PROVIDER_SGDB_DESC', 'Community artwork, official assets, styles and animations. Cover shape is determined by the selected resolutions.') },
    { label: 'PlayStation', value: 'playstation', assets: ['grid_p', 'grid_l', 'hero', 'logo'], contentTypes: landscapeContent, storeSearch: true, gameSearch: 'provider', coverShapes: ['square'], description: t('PA_PROVIDER_PLAYSTATION_DESC', 'Official PlayStation covers, key art, screenshots and logos.') },
    { label: 'IGDB', value: 'igdb', assets: ['grid_p', 'grid_l', 'hero'], contentTypes: landscapeContent, gameSearch: 'provider', exactSearch: true, coverShapes: ['portrait'], description: t('PA_PROVIDER_IGDB_DESC', 'Covers, artwork and screenshots from IGDB.') },
    { label: 'AlphaCoders', value: 'alphacoders', assets: ['grid_l', 'hero'], fileTypes: true, gameSearch: 'provider', exactSearch: true, description: t('PA_PROVIDER_ALPHACODERS_DESC', 'Landscape wallpapers, including high-resolution images.') },
    { label: 'Nintendo', value: 'nintendo', assets: ['grid_p', 'grid_l', 'hero'], contentTypes: landscapeContent, storeSearch: true, gameSearch: 'provider', coverShapes: ['square'], description: t('PA_PROVIDER_NINTENDO_DESC', 'Official Nintendo square covers, key art and screenshots.') },
    { label: 'Xbox', value: 'xbox', assets: ['grid_p', 'grid_l', 'hero', 'icon'], contentTypes: landscapeContent, gameSearch: 'provider', coverShapes: ['portrait', 'square'], aspectModes: mixedCoverAspects, defaultAspectMode: { grid_p: 'both' }, description: t('PA_PROVIDER_XBOX_DESC', 'Official Xbox covers, key art, screenshots and icons.') },
    { label: 'iiDB', value: 'iidb', assets: ['grid_l', 'hero', 'logo', 'icon'], fileTypes: true, gameSearch: 'provider', description: t('PA_PROVIDER_IIDB_DESC', 'Banners, heroes, logos and icons from iiDB.') },
    { label: 'IGN', value: 'ign', assets: ['grid_p'], gameSearch: 'provider', coverShapes: ['square'], description: t('PA_PROVIDER_IGN_DESC', 'Editorial square covers from IGN.') },
  ],
  default: 'steamgriddb',
};

export const providersForAsset = (assetType: SGDBAssetType) => ARTWORK_PROVIDERS.options.filter((provider) => provider.assets.includes(assetType));

export const providerForId = (provider: string) => ARTWORK_PROVIDERS.options.find((item) => item.value === provider) ?? ARTWORK_PROVIDERS.options[0];

export const providerLabel = (provider?: string) => {
  const id = String(provider ?? '').trim().toLowerCase();
  if (id === 'google') return 'URL';
  return ARTWORK_PROVIDERS.options.find((item) => item.value === id)?.label ?? String(provider ?? '');
};

export const QUALITY_LEVELS = {
  options: [
    { label: t('PA_ANY', 'Any'), value: 'any' },
    { label: t('PA_QUALITY_GOOD', 'Good'), value: 'standard' },
    { label: t('PA_QUALITY_HIGH', 'High'), value: 'high' },
    { label: t('PA_QUALITY_VERY_HIGH', 'Very high'), value: 'ultra' },
  ],
  default: 'standard',
};

/** Which side of the artwork the threshold is measured on. */
export const qualityAxis = (assetType: SGDBAssetType) =>
  assetType === 'grid_p' ? 'height' : assetType === 'icon' ? 'side' : 'width';

export const QUALITY_THRESHOLDS: Record<string, Record<SGDBAssetType, number>> = {
  standard: { grid_p: 720, grid_l: 920, hero: 1280, logo: 512, icon: 128 },
  high: { grid_p: 900, grid_l: 1600, hero: 1920, logo: 1024, icon: 256 },
  ultra: { grid_p: 1440, grid_l: 2560, hero: 3200, logo: 1600, icon: 512 },
};

export const qualityFilterDescription = (assetType: SGDBAssetType) => {
  const key = qualityAxis(assetType) === 'height'
    ? 'PA_QUALITY_DESC_HEIGHT'
    : qualityAxis(assetType) === 'side' ? 'PA_QUALITY_DESC_SIDE' : 'PA_QUALITY_DESC_WIDTH';
  const fallback = qualityAxis(assetType) === 'height'
    ? 'Discard artwork below the selected resolution, measured by height.'
    : qualityAxis(assetType) === 'side'
      ? 'Discard artwork below the selected resolution, measured by side length.'
      : 'Discard artwork below the selected resolution, measured by width.';
  return t(key, fallback);
};

/**
 * The levels are shown as the resolution they actually enforce, not as adjectives:
 * "from 900 px" says something, "High" does not.
 */
export const qualityLevelsForProvider = (provider: ArtworkProvider, assetType?: SGDBAssetType) => {
  const levels = (assetType && provider.qualityLevelsByAsset?.[assetType]) || provider.qualityLevels || [];
  return QUALITY_LEVELS.options
    .filter((option) => levels.includes(option.value))
    .map((option) => {
      if (option.value === 'any' || !assetType) return { label: t('PA_ANY', 'Any'), value: option.value };
      const threshold = QUALITY_THRESHOLDS[option.value]?.[assetType];
      return { label: threshold ? t('PA_FROM_PX', 'From {value} px').replace('{value}', String(threshold)) : option.label, value: option.value };
    });
};

export const contentTypesForProvider = (provider: ArtworkProvider, assetType: SGDBAssetType) => provider.contentTypes?.[assetType] ?? [];

/*
  Only the shapes the source can actually deliver.

  A selector offering "Portrait only" on a source that only has square covers is a
  promise the search cannot keep: the user picks it and gets nothing, with no explanation.
*/
export const aspectModesForProvider = (provider: ArtworkProvider, assetType: SGDBAssetType) => {
  const options = provider.aspectModes?.[assetType] ?? [];
  if (assetType !== 'grid_p' || options.length === 0) return options;
  const shapes = provider.coverShapes ?? ['portrait', 'square'];
  if (shapes.length < 2) return [];
  return options;
};

/** The cover shapes a source has, regardless of whether a selector is shown. */
export const coverShapesForProvider = (provider: ArtworkProvider): Array<'portrait' | 'square'> =>
  provider.coverShapes ?? ['portrait'];

// Sometimes tabs needs different translation strings
export const tabStrs: Record<SGDBAssetType | 'manage', string> = {
  grid_p: t('LABEL_TAB_CAPSULE', 'Capsule'),
  grid_l: t('LABEL_TAB_WIDECAPSULE', 'Wide Capsule'),
  hero: t('LABEL_TAB_HERO', 'Hero'),
  logo: t('LABEL_TAB_LOGO', 'Logo'),
  icon: t('LABEL_TAB_ICON', 'Icon'),
  manage: t('LABEL_TAB_MANAGE', 'Manage'),
};

// Default tab order
export const DEFAULT_TABS: SGDBAssetType[] | string[] = [
  ...Object.keys(tabStrs),
];
