<div align="center">

<img src="thumb.png" width="240" alt="Playhub Artworks" />

# Playhub Artworks

### La tua libreria, con l'artwork che merita.

Gestisci cover, banner, sfondi, loghi e icone direttamente da Steam Big Picture, con un'interfaccia pensata per il controller.

[![Playhub](https://img.shields.io/badge/GitHub-Playhub-ffffff?style=for-the-badge&logo=github&labelColor=111111)](https://github.com/LoZazaMastro/Playhub)
[![Licenza GPL-3.0](https://img.shields.io/badge/Licenza-GPL--3.0-EA4335?style=for-the-badge&labelColor=111111)](LICENSE)

</div>

## Tutto l'artwork, al posto giusto

Playhub Artworks porta in Gaming Mode un gestore completo per la grafica della libreria. Puoi cercare, confrontare e applicare ogni elemento senza tornare al desktop e senza sistemare file a mano.

- **Otto sorgenti in un'unica interfaccia:** SteamGridDB, PlayStation, Nintendo, Xbox, IGDB, AlphaCoders, iiDB e IGN.
- **Ricerca coerente con la sorgente:** ogni servizio usa i propri risultati e i suggerimenti disponibili; IGDB e AlphaCoders permettono anche una ricerca esatta.
- **Tutti i formati di Steam:** cover, banner, sfondi, loghi e icone, con filtri mostrati soltanto quando sono realmente supportati.
- **Cover classiche o quadrate:** il formato scelto viene applicato a Home, Libreria, Informazioni sul gioco e collezioni.
- **Perfect Hero e Perfect Banner:** sfondo e logo vengono composti in una sola immagine ad alta risoluzione, regolando posizione, scala, opacità e ombra dal gamepad.
- **Hero di ZazaMastro:** quando crei manualmente una Perfect Hero puoi aggiungere un logo anche agli hero pubblicati con il nick SteamGridDB di LoZazaMastro.
- **Lavori in serie:** completa gli artwork mancanti, migliora i banner assenti o a bassa risoluzione portandoli a 920 × 430, rigenera le cover e ripristina gli asset originali di Steam.
- **Scelte persistenti:** formato, sorgenti e filtri vengono ricordati separatamente per ogni tipo di artwork.

## Come si usa

Per modificare un singolo titolo, apri le opzioni del gioco e scegli **Playhub Artworks**. Le preferenze generali, la chiave SteamGridDB e i lavori sull'intera libreria si trovano nel menu rapido di Decky.

Le operazioni in serie mostrano l'avanzamento e rispettano le esclusioni impostate. Per annullare le modifiche gestite dal plugin puoi usare gli strumenti di ripristino degli artwork di Steam.

## Requisiti

- Windows;
- Steam in modalità Big Picture;
- [Decky Loader](https://decky.xyz) 3.x;
- una chiave API personale di [SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) per le ricerche e le operazioni che usano SteamGridDB.

La chiave viene conservata localmente nella cartella dati di Decky.

## Installazione

Puoi installare e aggiornare Playhub Artworks dal Plugin Store incluso in [Playhub](https://github.com/LoZazaMastro/Playhub), oppure manualmente:

1. scarica lo ZIP pubblicato nel [repository di Playhub](https://github.com/LoZazaMastro/Playhub);
2. abilita la modalità sviluppatore di Decky;
3. apri **Decky → Impostazioni → Sviluppatore → Installa plugin da ZIP**;
4. riavvia Decky o Steam quando richiesto.

## Sviluppo

```bash
pnpm install
pnpm run build
```

Il frontend viene generato in `dist/index.js`. Il backend Python e le integrazioni con i provider si trovano in `main.py` e `provider_search.py`.

## Licenza e riconoscimenti

Playhub Artworks è distribuito con licenza [GNU GPL-3.0-or-later](LICENSE). Il progetto nasce da [decky-steamgriddb](https://github.com/SteamGridDB/decky-steamgriddb) e conserva parti compatibili del suo scaffolding, alcuni helper e le traduzioni. Autori, componenti derivati e dipendenze sono documentati in [NOTICE.md](NOTICE.md).

Gli artwork appartengono ai rispettivi autori e titolari. Steam e gli altri marchi citati appartengono ai rispettivi proprietari.

<div align="center">

Creato e mantenuto da **[LoZazaMastro](https://github.com/LoZazaMastro)**.

</div>
