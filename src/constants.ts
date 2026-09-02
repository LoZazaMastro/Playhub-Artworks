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
  grid_p: 'Cover',
  grid_l: 'Banner',
  hero: 'Sfondo',
  logo: 'Logo',
  icon: 'Icona',
  manage: 'Gestisci',
};

const gridStyles = {
  options: [
    { label: 'Alternate', value: 'alternate' },
    { label: 'White Logo', value: 'white_logo' },
    { label: 'No Logo', value: 'no_logo' },
    { label: 'Blurred', value: 'blurred' },
    { label: 'Minimal', value: 'material' },
  ],
  default: ['alternate', 'white_logo', 'no_logo', 'blurred', 'material'],
};

export const STYLES = {
  grid_p: gridStyles,
  grid_l: gridStyles,
  hero: {
    options: [
      { label: 'Alternate', value: 'alternate' },
      { label: 'Blurred', value: 'blurred' },
      { label: 'Minimal', value: 'material' },
    ],
    default: ['alternate', 'blurred', 'material'],
  },
  logo: {
    options: [
      { label: 'Ufficiale', value: 'official' },
      { label: 'Bianco', value: 'white' },
      { label: 'Nero', value: 'black' },
      { label: 'Custom', value: 'custom' },
    ],
    default: ['official', 'white', 'black', 'custom'],
  },
  icon: {
    options: [
      { label: 'Ufficiale', value: 'official' },
      { label: 'Custom', value: 'custom' },
    ],
    default: ['official', 'custom'],
  },
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
    asking them for portrait covers is why they "found nothing", and offering a "Solo
    verticali" option on them is a promise the search cannot keep. This list decides both
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
    { label: 'Artwork e screenshot', value: 'all' },
    { label: 'Solo artwork', value: 'artwork' },
    { label: 'Solo screenshot', value: 'screenshot' },
  ],
  hero: [
    { label: 'Artwork e screenshot', value: 'all' },
    { label: 'Solo artwork', value: 'artwork' },
    { label: 'Solo screenshot', value: 'screenshot' },
  ],
};

const mixedCoverAspects = {
  grid_p: [
    { label: 'Verticali e quadrate', value: 'both' },
    { label: 'Solo verticali', value: 'portrait' },
    { label: 'Solo quadrate', value: 'square' },
  ],
};

export const ARTWORK_PROVIDERS: { options: ArtworkProvider[]; default: ArtworkProviderId } = {
  options: [
    { label: 'SteamGridDB', value: 'steamgriddb', assets: ['grid_p', 'grid_l', 'hero', 'logo', 'icon'], exactDimensions: true, fileTypes: true, coverShapes: ['portrait', 'square'], gameSearch: 'steamgriddb', description: 'Artwork della community, asset ufficiali, stili e animazioni. La forma della cover è già decisa dalle risoluzioni.' },
    { label: 'PlayStation', value: 'playstation', assets: ['grid_p', 'grid_l', 'hero', 'logo'], contentTypes: landscapeContent, storeSearch: true, gameSearch: 'provider', coverShapes: ['square'], description: 'Cover, key art, screenshot e loghi ufficiali PlayStation.' },
    { label: 'IGDB', value: 'igdb', assets: ['grid_p', 'grid_l', 'hero'], contentTypes: landscapeContent, gameSearch: 'provider', exactSearch: true, coverShapes: ['portrait'], description: 'Cover, artwork e screenshot da IGDB.' },
    { label: 'AlphaCoders', value: 'alphacoders', assets: ['grid_l', 'hero'], fileTypes: true, gameSearch: 'provider', exactSearch: true, description: 'Wallpaper orizzontali anche in alta risoluzione.' },
    { label: 'Nintendo', value: 'nintendo', assets: ['grid_p', 'grid_l', 'hero'], contentTypes: landscapeContent, storeSearch: true, gameSearch: 'provider', coverShapes: ['square'], description: 'Cover quadrate, key art e screenshot ufficiali Nintendo.' },
    { label: 'Xbox', value: 'xbox', assets: ['grid_p', 'grid_l', 'hero', 'icon'], contentTypes: landscapeContent, gameSearch: 'provider', coverShapes: ['portrait', 'square'], aspectModes: mixedCoverAspects, defaultAspectMode: { grid_p: 'both' }, description: 'Cover, key art, screenshot e icone ufficiali Xbox.' },
    { label: 'iiDB', value: 'iidb', assets: ['grid_l', 'hero', 'logo', 'icon'], fileTypes: true, gameSearch: 'provider', description: 'Banner, hero, loghi e icone da iiDB.' },
    { label: 'IGN', value: 'ign', assets: ['grid_p'], gameSearch: 'provider', coverShapes: ['square'], description: 'Cover quadrate editoriali da IGN.' },
  ],
  default: 'steamgriddb',
};

export const providersForAsset = (assetType: SGDBAssetType) => ARTWORK_PROVIDERS.options.filter((provider) => provider.assets.includes(assetType));

export const providerForId = (provider: string) => ARTWORK_PROVIDERS.options.find((item) => item.value === provider) ?? ARTWORK_PROVIDERS.options[0];

export const providerLabel = (provider?: string) => providerForId(String(provider ?? '')).label;

export const QUALITY_LEVELS = {
  options: [
    { label: 'Qualsiasi', value: 'any' },
    { label: 'Buona', value: 'standard' },
    { label: 'Alta', value: 'high' },
    { label: 'Molto alta', value: 'ultra' },
  ],
  default: 'standard',
};

/** Which side of the artwork the threshold is measured on. */
export const qualityAxis = (assetType: SGDBAssetType) =>
  assetType === 'grid_p' ? 'altezza' : assetType === 'icon' ? 'lato' : 'larghezza';

export const QUALITY_THRESHOLDS: Record<string, Record<SGDBAssetType, number>> = {
  standard: { grid_p: 720, grid_l: 920, hero: 1280, logo: 512, icon: 128 },
  high: { grid_p: 900, grid_l: 1600, hero: 1920, logo: 1024, icon: 256 },
  ultra: { grid_p: 1440, grid_l: 2560, hero: 3200, logo: 1600, icon: 512 },
};

export const qualityFilterDescription = (assetType: SGDBAssetType) =>
  `Scarta gli artwork sotto la risoluzione scelta, misurata sull’${qualityAxis(assetType) === 'altezza' ? 'altezza' : `a ${qualityAxis(assetType)}`}.`;

/**
 * The levels are shown as the resolution they actually enforce, not as adjectives:
 * "da 900 px" says something, "Alta" does not.
 */
export const qualityLevelsForProvider = (provider: ArtworkProvider, assetType?: SGDBAssetType) => {
  const levels = (assetType && provider.qualityLevelsByAsset?.[assetType]) || provider.qualityLevels || [];
  return QUALITY_LEVELS.options
    .filter((option) => levels.includes(option.value))
    .map((option) => {
      if (option.value === 'any' || !assetType) return { label: 'Qualsiasi', value: option.value };
      const threshold = QUALITY_THRESHOLDS[option.value]?.[assetType];
      return { label: threshold ? `da ${threshold} px` : option.label, value: option.value };
    });
};

export const contentTypesForProvider = (provider: ArtworkProvider, assetType: SGDBAssetType) => provider.contentTypes?.[assetType] ?? [];

/*
  Only the shapes the source can actually deliver.

  A selector offering "Solo verticali" on a source that only has square covers is a
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
