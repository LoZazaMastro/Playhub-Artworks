# Playhub Artworks 1.1.4 — Hotfix 1

## Identificazione e installazione

Versione richiesta conservata: **1.1.4**. Identificativo diagnostico: **1.1.4-hotfix.1**.
Usare lo ZIP `Playhub-Artworks-1.1.4_Hotfix1_Installer.zip`, non il precedente Installer 1.1.4.
Lo ZIP Project contiene gli stessi file runtime, più sorgenti, test e builder.

Dopo l'installazione chiudere completamente Steam e riavviare anche Decky/Playhub. Il solo ricaricamento del plugin non è una verifica affidabile: le vecchie patch e gli hook eventualmente rimasti modificati appartengono alla sessione Steam già aperta.
Non vengono cancellate impostazioni, associazioni, chiavi API, artwork o backup. Il backend Python e tutti i file di traduzione sono invariati rispetto alla prima 1.1.4.

## Segnalazione ed evidenze

Riferimento riportato: `Shared SteamUI 11006468 111f9e2e417fb198`.
I due nuovi log `.log` contengono soltanto il `WinError 64` nel socket interno di Decky Loader. Non contengono lo stack JavaScript che ha generato la schermata SteamUI, quindi **non è dimostrato che quel reset sia la causa del crash**.

Nel JSONL più recente il plugin usa `/index.html` anche durante operazioni sulla pagina degli artwork; i controlli del layout non trovano copertine. Nei file Steam allegati la finestra espone anche `History`, separata da `BrowserWindow.location`. Questo giustifica il supporto della cronologia interna, ma il solo URL `/index.html` non prova che il documento selezionato fosse necessariamente quello sbagliato.

## Difetti corretti

### Patch Home e contratti React

La prima 1.1.4 applicava `afterPatch` direttamente a `props.children.type` nelle patch Home. Un tipo React `memo` o `forwardRef` è un oggetto, non una funzione invocabile con `.call`. Il test di regressione eseguito sul sorgente del precedente ZIP riproduce `original.call is not a function` quando il figlio della route è un `memo`. Questo dimostra il difetto del codice, **non identifica da solo il tipo effettivo presente nel PC al momento del crash**.

La patch ridondante delle dimensioni Home non modifica più il tipo dei componenti: restano attivi CSS e metodi del carosello già usati per le celle quadrate. L'opzione della prima copertina nei recenti conserva la sua funzione con un adattatore immutabile che gestisce separatamente funzioni, classi, `memo` e `forwardRef`, mantiene key/ref, riutilizza i wrapper e non memorizza il risultato dei render. I tipi sconosciuti non vengono forzati. Lo scaricamento del plugin non avvia una navigazione.

### Ricerca del menu

L'helper `fakeRenderComponent` della libreria Decky consultata installa hook temporanei, esegue la factory e poi li rimuove, senza `finally`. Se la factory genera un'eccezione, il codice precedente la intercettava senza garantire il ripristino degli hook.

La hotfix usa `applyHookStubs` e `removeHookStubs` con ripristino in `finally`. Il relativo test verifica l'identità degli hook dopo una factory che fallisce. Per inserire la voce Playhub Artworks viene preferito lo stesso tipo di componente della voce Proprietà nativa. Un menu senza punto di inserimento riconosciuto rimane invariato; non viene aggiunto un componente indefinito.

Riferimenti primari consultati, stato letto il 18 settembre 2026:
- SteamDeckHomebrew/decky-frontend-lib, `src/utils/react/react.ts` e `src/utils/index.ts`.
- SteamDeckHomebrew/decky-frontend-lib, `src/utils/react/treepatcher.ts` e `src/components/Menu.ts`.
Le modifiche sono locali al plugin. Nessuna modifica al loader, ai file Steam o alle impostazioni degli altri plugin.

### Finestra e diagnostica

La ricerca della finestra preferisce `IsMainGamepadUIWindow` e scarta overlay, VR e tastiera autonoma. La route logica viene letta da `History.location.pathname`, con fallback al percorso del browser. Finestre chiuse o non accessibili non fanno fallire le letture della route.

Il filtro precedente riconosceva `playhub-artworks`, ma non `Playhub%20Artworks`, presente negli URL Decky. Ora gestisce entrambe le forme. I listener seguono sia Shared SteamUI sia la finestra Big Picture e vengono rimossi dopo la sostituzione della finestra o l'unload. Le pagine del plugin e il pannello Quick Access hanno una barriera locale agli errori React, che registra stack JavaScript e component stack. Non viene sostituito l'error handler globale Steam e non vengono soppressi errori di altri plugin.

## Verifiche della hotfix

- **31 test Python superati**.
- **37 test JavaScript superati**, nessuno saltato nella sessione con i file originali: includono i test esistenti, i nuovi casi React/route/menu/diagnostica e la riproduzione del difetto sul precedente sorgente 1.1.4.
- I test specifici React e il test d'importazione/mount/unload del bundle sono stati eseguiti anche usando **React 19.1.1 estratto in memoria dal bundle Steam allegato**. Le chiamate Decky, i renderer di prova e i documenti restano simulati: **non è una prova nel client Steam né con il riconciliatore ReactDOM completo**.
- Senza gli input opzionali, la suite ordinaria usa un mock esplicito del contratto React; l'unico caso saltato è la riproduzione sul vecchio ZIP non incluso nel progetto. Risultato locale ordinario: 36 superati, 1 saltato.
- **18 controlli statici Steam**: menu, artwork API, caroselli, chiavi CSS, cronologia interna, selezione della finestra e simboli React. Il report conserva nomi relativi e hash, non sorgenti Steam.
- Frontend ricompilato: **101 moduli**, TypeScript **5.8.3**; sintassi del bundle e Python controllate.

Le dipendenze iniettate da Decky non sono state aggiornate nel loader. La build offline riutilizza il runtime di dipendenze invariato già documentato nella prima 1.1.4, e ricompila tutti i sorgenti del plugin. Non è stato eseguito il build standard Rollup, il lint completo o il controllo semantico TypeScript con tutte le dipendenze installate.

## Ripetere i test

Con TypeScript disponibile localmente o globalmente:

```sh
npm run test:offline
node tools/check-steam-contracts.cjs /percorso/steam-estratto
```

Per i test aggiuntivi con gli input esterni, impostare `STEAM_REACT_BUNDLE` sul file `libraries/libraries~00299a408.js` fornito e `ARTWORKS_PREVIOUS_PROJECT` sulla directory `Playhub-Artworks` estratta dal precedente ZIP Project 1.1.4. Poi eseguire `node tools/test-frontend.cjs`. Questi input non vengono copiati nel rilascio.

## Da verificare nel client reale

Dopo il riavvio completo: apertura Home, cambio Home/Libreria, menu del gioco, apertura pagina artwork, formato quadrato/rettangolare, opzione prima copertina nei recenti, ingresso/uscita Big Picture. Verificare anche cambio gioco nel menu e mantenimento delle preferenze. Il log `plugin mounted` deve riportare `build: 1.1.4-hotfix.1`.

Non è stata eseguita una sessione Windows/Steam/Decky sul PC dell'utente. Non è possibile dichiarare eliminato quello specifico riferimento SteamUI senza la prova nel client o il suo stack JavaScript. La hotfix elimina difetti riproducibili e amplia la diagnostica per distinguere eventuali problemi residui.
