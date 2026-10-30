# Collezione Jump: app per Android e PC (versione Firebase)

È l'app della tua collezione di V Jump, Shōnen Jump, carte promo e volumi a fumetti.

- **Sul telefono Android** è un'app vera (`CollezioneJump.apk`) che installi tu.
- **Sul PC** è un sito che installi da Chrome o Edge e che si apre in una finestra sua, come un programma.
- **I dati sono gli stessi ovunque.** Stanno su **Firebase di Google** (piano gratuito *Spark*, senza carta di credito), protetti dal tuo login. Ogni dispositivo tiene anche una copia, quindi puoi consultare la collezione, spuntare carte e caricare copertine **senza connessione**. Tutto parte da solo quando torni online.
- **Niente da rinnovare**: niente scadenze mensili, niente pause per inattività.

Ti servono due account gratuiti: **Google** (per Firebase) e **GitHub** (compila l'app Android e pubblica la versione per PC). Prepari tutto **una volta sola**, in circa 20–25 minuti.

---

## Parte A: Firebase (dati e login)

### Passo 1: crea il progetto
1. Vai su <https://console.firebase.google.com> con il tuo account Google.
2. Premi **Crea un progetto** (o *Inizia con un progetto Firebase*).
3. Come nome scrivi `collezione-jump`, accetta i termini e vai avanti.
4. Gemini e Google Analytics puoi **disattivarli**: non servono. Poi premi **Crea progetto**.
5. Il piano resta **Spark (senza costi)**. Non passare al piano Blaze.

### Passo 2: attiva il login e crea il tuo utente
1. Nel menu a sinistra: **Build (Crea) → Authentication → Inizia**.
2. Scheda **Metodo di accesso**: scegli **Email/password**, attiva **solo il primo interruttore** e premi **Salva**.
3. Scheda **Utenti → Aggiungi utente**: inserisci la tua email e una password. Sono quelle che userai nell'app.
4. *(Consigliato)* Scheda **Impostazioni → Azioni utente**: togli la spunta a **Abilita creazione (registrazione)** e salva. Così nessun altro può crearsi un account.

### Passo 3: crea il database
1. Menu: **Build → Firestore Database → Crea database**.
2. Se ti chiede l'edizione scegli **Standard**. L'ID del database lascialo **(default)**: solo quello rientra nel piano gratuito.
3. **Posizione**: una europea, per esempio `eur3 (europe)` oppure `europe-west8 (Milano)`. ⚠️ Non si può cambiare dopo.
4. Scegli **Avvia in modalità di produzione** e premi **Crea**.

### Passo 4: proteggi i dati (regole)
1. In Firestore apri la scheda **Regole**.
2. Cancella il testo che c'è e incolla tutto il contenuto del file `firestore.rules` di questa cartella.
3. Sostituisci `LA-TUA-EMAIL@esempio.it` con **l'email esatta** dell'utente creato al passo 2.
4. Premi **Pubblica**.

Con questa regola solo tu, dopo l'accesso, puoi leggere e scrivere. Tutti gli altri non vedono niente.

### Passo 5: prendi i codici di collegamento
1. In alto a sinistra premi l'ingranaggio **⚙ → Impostazioni progetto → Generali**.
2. In fondo, in **Le tue app**, premi l'icona **`</>`** (Web).
3. Come nickname scrivi `collezione-jump`. *Firebase Hosting* **non** serve. Premi **Registra app**.
4. Ti mostra un blocco `firebaseConfig`. Ti servono solo due valori:
   - `apiKey` (inizia con `AIza…`)
   - `projectId` (per esempio `collezione-jump-1a2b3`)

   Puoi ritrovarli quando vuoi in *Impostazioni progetto → Generali*.

---

## Parte B: GitHub (compila l'app)

### Passo 6: crea il repository e carica i file
1. Vai su <https://github.com>, crea l'account se non ce l'hai e premi **New repository**:
   - **Repository name**: `collezione-jump`
   - **Public**: serve per avere gratis la versione per PC. Il codice sarà visibile, ma i tuoi dati no.
   - premi **Create repository**.
2. **Settings → Pages**: in *Build and deployment → Source* scegli **GitHub Actions**.
3. Torna alla pagina del repository, premi **uploading an existing file** e trascina **tutto il contenuto** di questa cartella: le cartelle `www`, `scripts`, `resources`, `keystore` e `.github` e gli altri file. Poi premi **Commit changes**.
   - Controlla che compaia la cartella **`.github`**. Se manca, vai su *Add file → Create new file*, scrivi come nome `.github/workflows/build.yml`, incolla il contenuto del file e salva.
4. Apri `www/config.js` nel repository, premi la **matita** e incolla `apiKey` e `projectId` al posto di `INCOLLA_QUI_…`, tra le virgolette. Poi premi **Commit changes**.

### Passo 7: aspetta la compilazione
Apri la scheda **Actions**. **Compila app (Android + PC)** ci mette circa 5–8 minuti. Quando i pallini sono verdi è tutto pronto. Se il risultato è rosso, apri la riga e prova **Re-run all jobs**; se resta rosso, mandami una foto dell'errore.

---

## Parte C: installazione

### Telefono Android
1. Dal telefono apri `https://github.com/TUO-NOME-UTENTE/collezione-jump/releases/latest`.
2. Tocca **CollezioneJump.apk** per scaricarlo, poi aprilo.
3. Consenti a Chrome di installare app sconosciute. Se compare Play Protect, tocca **Altri dettagli → Installa comunque**. È normale per le app che non vengono dal Play Store.
4. Apri **Collezione Jump** ed entra con email e password.

**Al primo accesso l'app carica da sola i 13 pezzi del tuo Excel**, con tutti i dati già ricercati. Lo fa una volta sola.

### PC di casa
1. Con Chrome o Edge apri `https://TUO-NOME-UTENTE.github.io/collezione-jump/`.
2. Premi l'icona **Installa** nella barra dell'indirizzo, oppure *Menu ⋮ → Trasmetti, salva e condividi → Installa pagina come app*.
3. Entra con le stesse credenziali.

---

## Uso quotidiano

- **Copertine**: apri un pezzo e premi **Carica foto**. Dal telefono puoi fotografare la tua copia. L'immagine viene ridotta a circa 100–200 KB e salvata nel database. Una volta scaricata resta sul dispositivo, quindi non consuma letture ogni volta.
- **Carte promo**: spunta quelle che hai davvero nella tua copia.
- **Annate V Jump**: è una griglia di 12 mesi per anno. Tocca una casella vuota per aggiungere quel numero ai desiderati.
- **Offline**: il pallino in basso diventa arancione e le modifiche (anche le copertine) restano in attesa; partono da sole quando torni online.
- **Sincronizzazione**: avviene all'apertura, quando torni sull'app, ogni 5 minuti e con il pulsante **Aggiorna**. Vengono scaricate solo le schede cambiate.
- **Backup**: ogni tanto premi **Backup JSON** (contiene i dati; le copertine restano su Firebase). **CSV per Excel** ti dà un foglio da aprire in Excel.

## Limiti gratuiti di Firebase (Spark)

Ogni giorno hai 50.000 letture e 20.000 scritture, più 1 GiB di spazio. Nell'uso normale:
- aprire l'app senza novità costa **1 lettura**;
- ogni modifica costa **1 scrittura**;
- ogni copertina nuova costa **1 lettura**, una volta per dispositivo.

Sei molto lontano dai limiti anche con migliaia di pezzi. Se un giorno li superassi, Firebase blocca le operazioni fino al giorno dopo: non addebita nulla, perché sul piano Spark non c'è nessuna carta collegata.

## Aggiornare l'app

Quando modifichi qualcosa nel repository, GitHub compila una nuova versione da solo. Sul telefono riscarichi l'APK da *releases/latest* e lo installi **sopra**: i dati restano. Sul PC l'app si aggiorna da sola alla riapertura.

## Riusarlo per altri progetti

Lo schema è sempre lo stesso: **app Android e PC dallo stesso codice + Firebase per i dati + GitHub per compilare**. Per un nuovo progetto:
- crei un **nuovo progetto Firebase** (ognuno ha le sue quote gratuite);
- crei un nuovo repository GitHub;
- io adatto l'interfaccia e il tipo di dati.

Il collegamento a Firebase (login, sincronizzazione, coda offline, immagini) si riusa così com'è.

## Cosa c'è in questa cartella

| Percorso | A cosa serve |
|---|---|
| `www/` | l'app: pagina, stile, logica, icone, `config.js` con i codici Firebase, `seed.json` con i 13 pezzi iniziali |
| `firestore.rules` | regole di sicurezza da incollare in Firestore (passo 4) |
| `.github/workflows/build.yml` | compila l'APK e pubblica la versione per PC |
| `scripts/prepare-android.sh` | icona, colore, permesso fotocamera, numero di versione |
| `resources/android/` | icone dell'app Android |
| `keystore/debug.keystore` | firma fissa dell'APK, così gli aggiornamenti si installano sopra |
| `package.json`, `capacitor.config.json` | configurazione di Capacitor, lo strumento che trasforma il sito in app Android |
