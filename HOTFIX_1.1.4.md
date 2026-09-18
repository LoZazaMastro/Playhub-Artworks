# Playhub Artworks 1.1.4 — Hotfix 2

## Installazione e identificazione

La versione resta **1.1.4**. Il nuovo identificativo diagnostico è **1.1.4-hotfix.2**.
Installare `Playhub-Artworks-1.1.4_Hotfix2_Installer.zip`, che sostituisce la Hotfix 1 e il primo Installer 1.1.4. Riavviare completamente Steam e Decky/Playhub dopo l'installazione per eliminare i moduli della precedente sessione.
Il log `plugin mounted` deve indicare `build: 1.1.4-hotfix.2`.

Non è necessario eliminare impostazioni, chiavi API, associazioni, artwork o backup.
`main.py`, `provider_search.py`, tutti i 31 JSON delle lingue, i manifest e le dipendenze sono invariati rispetto alla Hotfix 1. Anche le patch Home/menu e gli stili restano invariati: questa correzione riguarda il componente dell'icona delle note.

## Evidenze e causa riprodotta

Il nuovo `playhub-artworks(4).jsonl` registra due errori React #130 con argomento `undefined`, alle 12:09:50.813Z e 12:09:58.225Z del 18 settembre 2026. Il component stack passa da `li`, `Chip`, `Chips` e `Asset` alla pagina degli artwork. Lo stesso errore si ripresenta alla riapertura della pagina. I risultati SteamGridDB vengono ricevuti prima del crash.

Nella Hotfix 1 `FooterGlyph.tsx` esportava direttamente il risultato di `findModuleExport`. Il criterio richiedeva sia `.Knockout` sia `.additionalClassName` nel testo della stessa funzione.
Nel modulo 58470 dei file Steam forniti, la funzione del glyph mantiene `additionalClassName` e i casi dei pulsanti, ma la scelta dello stile `.Knockout` è stata spostata in una funzione helper. Il criterio precedente quindi non trova il componente e il suo export diventa `undefined`.

Il badge Note di `Asset.tsx` include `<FooterGlyph button={11} ... />` soltanto quando l'artwork contiene note. La prima immagine con note può quindi interrompere il rendering dell'intera pagina. Le schede senza note non percorrono quel ramo: questo spiega perché un semplice test di avvio del plugin non lo rilevava.

La riproduzione è stata eseguita sul **bundle effettivo dell'Installer Hotfix 1**: con React/ReactDOM 19.1.1 estratti dai file Steam, Chromium riproduce lo stesso React #130 e lo stack `Chip`/`Asset`. Il controllo con la stessa scheda senza note non genera il crash. Questo identifica il difetto relativo alla nuova schermata del plugin; non dimostra retroattivamente la causa di ogni precedente riferimento generico Shared SteamUI.

La documentazione React descrive #130 come un tipo di elemento non valido:
https://react.dev/errors/130

## Correzione

`FooterGlyph` ora è sempre un componente React valido. Il riconoscimento usa i nomi dei pulsanti e `additionalClassName`, senza dipendere dall'inlining di `.Knockout`, e mantiene il riconoscimento della forma precedente. Sono gestiti anche i wrapper `memo` e `forwardRef`, senza eseguire le funzioni durante la ricerca.

Quando il modulo è assente, non riconosciuto, invalido o la ricerca solleva un'eccezione, il badge Note usa un piccolo SVG locale del pulsante Start/Menu. L'etichetta tradotta e le note restano disponibili. Il glyph è decorativo e non sostituisce né altera i dati dell'artwork.

Una ricerca riuscita viene riutilizzata. Un esito negativo limita le scansioni a una ogni due secondi e può essere ritentato a un successivo rendering: una griglia di molte immagini non ripete la scansione per ogni badge. Non vengono introdotti timer, listener globali o nuove dipendenze.

## Test eseguiti su questa build

- **31 test Python superati**, con controllo sintattico dei due moduli backend.
- **48 test JavaScript superati**, senza test saltati usando il bundle React Steam e il progetto della prima 1.1.4 come input esterni. Comprendono 11 nuovi test specifici del glyph. Senza gli input esterni, la suite ordinaria passa 47 test e salta il solo confronto storico con il vecchio progetto.
- **12 test di rendering in Chromium superati**, usando il riconciliatore ReactDOM reale 19.1.1 fornito da Steam: riproduzione sulla Hotfix 1, controllo senza note, glyph nativo/assente/errore/invalido/memo/forwardRef, griglia mista, limitazione delle scansioni, recupero dopo disponibilità tardiva e chiusura/riapertura ripetuta. Nessun errore browser non gestito.
- **18 controlli statici superati** sui 367 file JavaScript Steam forniti.
- Frontend ricompilato: **101 moduli**, TypeScript **5.8.3**, build `1.1.4-hotfix.2`. Hash delle sorgenti e del bundle verificati.
- Integrità degli ZIP e corrispondenza dei file runtime tra Installer e Project verificate durante il confezionamento.

Il test browser usa i veri `Asset`, `Chips`, `FooterGlyph` e `PluginErrorBoundary` del bundle compilato, la vera factory Steam del glyph e il vero ReactDOM in Chromium. **Decky Focusable/API, gli enum dei pulsanti e la localizzazione Steam sono adattatori di test**. Non è una sessione del client Steam né una prova completa della navigazione controller sul PC dell'utente. Le richieste di rete sono bloccate durante il test.

Report: `tests/reports/test-results.json`, `tests/reports/browser-render-results.json` e `tests/reports/steam-contracts.json` nel Project. I file Steam, gli archivi precedenti e i log personali sono soltanto input esterni e non sono inclusi nei pacchetti.

## Build e ripetizione dei test

È stato usato il builder offline già incluso nel progetto: ricompila tutti i sorgenti TS/TSX/JSON del plugin e conserva solo le dipendenze e il CSS invariati già documentati in `tools/vendor/README.md`. L'accesso al registro npm non era disponibile; **non sono stati eseguiti la build standard Rollup, il lint completo o il controllo semantico TypeScript con tutte le dipendenze installate**.

```sh
npm run test:offline
node tools/check-steam-contracts.cjs /percorso/file-steam-estratti
```

Per i 48 test frontend con gli input esterni, impostare `STEAM_REACT_BUNDLE` sul file `libraries~00299a408.js` e `ARTWORKS_PREVIOUS_PROJECT` sulla directory della prima 1.1.4, quindi eseguire `node tools/test-frontend.cjs`.

Per il test browser sono necessari Python Playwright e Chromium già installati:

```sh
python tools/test-browser.py --steam-dir /percorso/file-steam-estratti --previous-zip /percorso/Playhub-Artworks-1.1.4_Hotfix1_Installer.zip --report tests/reports/browser-render-results.json
```

`--chromium` consente di specificare il percorso del browser. La riproduzione della vecchia build viene esclusa quando non viene passato `--previous-zip`. Il test helper legge le factory dai file originali forniti: non scarica né redistribuisce sorgenti Steam.

## Verifica nel client

Dopo il riavvio aprire la pagina artwork dello stesso gioco segnalato e lasciare caricare anche le immagini con note. Verificare che restino visibili la griglia, il badge Note e l'accesso ai dettagli. Chiudere e riaprire la pagina una seconda volta.

Il `WinError 64` nei due brevi log rimane un errore del socket di Decky Loader: questa hotfix non modifica il loader e non dichiara eliminati i reset di trasporto. Il precedente rapporto Hotfix 1 è conservato separatamente in `HOTFIX1_1.1.4.md`.
