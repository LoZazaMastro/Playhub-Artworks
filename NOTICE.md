# Notice and attributions

Playhub Artworks
Copyright (c) 2026 Andrea Sgarro (LoZazaMastro)

Licensed under the **GNU General Public License v3.0 or later** (see `LICENSE`).

## Derived from decky-steamgriddb

The project started from [`SteamGridDB/decky-steamgriddb`](https://github.com/SteamGridDB/decky-steamgriddb),
Copyright (c) the SteamGridDB contributors, licensed GPL-3.0-or-later.

Parts still derived from that project, at the time of writing:

- the Decky plugin scaffolding: `rollup.config.mjs`, `tsconfig.json`, the eslint configuration
  and the GitHub workflow helpers;
- shared helpers: `src/utils/getAppDetails.ts`, `getAppOverview.ts`, `getCurrentSteamUserId.ts`,
  `getCustomLogoPosition.ts`, `i18n.ts`, `openFilePicker.tsx`, `showRestartConfirm.tsx`,
  `steam-api-language-map.ts`, `src/patches/patchUtils.ts`;
- interface pieces: `src/components/Chips/`, `src/components/FooterGlyph.tsx`,
  `src/components/asset/LazyImage.tsx` and the provider icons in `src/components/Icons/`;
- the translation files in `src/i18n/`.

Everything else that came from that project and had no use here has been removed: the unused
components, the Crowdin configuration, the string-dump tool, the Python type stubs, the commit
hooks, the editor tasks and the loader SVGs.

Those files keep their original copyright and license. They were modified for Playhub Artworks
during 2025 and 2026 by LoZazaMastro, and the changes are covered by the same license.

The complete corresponding source of every release lives in this repository. Release archives
ship a compiled `dist/index.js`; the sources it is built from are the `src/` directory of the
matching tag, and `pnpm install && pnpm run build` reproduces it.

## New in Playhub Artworks

New work by LoZazaMastro, also GPL-3.0-or-later: the Playhub plugin page and Quick Access
interface, the additional artwork providers (PlayStation, Nintendo, Xbox, IGDB, AlphaCoders,
iiDB and IGN) with their search backend, the Perfect Hero and Perfect Banner
composers, the logo positioner, the square library and Home layout patches, the batch jobs, the
diagnostic log and the self-test harness.

## Third-party components

- `defaults/py_modules/vdf`: the `vdf` Python library, under its own license
  (`defaults/py_modules/vdf/LICENSE`).

## Trademarks and content

Artwork returned by SteamGridDB, IGDB, the PlayStation Store, the Nintendo eShop, the Xbox
store, AlphaCoders, iiDB and IGN belongs to its respective owners. Steam is a
trademark of Valve Corporation.
