<div align="center">

<img src="thumb.png" width="240" alt="Playhub Artworks" />

# Playhub Artworks

### Your library, with the artwork it deserves.

Manage covers, banners, backgrounds, logos and icons directly from Steam Big Picture, with an interface built for your controller.

[![Playhub](https://img.shields.io/badge/GitHub-Playhub-ffffff?style=for-the-badge&logo=github&labelColor=111111)](https://github.com/LoZazaMastro/Playhub)
[![GPL-3.0 License](https://img.shields.io/badge/License-GPL--3.0-EA4335?style=for-the-badge&labelColor=111111)](LICENSE)

</div>

## Every artwork in its place

Find, compare and apply artwork without returning to the desktop or moving files by hand.

- **Eight sources in one place:** SteamGridDB, PlayStation, Nintendo, Xbox, IGDB, AlphaCoders, iiDB and IGN.
- **Source-aware search:** each service uses its own results and available suggestions. IGDB and AlphaCoders also support exact searches.
- **Every Steam artwork format:** covers, banners, backgrounds, logos and icons, with filters shown only where supported.
- **Portrait or square covers:** apply your preferred shape across Home, Library, game details and collections.
- **Your most recent game as a cover:** replace the wide first tile in Home's recent games with a cover that follows your selected shape.
- **Instant library scrolling:** move between rows without the animated scroll transition. You can also disable the alphabet selector that appears when holding a direction.
- **Perfect Hero and Perfect Banner:** combine a background and logo into one high-resolution image, adjusting position, scale, opacity and shadow with your controller.
- **ZazaMastro heroes:** when creating a Perfect Hero manually, you can also add a logo to heroes published under LoZazaMastro's SteamGridDB nickname.
- **Batch tools:** fill missing artwork, upgrade missing or low-resolution banners to 920 x 430, regenerate covers and restore Steam's original assets.
- **Remembered preferences:** shape, sources and filters are saved separately for each artwork type.

## Getting started

Open a game's options and choose **Playhub Artworks** to edit its artwork. General preferences, your SteamGridDB key and library-wide tools are available in Decky's Quick Access Menu.

Batch operations show their progress and respect your exclusions. Use the Steam artwork restore tools to undo supported changes made through the plugin.

## Requirements

- Windows.
- Steam Big Picture.
- [Decky Loader](https://decky.xyz) 3.x.
- A personal [SteamGridDB API key](https://www.steamgriddb.com/profile/preferences/api) for searches and operations that use SteamGridDB.

Your API key is stored locally in Decky's data folder.

## Installation

Install and update Playhub Artworks through the Plugin Store in [Playhub](https://github.com/LoZazaMastro/Playhub), or install it manually:

1. Download the installer ZIP from [Playhub Artworks releases](https://github.com/LoZazaMastro/Playhub-Artworks/releases).
2. Enable Decky's developer mode.
3. Open **Decky > Settings > Developer > Install plugin from ZIP** and select the ZIP.

## Development

```bash
pnpm install
pnpm run build
```

The frontend is built into `dist/index.js`. The Python backend and provider integrations are in `main.py` and `provider_search.py`.

## License and credits

Playhub Artworks is licensed under [GNU GPL-3.0-or-later](LICENSE). It is based on [decky-steamgriddb](https://github.com/SteamGridDB/decky-steamgriddb) and retains compatible parts of its scaffolding, helpers and translations. Authors, derived components and dependencies are documented in [NOTICE.md](NOTICE.md).

Artwork belongs to its respective creators and rights holders. Steam and other mentioned trademarks belong to their respective owners.

<div align="center">

Created and maintained by **[LoZazaMastro](https://github.com/LoZazaMastro)**.

</div>
