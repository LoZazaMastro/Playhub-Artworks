# Playhub Artworks 1.1.4 — Hotfix 2

La build corrente è **1.1.4-hotfix.2**; la versione del plugin resta **1.1.4**.
Il rapporto corrente è **HOTFIX_1.1.4.md**. Risultati: 31 test Python, 48 test JavaScript con input esterni, 12 test browser con ReactDOM reale e 18 controlli statici Steam. Report dettagliati in `tests/reports/` nel Project. Il confronto browser sul bundle Hotfix 1 riproduce #130 con note e non lo riproduce senza note; il bundle Hotfix 2 supera entrambi i casi.

Le sezioni sotto conservano il rapporto storico della prima 1.1.4. Il rapporto Hotfix 1 è in **HOTFIX1_1.1.4.md**. I relativi conteggi e limiti storici non sostituiscono quelli della Hotfix 2.

---

# Playhub Artworks 1.1.4 — verifiche e note di consegna

## Base della modifica

La release parte dagli ZIP Project e Installer 1.1.3 forniti nella conversazione. Le verifiche Steam fanno riferimento esclusivamente ai file degli archivi `steamui - Copia.zip` e `public.zip` allegati, non a una versione del client ricavata da una data o da un numero di build presunto. Non sono stati inclusi file proprietari Steam, log personali o impostazioni dell'utente negli archivi di rilascio.

## Risultati eseguiti

- 31 test Python superati: sicurezza delle risorse, elaborazioni derivate, comportamento delle patch e nuovi casi di compatibilità, provider, retry e dimensioni delle immagini.
- 22 test JavaScript superati: menu, finestra Steam, CSS, layout, ricerche, normalizzazione delle immagini, callback sincrone, polling e teardown. È incluso un test del bundle compilato: importazione con moduli Steam non ancora disponibili, doppio mount e pulizia finale di timer, listener e stili in un ambiente simulato.
- Compilazione sintattica di `main.py` e `provider_search.py` completata.
- Frontend ricompilato dai sorgenti: 97 moduli, TypeScript 5.8.3; controllo sintattico del JavaScript compilato completato.
- 15 controlli statici superati su 367 file JavaScript Steam forniti: struttura del menu, app selezionata, metodi del carosello, chiavi CSS, callback dei dettagli e API artwork. Il rapporto `tests/reports/steam-contracts.json` conserva soltanto nomi relativi e hash, non il codice Steam.

Comando completo eseguito: `npm run test:offline`. I numeri sopra indicano test automatici e verifiche statiche, non sessioni di gioco o prove manuali su Steam.

## Correzioni e relazione con i log

### Menu, Home e layout Steam

La risoluzione della finestra usa il documento Big Picture attivo invece di conservare riferimenti a documenti chiusi o alla finestra desktop. Il menu viene individuato quando il relativo modulo è disponibile; la patch riguarda soltanto il menu specifico del gioco, non il componente condiviso dei menu Steam. L'app viene letta al momento dell'apertura, la selezione multipla viene esclusa e l'inserimento non modifica direttamente i figli React.

Le patch Home già installate vengono riutilizzate. Le inizializzazioni lente continuano con tentativi diradati invece di abbandonare definitivamente il layout. Le risposte delle impostazioni arrivate fuori ordine o dopo lo scaricamento del plugin vengono ignorate; un errore di lettura non sovrascrive le preferenze con valori predefiniti. La gestione dei descrittori dei metodi del carosello già presente nella 1.1.3 è stata mantenuta.

### Ricerca e provider

Un errore di ricerca non viene più trasformato indistintamente in un elenco vuoto riuscito. Questo consente al recupero dell'associazione SteamGridDB di gestire `Game not found`. La selezione automatica richiede un titolo esatto normalizzato; altrimenti resta la scelta esplicita del gioco. I risultati di richieste ormai superate non sostituiscono quelli correnti.

Le query iiDB di suggerimento sono state allineate alla ricerca tipizzata già utilizzata dal progetto per gli artwork e mantengono l'ID proprio della fonte selezionata. È una correzione basata sul codice e sugli HTTP 400 osservati: la risposta del servizio online non è stata verificata in questo ambiente. I test usano risposte simulate. Non viene garantita l'assenza di futuri errori del servizio.

I GET dei provider possono essere ritentati una sola volta per errori transitori previsti, inclusi alcuni errori TLS/connessione e HTTP 429/502/503/504. Non si disabilita la verifica dei certificati e non si ritentano automaticamente POST o normali errori 4xx.

### Immagini e compositore

I log mostrano rifiuti `PA_ERROR_ARTWORK_TOO_LARGE`, ma non contengono le immagini originali né tutte le loro dimensioni: non è possibile dimostrare che ogni singolo rifiuto fosse ingiustificato.

I limiti delle sorgenti e dei risultati ora sono distinti. Una sorgente decodificata può arrivare a 36.000.000 pixel e a 16.384 pixel per lato. I risultati applicati restano entro 16.000.000 pixel e 6.144 pixel per lato; il limite dei file/trasferimenti rimane 16 MiB. Le immagini statiche idonee vengono ridimensionate mantenendo il rapporto d'aspetto. Se una conversione PNG supera il limite in byte, si prova una riduzione progressiva, con numero di tentativi limitato e trasparenza mantenuta.

I target di Perfect Hero e Perfect Banner non cambiano. Non si appiattiscono silenziosamente GIF/APNG animate; il percorso video già previsto dal progetto viene preservato. File realmente oltre i limiti restano rifiutati. La diagnostica aggiunge le dimensioni quando disponibili.

### WinError 64

I quattro traceback brevi riguardano `decky_loader/localplatform/localsocket.py` e `asyncio`, senza frame del plugin. La 1.1.4 ferma polling, timer diagnostici e nuove attività dopo l'unload e limita le richieste concorrenti del plugin; non modifica il socket di Decky Loader. Non è corretto considerare eliminato il `WinError 64` del loader sulla sola base di questi test.

## Build consegnata

L'accesso al registro npm non era disponibile nell'ambiente di lavoro. Non è stato quindi eseguito `pnpm install` né il build Rollup con il set completo delle dipendenze. La build consegnata è stata prodotta da `tools/build-offline.cjs`: ricompila tutti i moduli del plugin dai sorgenti aggiornati e riutilizza soltanto il runtime delle dipendenze e il CSS invariato del bundle 1.1.3 fornito. Il manifest di provenienza è in `tools/vendor/manifest.json`; gli hash degli input e del bundle sono in `dist/build-info.json`.

TypeScript utilizzato: 5.8.3; Node: 22.16.0. Il progetto mantiene la dipendenza di sviluppo TypeScript ^5.9.3 e il normale percorso Rollup. La build offline controlla sintassi e risoluzione degli import, non sostituisce il controllo semantico TypeScript con tutte le dipendenze React/Decky installate. Non sono stati eseguiti lint completo o build standard. Il test del bundle non simula ogni componente React o ogni risposta di rete.

Ricostruzione offline con TypeScript 5.8.3 disponibile localmente o globalmente:

```sh
npm run test:offline
```

Percorso standard in un ambiente con accesso alle dipendenze:

```sh
pnpm install --frozen-lockfile
pnpm test
```

Il builder offline si arresta se gli SCSS sono cambiati: in quel caso usare il percorso standard con Sass. La build standard può produrre un file binariamente diverso da quello consegnato. Le dichiarazioni `.d.ts` obsolete della 1.1.3 non sono state conservate nell'Installer.

## Installazione e verifica sul PC

Installare lo ZIP Installer 1.1.4 con il metodo normalmente utilizzato per Decky. Dopo l'aggiornamento effettuare un riavvio completo di Steam e del processo Decky/Playhub: il solo hot reload potrebbe lasciare le vecchie patch non tracciate della 1.1.3 nella sessione aperta. La release non contiene operazioni di cancellazione delle impostazioni salvate, della chiave API o dei backup artwork.

Verificare nel client reale:

1. Avvio a freddo e ingresso in Big Picture anche dopo un'attesa: la voce Playhub Artworks deve comparire una sola volta e aprire il gioco corretto.
2. Passaggio desktop/Big Picture, navigazione Home/Libreria e opzioni di copertina quadrata: layout coerente, menu Steam normali non alterati.
3. Ricerca SteamGridDB con associazione mancante e selezione manuale iiDB: nessun risultato vecchio al cambio rapido della query, errori reali visibili anziché caricamenti bloccati.
4. Salvataggio Perfect Hero/Perfect Banner e applicazione di una grande immagine statica entro i nuovi limiti sorgente; controllo trasparenza di un logo PNG e animazione delle risorse animate supportate.
5. Disattivazione/riattivazione o riavvio durante un download: nessun nuovo polling o reinserimento delle patch da risposte tardive.

Queste prove manuali Windows/Steam/Decky e le richieste reali ai provider non sono state eseguite nell'ambiente di consegna. Non sono state installate modifiche sul PC dell'utente né pubblicate release remote.
