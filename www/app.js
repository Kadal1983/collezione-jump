/* Collezione Fumetti – app per PC (PWA) e Android (Capacitor).
   Dati su Firebase: Authentication (email/password) + Firestore (raccolte "items" e "copertine").
   Copia locale (localStorage + IndexedDB) per l'uso offline. Nessuna libreria esterna: solo chiamate REST. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const MESI = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
const MESI_LUNGHI = ["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];
const STATI = {posseduto:"Posseduto", desiderato:"Desiderato", arrivo:"In arrivo"};
const TIPI_ALL = {carta:"Carta promo", codice:"Codice digitale", libretto:"Libretto", adesivi:"Adesivi", altro:"Altro"};
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------------- memoria locale ---------------- */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
  del(k){ try{ localStorage.removeItem(k); }catch{} }
};

/* ---------------- configurazione ---------------- */
function getCfg(){
  const c = window.CJ_CONFIG || {};
  const ok = v => v && !/INCOLLA_QUI/.test(v);
  if (ok(c.FIREBASE_API_KEY) && ok(c.FIREBASE_PROJECT_ID)) return { apiKey: c.FIREBASE_API_KEY.trim(), projectId: c.FIREBASE_PROJECT_ID.trim(), fromFile: true };
  return LS.get("cj_cfg", null);
}
let CFG = getCfg();
// Indirizzi dei servizi Google (sovrascrivibili solo per i test)
const EP = Object.assign({
  auth: "https://identitytoolkit.googleapis.com/v1",
  token: "https://securetoken.googleapis.com/v1",
  store: "https://firestore.googleapis.com/v1",
  ai: "https://generativelanguage.googleapis.com/v1beta"
}, window.CJ_ENDPOINTS || {});
const docsBase = () => `${EP.store}/projects/${encodeURIComponent(CFG.projectId)}/databases/(default)/documents`;

/* ---------------- accesso (Firebase Authentication) ---------------- */
let session = LS.get("cj_session", null);
class NetError extends Error {}
class HttpError extends Error { constructor(status, msg){ super(msg); this.status = status; } }

async function req(url, opts = {}){
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new NetError("rete"); }
  if (!res.ok){
    let msg = res.statusText;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.status)) || msg; } catch {}
    throw new HttpError(res.status, msg);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
function storeSession(idToken, refreshToken, expiresIn, uid, email){
  session = { idToken, refreshToken, expiresAt: Date.now() + (parseInt(expiresIn) || 3600) * 1000, uid, email: email || (session && session.email) };
  LS.set("cj_session", session);
}
async function login(email, password){
  const j = await req(`${EP.auth}/accounts:signInWithPassword?key=${encodeURIComponent(CFG.apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  storeSession(j.idToken, j.refreshToken, j.expiresIn, j.localId, j.email);
}
let refreshing = null;
async function refreshSession(){
  if (!session) throw new HttpError(401, "no session");
  if (!refreshing) refreshing = req(`${EP.token}/token?key=${encodeURIComponent(CFG.apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(session.refreshToken)
    })
    .then(j => storeSession(j.id_token, j.refresh_token, j.expires_in, j.user_id))
    .catch(e => { if (e instanceof HttpError && e.status >= 400 && e.status < 500){ session = null; LS.del("cj_session"); } throw e; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
async function api(path, opts = {}){
  if (!session) throw new HttpError(401, "no session");
  if (Date.now() > session.expiresAt - 60000) await refreshSession();
  const go = () => req(docsBase() + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + session.idToken }, opts.headers || {}) }));
  try { return await go(); }
  catch (e) {
    if (e instanceof HttpError && e.status === 401){ await refreshSession(); return await go(); }
    throw e;
  }
}
const docId = id => encodeURIComponent(id);

/* ---------------- archivio locale delle copertine (IndexedDB) ---------------- */
const IDB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("collezione-jump", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("covers");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("covers", mode); const out = fn(t.objectStore("covers")); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => null),
    put: (k, v) => tx("readwrite", s => { s.put(v, k); }).catch(() => {}),
    del: k => tx("readwrite", s => { s.delete(k); }).catch(() => {}),
    clear: () => tx("readwrite", s => { s.clear(); }).catch(() => {})
  };
})();
const covers = new Map();      // id -> { v, img }  (in memoria)
const coverLoading = new Set();
let coverRenderT = null;
function coverSrc(it){
  if (!it.coverV) return "";
  const c = covers.get(it.id);
  if (c && c.v === it.coverV) return c.img;
  loadCover(it.id, it.coverV);
  return "";
}
async function loadCover(id, v){
  const key = id + "@" + v; if (coverLoading.has(key)) return; coverLoading.add(key);
  try {
    let c = await IDB.get(id);
    if (!c || c.v !== v){
      if (!session || !navigator.onLine) return;
      const d = await api("/copertine/" + docId(id));
      const img = d && d.fields && d.fields.img && d.fields.img.stringValue;
      const rv = d && d.fields && d.fields.v && Number(d.fields.v.integerValue);
      if (!img) return;
      c = { v: rv || v, img }; IDB.put(id, c);
    }
    covers.set(id, c);
    clearTimeout(coverRenderT); coverRenderT = setTimeout(render, 60);
  } catch {} finally { coverLoading.delete(key); }
}

/* ---------------- dati + coda offline ---------------- */
let items = new Map(Object.entries(LS.get("cj_items", {})).map(([id, d]) => [id, Object.assign({ id }, d)]));
let outbox = LS.get("cj_outbox", []);
let lastSync = LS.get("cj_lastsync", null);
let syncState = "busy", syncErr = "";

function persist(){
  const o = {}; for (const [id, it] of items){ const d = Object.assign({}, it); delete d.id; o[id] = d; }
  LS.set("cj_items", o); LS.set("cj_outbox", outbox);
}
function applyOp(op){
  if (op.op === "upsert") items.set(op.id, Object.assign({ id: op.id }, op.data));
  else if (op.op === "delete") items.delete(op.id);
}
function queue(op){
  // una sola operazione in coda per ogni scheda (le copertine hanno la loro coda)
  outbox = outbox.filter(o => !(o.id === op.id && (o.op === "cover" || o.op === "uncover") === (op.op === "cover" || op.op === "uncover")));
  outbox.push(op);
}
function saveItem(id, data){
  const d = structuredClone(data); delete d.id;
  const op = { op: "upsert", id, data: d };
  queue(op); applyOp(op); persist(); render(); flush();
}
function deleteItem(id){
  const hadCover = items.get(id) && items.get(id).coverV;
  const op = { op: "delete", id };
  queue(op); applyOp(op);
  if (hadCover){ queue({ op: "uncover", id }); covers.delete(id); IDB.del(id); }
  persist(); render(); flush();
}
const docName = (coll, id) => `projects/${CFG.projectId}/databases/(default)/documents/${coll}/${id}`;
function itemWrite(op){
  const fields = op.op === "delete"
    ? { data: { stringValue: "{}" }, eliminato: { booleanValue: true } }
    : { data: { stringValue: JSON.stringify(op.data) } };
  // "aggiornato" viene scritto dall'orologio di Google: serve a scaricare solo le novità
  return { update: { name: docName("items", op.id), fields }, updateTransforms: [{ fieldPath: "aggiornato", setToServerValue: "REQUEST_TIME" }] };
}
let flushing = false;
async function flush(){
  if (flushing || !session || !CFG) return;
  flushing = true;
  try {
    while (outbox.length){
      const op = outbox[0];
      if (op.op === "upsert" || op.op === "delete"){
        // invia insieme fino a 200 modifiche consecutive delle schede (una sola richiesta)
        let n = 0; while (n < outbox.length && n < 200 && (outbox[n].op === "upsert" || outbox[n].op === "delete")) n++;
        await api(":commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ writes: outbox.slice(0, n).map(itemWrite) }) });
        outbox.splice(0, n); persist(); continue;
      } else if (op.op === "cover"){
        const c = await IDB.get(op.id);
        if (c && c.v === op.v) await api("/copertine/" + docId(op.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { img: { stringValue: c.img }, v: { integerValue: String(c.v) } } }) });
      } else if (op.op === "uncover"){
        await api("/copertine/" + docId(op.id), { method: "DELETE" });
      }
      outbox.shift(); persist();
    }
    setSync("ok");
  } catch (e) {
    if (e instanceof NetError) setSync("off");
    else if (!session || (e instanceof HttpError && e.status === 401)) { showLogin("Accesso scaduto: inserisci di nuovo la password."); }
    else if (e instanceof HttpError && e.status === 403) { setSync("err", "Firebase ha rifiutato la modifica: controlla le regole di Firestore (passo 4 della guida)."); }
    else { setSync("err", "Una modifica non è stata accettata (" + (e.message || "errore") + ")."); outbox.shift(); persist(); }
  } finally { flushing = false; }
}
async function listAll(coll){
  const out = []; let tok = "";
  do {
    const j = await api(`/${coll}?pageSize=300${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}`);
    for (const d of (j && j.documents) || []) out.push(d);
    tok = j && j.nextPageToken;
  } while (tok);
  return out;
}
async function seedIfEmpty(){
  // Al primo accesso carica i 13 pezzi del file FUMETTI.xlsx, una volta sola per database.
  try { await api("/meta/import"); return false; } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
  let seed = null;
  try { seed = await (await fetch("seed.json", { cache: "no-store" })).json(); } catch { return false; }
  for (const [id, d] of Object.entries(seed)) queue({ op: "upsert", id, data: d });
  await flush();
  if (outbox.length) return false;
  await api("/meta/import", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { quando: { timestampValue: new Date().toISOString() } } }) });
  return true;
}
let cursor = LS.get("cj_cursor", null);   // momento (orologio di Google) dell'ultima novità scaricata
function readDoc(d){
  const id = decodeURIComponent(d.name.split("/").pop());
  const f = d.fields || {};
  const ts = f.aggiornato && f.aggiornato.timestampValue;
  if (ts && (!cursor || Date.parse(ts) > Date.parse(cursor))) cursor = ts;
  if (f.eliminato && f.eliminato.booleanValue) return { id, deleted: true };
  try { return { id, data: Object.assign({ id }, JSON.parse(f.data.stringValue)) }; } catch { return null; }
}
async function changesSince(ts){
  const out = await api(":runQuery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: "items" }],
    where: { fieldFilter: { field: { fieldPath: "aggiornato" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: ts } } }
  } }) });
  return (out || []).filter(r => r.document).map(r => r.document);
}
async function pull(){
  if (!session || !CFG) return;
  setSync("busy");
  try {
    await flush();
    if (!cursor){
      // primo avvio su questo dispositivo: scarico tutto una volta
      let docs = await listAll("items");
      if (!docs.length && await seedIfEmpty()) docs = await listAll("items");
      const next = new Map();
      for (const d of docs){ const r = readDoc(d); if (r && r.data) next.set(r.id, r.data); }
      items = next;
    } else {
      // dopo: scarico solo le schede cambiate (1 lettura se non è cambiato niente)
      for (const d of await changesSince(cursor)){ const r = readDoc(d); if (!r) continue; if (r.deleted) items.delete(r.id); else items.set(r.id, r.data); }
    }
    for (const op of outbox) applyOp(op);
    LS.set("cj_cursor", cursor);
    lastSync = Date.now(); LS.set("cj_lastsync", lastSync);
    persist(); setSync(outbox.length ? "off" : "ok"); render();
  } catch (e) {
    if (e instanceof NetError) setSync("off");
    else if (!session || (e instanceof HttpError && e.status === 401)) { showLogin("Accesso scaduto: inserisci di nuovo la password."); }
    else if (e instanceof HttpError && e.status === 403) setSync("err", "Firebase non ti lascia leggere i dati: controlla le regole di Firestore (passo 4 della guida).");
    else if (e instanceof HttpError && e.status === 404) setSync("err", "Database Firestore non trovato: crealo dalla console Firebase (passo 3 della guida).");
    else setSync("err", "Non riesco a leggere i dati (" + (e.message || "errore") + ").");
  }
}
function setSync(state, msg = ""){
  syncState = state; syncErr = msg;
  const dot = $("#dot"), m = $("#syncmsg"); if (!dot) return;
  dot.className = "dot " + (state === "ok" ? "" : state === "off" ? "off" : state === "err" ? "err" : "busy");
  const t = lastSync ? new Date(lastSync).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "mai";
  m.textContent = state === "ok" ? "Sincronizzato alle " + t
    : state === "off" ? "Offline" + (outbox.length ? " · " + outbox.length + " modifiche in attesa" : " · ultima sincronizzazione " + t)
    : state === "err" ? msg : "Sincronizzazione…";
}

/* ---------------- copertine (compresse e salvate in Firestore) ---------------- */
async function compress(file){
  const img = await createImageBitmap(file);
  let max = 900, q = 0.82, out = "";
  for (let i = 0; i < 6; i++){
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    out = cv.toDataURL("image/jpeg", q);
    if (out.length < 280000) break;      // ~200 KB: ben sotto il limite di 1 MB per documento
    max = Math.round(max * 0.85); q = Math.max(0.6, q - 0.06);
  }
  return out;
}
async function uploadCover(id, file){
  let img;
  try { img = await compress(file); } catch { toast("Non riesco a leggere questa immagine: prova con un JPG o PNG."); return; }
  const v = Date.now();
  const c = { v, img }; covers.set(id, c); await IDB.put(id, c);
  queue({ op: "cover", id, v });
  const next = structuredClone(items.get(id)); next.coverV = v; delete next.id;
  saveItem(id, next);
  toast(navigator.onLine ? "Copertina salvata." : "Copertina salvata: verrà inviata quando torni online.");
}
function removeCover(id){
  const cur = items.get(id); if (!cur || !cur.coverV) return;
  covers.delete(id); IDB.del(id); queue({ op: "uncover", id });
  const next = structuredClone(cur); delete next.coverV; delete next.id; saveItem(id, next);
  toast("Copertina tolta.");
}

/* ---------------- schermate di accesso ---------------- */
function showSetup(){
  $("#app").hidden = true;
  $("#gate").innerHTML = `<div class="gate"><form class="box" id="setup" novalidate>
    <h2>Collega Firebase</h2>
    <p>Incolla i due valori della tua app web Firebase (Impostazioni progetto → Generali → Le tue app). Puoi anche scriverli una volta per tutte nel file <b>config.js</b>.</p>
    <label class="f">apiKey<input id="s-key" type="text" placeholder="AIza…" autocomplete="off" required></label>
    <label class="f">projectId<input id="s-pid" type="text" placeholder="collezione-jump-1234" autocomplete="off" required></label>
    <div class="err" id="s-err"></div>
    <button class="btn primary" type="submit">Salva</button></form></div>`;
  $("#setup").onsubmit = e => {
    e.preventDefault();
    const apiKey = $("#s-key").value.trim().replace(/^["']|["',]+$/g, ""), projectId = $("#s-pid").value.trim().replace(/^["']|["',]+$/g, "");
    if (apiKey.length < 20 || !/^[a-z0-9-]+$/.test(projectId)) { $("#s-err").textContent = "Controlla i due valori: apiKey inizia di solito con AIza, projectId ha solo lettere minuscole, numeri e trattini."; return; }
    CFG = { apiKey, projectId }; LS.set("cj_cfg", CFG); start();
  };
}
function showLogin(msg = ""){
  $("#app").hidden = true;
  $("#gate").innerHTML = `<div class="gate"><form class="box" id="login" novalidate>
    <h2>Accedi</h2>
    <p>Usa l'email e la password dell'utente creato in Firebase (Authentication → Users).</p>
    <label class="f">Email<input id="l-mail" type="email" autocomplete="username" required value="${esc(session && session.email || LS.get("cj_mail", ""))}"></label>
    <label class="f">Password<input id="l-pw" type="password" autocomplete="current-password" required></label>
    <div class="err" id="l-err">${esc(msg)}</div>
    <button class="btn primary" type="submit" id="l-go">Entra</button>
    ${CFG && CFG.fromFile ? "" : '<button class="btn ghost small" type="button" id="l-cfg">Cambia progetto Firebase</button>'}</form></div>`;
  const cfgBtn = $("#l-cfg"); if (cfgBtn) cfgBtn.onclick = () => { LS.del("cj_cfg"); CFG = getCfg(); if (!CFG) showSetup(); };
  $("#login").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#l-go"); btn.disabled = true; $("#l-err").textContent = "";
    try { await login($("#l-mail").value.trim(), $("#l-pw").value); LS.set("cj_mail", $("#l-mail").value.trim()); start(); }
    catch (err) {
      const m = String(err && err.message || "");
      $("#l-err").textContent = err instanceof NetError ? "Nessuna connessione a internet."
        : /API_KEY|API key/i.test(m) ? "La apiKey in config.js non è valida."
        : /OPERATION_NOT_ALLOWED|CONFIGURATION_NOT_FOUND/.test(m) ? "In Firebase non è attivo l'accesso con Email/Password (passo 2 della guida)."
        : /TOO_MANY_ATTEMPTS/.test(m) ? "Troppi tentativi: riprova tra qualche minuto."
        : "Email o password non corrette.";
    }
    finally { btn.disabled = false; }
  };
  setTimeout(() => ($("#l-mail").value ? $("#l-pw") : $("#l-mail")).focus(), 50);
}
function showApp(){ $("#gate").innerHTML = ""; $("#app").hidden = false; render(); setSync(syncState, syncErr); }

/* ---------------- UI ---------------- */
let filter = "Tutti", query = "", view = "grid", openId = null, editing = false;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2800); }
function kind(it){ const t = (it.testata || "").toLowerCase(); if (t.includes("v jump")) return "vj"; if (t.includes("jump")) return "wsj"; return "vol"; }
function sortKey(it){ return [it.tipo === "serie" ? 1 : it.tipo === "volume" ? 2 : 0, (it.testata || "").toLowerCase(), -(it.anno || 0), -(parseInt(it.mese || it.numero) || 0), (it.titolo || "").toLowerCase()]; }
function cmp(a, b){ const A = sortKey(a), B = sortKey(b); for (let i = 0; i < A.length; i++){ if (A[i] < B[i]) return -1; if (A[i] > B[i]) return 1; } return 0; }
function cards(it){ return (it.allegati || []).filter(a => a.tipo === "carta"); }
function groupKey(it){ return it.tipo === "serie" ? "Serie" : it.tipo === "volume" ? (it.editore || "Volumi") : (it.testata || "Altro"); }

/* ---------------- serie (tutti i volumi di un'edizione in una sola scheda) ---------------- */
const VOL_STATI = { ho: "Ce l'ho", manca: "Manca", desiderato: "Desiderato" };
const STAMPE = { "": "non indicata", prima: "Prima stampa", ristampa: "Ristampa" };
const STATI_SERIE = { completa: "Completa", "in corso": "In corso", interrotta: "Interrotta" };
const isSerie = it => it && it.tipo === "serie";
function volOf(it, n){ return (it.volumi && it.volumi[n]) || {}; }
function volStato(it, n){ return volOf(it, n).s || "manca"; }
function serieTot(it){ return Math.max(0, parseInt(it.totale) || 0); }
function volsWith(it, st){ const o = []; for (let n = 1; n <= serieTot(it); n++) if (volStato(it, n) === st) o.push(n); return o; }
function serieCount(it){ const ho = volsWith(it, "ho").length, des = volsWith(it, "desiderato").length, tot = serieTot(it); return { tot, ho, des, manca: tot - ho - des }; }
function parseRange(txt){
  const out = new Set();
  String(txt || "").split(/[,;\s]+/).forEach(p => {
    const m = p.match(/^(\d+)(?:[-–](\d+))?$/); if (!m) return;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= b && i <= 3000; i++) out.add(i);
  });
  return [...out].sort((x, y) => x - y);
}
function fmtRange(nums){
  nums = [...nums].sort((a, b) => a - b); const r = [];
  for (let i = 0; i < nums.length;){ let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; r.push(i === j ? String(nums[i]) : nums[i] + "-" + nums[j]); i = j + 1; }
  return r.join(", ");
}
function setVol(it, n, patch){
  const vols = Object.assign({}, it.volumi || {});
  const v = Object.assign({}, vols[n] || {}, patch); if (!v.s) v.s = "manca";
  if (!v.st) delete v.st;
  if (v.s === "manca" && !v.st) delete vols[n]; else vols[n] = v;
  it.volumi = vols;
}
// tanti tocchi sui volumi = una sola scrittura (dopo 1,2 secondi di pausa)
const soonT = new Map();
function saveItemSoon(id, data){
  const d = structuredClone(data); delete d.id;
  items.set(id, Object.assign({ id }, d)); persist(); render();
  clearTimeout(soonT.get(id));
  soonT.set(id, setTimeout(() => { soonT.delete(id); saveItem(id, items.get(id)); }, 1200));
}
function flushSoon(){ for (const [id, t] of soonT){ clearTimeout(t); soonT.delete(id); saveItem(id, items.get(id)); } }
function fmtDate(s){ if (!s) return ""; const [y, m, d] = s.split("-"); return d ? `${+d} ${MESI[+m - 1]} ${y}` : s; }

function renderStats(){
  const all = [...items.values()], own = all.filter(i => i.stato !== "desiderato"), c = all.flatMap(cards);
  $("#st-items").textContent = own.length;
  $("#st-vj").textContent = own.filter(i => kind(i) === "vj").length;
  $("#st-cards").textContent = c.length;
  $("#st-check").textContent = c.filter(a => a.ho).length + "/" + c.length;
  const serie = all.filter(isSerie);
  $("#st-serie").textContent = serie.reduce((t, i) => t + serieCount(i).ho, 0);
  $("#st-wish").textContent = all.filter(i => i.stato === "desiderato").length + serie.reduce((t, i) => t + serieCount(i).des, 0);
}
function renderTabs(){
  const g = new Map([["Tutti", items.size]]);
  for (const it of items.values()) g.set(groupKey(it), (g.get(groupKey(it)) || 0) + 1);
  const w = [...items.values()].filter(wanted).length; if (w) g.set("Desiderati", w);
  if (!g.has(filter)) filter = "Tutti";
  const el = $("#tabs"); el.innerHTML = "";
  for (const [k, n] of g){
    const b = document.createElement("button"); b.type = "button"; b.className = "tab"; b.setAttribute("aria-pressed", String(k === filter));
    b.innerHTML = esc(k) + '<span class="n">' + n + "</span>"; b.onclick = () => { filter = k; render(); }; el.appendChild(b);
  }
}
function wanted(it){ return it.stato === "desiderato" || (isSerie(it) && serieCount(it).des > 0); }
function matches(it){
  if (filter === "Desiderati" && !wanted(it)) return false;
  if (filter !== "Tutti" && filter !== "Desiderati" && groupKey(it) !== filter) return false;
  if (!query) return true;
  const hay = [it.titolo, it.titoloOriginale, it.testata, it.editore, it.collana, it.autori, it.copertina, it.note, it.anno, it.numero, it.anni, isSerie(it) ? "serie" : "",
    ...(it.fumetti || []).flatMap(f => [f.titolo, f.autori]), ...(it.allegati || []).flatMap(a => [a.gioco, a.nome, a.codice])].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function placeholder(it){
  if (isSerie(it)){
    const c = serieCount(it);
    return `<div class="ph serie"><div><div class="t">${esc(it.testata || it.titolo || "")}</div><div class="y">${esc(it.editore || "")}${it.anni ? " · " + esc(it.anni) : ""}</div></div><div class="num">${c.tot ? c.ho + "<small>/" + c.tot + "</small>" : "?"}</div><div class="hint">+ foto della serie</div></div>`;
  }
  const k = kind(it);
  const t = k === "vj" ? "V JUMP" : k === "wsj" ? "SHŌNEN<br>JUMP" : esc(it.testata || it.editore || "");
  const num = it.tipo === "volume" ? "" : esc(it.numero || "");
  const y = it.tipo === "volume" ? esc(it.collana || it.editore || "") : (it.anno ? (it.mese ? MESI[it.mese - 1] + " " : "") + it.anno : "");
  return `<div class="ph ${k}"><div><div class="t">${t}</div><div class="y">${y}</div></div>${num ? `<div class="num">${num}</div>` : ""}<div class="hint">+ copertina</div></div>`;
}
function coverHtml(it){
  const u = coverSrc(it);
  return u ? `<img src="${u}" alt="Copertina di ${esc(it.titolo)}">` : placeholder(it);
}
function renderGrid(){
  const list = [...items.values()].filter(matches).sort(cmp);
  if (!list.length) return `<p class="empty">${items.size ? "Nessun risultato per questa ricerca." : "La collezione è vuota: premi «+ Aggiungi» per inserire il primo pezzo."}</p>`;
  return '<div class="grid">' + list.map(it => {
    const c = cards(it); const sc = isSerie(it) ? serieCount(it) : null;
    const sub = sc ? (sc.tot ? `${sc.ho} di ${sc.tot} volumi` + (sc.des ? ` · ${sc.des} desiderati` : "") : "numero di volumi da indicare") : it.tipo === "volume" ? (it.autori || it.collana || "") : (it.dataUscita ? "uscito il " + fmtDate(it.dataUscita) : "");
    return `<button class="item" type="button" data-id="${esc(it.id)}">
      <div class="cover">${coverHtml(it)}${sc && it.coverV ? `<span class="badge">SERIE ${sc.tot ? sc.ho + "/" + sc.tot : ""}</span>` : ""}${c.length ? `<span class="badge">${c.length} carte</span>` : ""}${it.stato === "desiderato" ? '<span class="badge wish">desiderato</span>' : it.stato === "arrivo" ? '<span class="badge wish">in arrivo</span>' : ""}</div>
      <div class="meta"><span class="k">${esc(it.tipo === "volume" || sc ? (it.editore || "") : it.testata)}</span><span class="n">${esc(it.titolo)}</span><span class="s">${esc(sub)}</span>${sc && sc.tot ? `<span class="bar"><span style="width:${Math.round(sc.ho / sc.tot * 100)}%"></span></span>` : ""}</div>
    </button>`; }).join("") + "</div>";
}
function renderYears(){
  const vj = [...items.values()].filter(i => kind(i) === "vj" && i.anno);
  const yNow = new Date().getFullYear() + 1;
  const ys = vj.map(i => i.anno); const min = Math.min(...ys, yNow - 2), max = Math.max(...ys, yNow);
  let h = '<div class="years">';
  for (let y = max; y >= min; y--){
    const inY = vj.filter(i => i.anno === y);
    h += `<div class="year"><h3>${y}<small>${inY.filter(i => i.stato !== "desiderato").length} di 12</small></h3><div class="months">`;
    for (let m = 1; m <= 12; m++){
      const it = inY.find(i => (parseInt(i.mese) || parseInt(i.numero)) === m);
      if (it){ const cls = it.stato === "desiderato" || it.stato === "arrivo" ? "wish" : "have"; const u = coverSrc(it);
        h += `<button type="button" class="m ${cls}" data-id="${esc(it.id)}" aria-label="V Jump ${MESI[m - 1]} ${y}">${u ? `<img src="${u}" alt="">` : ""}<span>${MESI[m - 1]}</span></button>`;
      } else h += `<button type="button" class="m" data-new="${y}-${m}" aria-label="Aggiungi V Jump ${MESI[m - 1]} ${y}"><span>${MESI[m - 1]}</span></button>`;
    }
    h += "</div></div>";
  }
  return h + '</div><p class="foot">Le caselle tratteggiate sono i numeri che ti mancano: toccale per aggiungerli ai desiderati.</p>';
}
function render(){
  if ($("#app").hidden) return;
  renderStats(); renderTabs();
  document.querySelectorAll(".views button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $("#viewtitle").textContent = view === "years" ? "Annate V Jump" : (filter === "Tutti" ? "Tutta la collezione" : filter);
  $("#content").innerHTML = view === "years" ? renderYears() : renderGrid();
  if (openId && !editing) renderDetail();
}

/* ---------------- scheda ---------------- */
function openSheet(id){ openId = id; editing = false; $("#scrim").classList.add("open"); $("#sheet").classList.add("open"); renderDetail(); }
function closeSheet(){ flushSoon(); openId = null; editing = false; $("#scrim").classList.remove("open"); $("#sheet").classList.remove("open"); }
function sheetOpen(){ return $("#sheet").classList.contains("open"); }
function renderDetail(){
  const it = items.get(openId); if (!it){ closeSheet(); return; }
  $("#sheet-title").textContent = isSerie(it) ? "Serie" : it.tipo === "volume" ? (it.editore || "") : it.testata; $("#edit").hidden = false;
  const c = cards(it); const sc = isSerie(it) ? serieCount(it) : null;
  const facts = sc ? [
    it.editore ? ["Editore", esc(it.editore)] : null,
    it.collana ? ["Edizione / collana", esc(it.collana)] : null,
    it.anni ? ["Anni", esc(it.anni)] : null,
    it.autori ? ["Autori", esc(it.autori)] : null,
    it.statoSerie ? ["Stato della serie", esc(STATI_SERIE[it.statoSerie] || it.statoSerie)] : null,
    ["Volumi", sc.tot ? `<b>${sc.ho}</b> di ${sc.tot}` + (sc.des ? ` · ${sc.des} desiderati` : "") : "da indicare (premi Modifica)"],
    it.condizione ? ["Condizioni", esc(it.condizione)] : null,
  ].filter(Boolean) : [
    ["Stato", `<span class="pill ${esc(it.stato || "posseduto")}">${STATI[it.stato] || "Posseduto"}</span>`],
    it.tipo !== "volume" && it.numero ? ["Numero", esc(it.numero) + (it.anno ? " / " + it.anno : "")] : null,
    it.dataUscita ? ["Uscita in Giappone", fmtDate(it.dataUscita)] : null,
    it.prezzo ? ["Prezzo di copertina", esc(it.prezzo)] : null,
    it.collana ? ["Collana", esc(it.collana)] : null,
    it.autori ? ["Autori", esc(it.autori)] : null,
    it.copertina ? ["In copertina", esc(it.copertina)] : null,
    it.condizione ? ["Condizioni", esc(it.condizione)] : null,
  ].filter(Boolean);
  const search = encodeURIComponent((it.titoloOriginale || it.titolo) + (it.tipo === "volume" ? " copertina" : " 表紙"));
  let h = `<div class="hero"><div><div class="cover">${coverHtml(it)}</div>
    <div class="cover-actions"><button class="btn small" type="button" id="up">${it.coverV ? "Cambia" : "Carica"} foto</button>${it.coverV ? '<button class="btn ghost small" type="button" id="rm">Togli</button>' : ""}</div>
    <div class="cover-actions"><a class="btn ghost small" href="https://www.google.com/search?tbm=isch&q=${search}" target="_blank" rel="noopener">Trova copertina</a></div></div>
    <div><h2>${esc(it.titolo)}</h2>${it.titoloOriginale ? `<div class="jp" lang="ja">${esc(it.titoloOriginale)}</div>` : ""}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div></div>`;
  if (sc) h += serieSection(it, sc);
  const al = it.allegati || [];
  if (al.length){
    h += `<section class="blk"><h3>Allegati e carte promo <small>${c.filter(a => a.ho).length}/${c.length} carte spuntate</small></h3><ul class="list">` +
      al.map((a, i) => `<li><input class="chk" type="checkbox" id="al-${i}" data-al="${i}" ${a.ho ? "checked" : ""} aria-label="Ce l'ho: ${esc(a.nome)}">
        <label class="main" for="al-${i}"><b>${esc(a.nome)}</b><small>${esc(a.gioco)}${a.codice ? " · " + esc(a.codice) : ""}</small></label>
        <span class="tag ${esc(a.tipo)}">${esc(TIPI_ALL[a.tipo] || a.tipo)}</span></li>`).join("") +
      `</ul><p style="font-size:12px;color:var(--muted);margin:6px 0 0">Spunta quello che hai davvero nella tua copia.</p></section>`;
  }
  const fu = it.fumetti || [];
  if (fu.length) h += `<section class="blk"><h3>Fumetti pubblicati <small>${fu.length}</small></h3><ul class="list">` +
    fu.map(f => `<li><div class="main"><b>${esc(f.titolo)}</b><small>${esc(f.autori)}</small></div>${f.verificato === false ? '<span class="unv">da verificare</span>' : ""}</li>`).join("") + "</ul></section>";
  if (it.note) h += `<section class="blk"><h3>Note</h3><div class="note">${esc(it.note)}</div></section>`;
  if ((it.fonti || []).length) h += `<section class="blk"><h3>Fonti</h3><div class="src">${it.fonti.map(f => { const i = f.lastIndexOf(" | "); const u = i >= 0 ? f.slice(i + 3) : f; const label = i >= 0 ? f.slice(0, i) : u.replace(/^https?:\/\//, ""); return /^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span>${esc(f)}</span>`; }).join("")}</div></section>`;
  const body = $("#sheet-body"); const keep = body.dataset.for === openId ? body.scrollTop : 0;
  body.innerHTML = h; body.dataset.for = openId; body.scrollTop = keep;
  $("#up").onclick = () => { $("#file").dataset.target = it.id; $("#file").click(); };
  const rm = $("#rm"); if (rm) rm.onclick = () => removeCover(it.id);
  if (sc) bindSerie(it);
  document.querySelectorAll("[data-al]").forEach(cb => cb.onchange = () => {
    const next = structuredClone(items.get(it.id)); next.allegati[+cb.dataset.al].ho = cb.checked; saveItem(it.id, next);
  });
}

let volMode = "stato";   // cosa fa il tocco su un volume: "stato" o "stampa"
function serieSection(it, sc){
  if (!sc.tot) return `<section class="blk"><h3>Volumi</h3><div class="aibox warn">Indica quanti volumi ha la serie: premi <b>Modifica</b> e compila «Volumi totali».</div></section>`;
  const cell = n => {
    const v = volOf(it, n), st = v.s || "manca";
    const mark = v.st === "prima" ? '<i title="Prima stampa">1ª</i>' : v.st === "ristampa" ? '<i title="Ristampa">R</i>' : "";
    return `<button type="button" class="vol ${st}" data-vol="${n}" aria-label="Volume ${n}: ${VOL_STATI[st]}${v.st ? ", " + STAMPE[v.st] : ""}">${n}${mark}</button>`;
  };
  let cells = ""; for (let n = 1; n <= sc.tot; n++) cells += cell(n);
  const manc = volsWith(it, "manca"), des = volsWith(it, "desiderato");
  return `<section class="blk"><h3>Volumi <small>${sc.ho} di ${sc.tot} · ${Math.round(sc.ho / sc.tot * 100)}%</small></h3>
    <span class="bar big"><span style="width:${Math.round(sc.ho / sc.tot * 100)}%"></span></span>
    <div class="voltools"><span class="hint-p">Toccando un numero:</span>
      <button type="button" class="tab" data-vm="stato" aria-pressed="${volMode === "stato"}">cambio stato</button>
      <button type="button" class="tab" data-vm="stampa" aria-pressed="${volMode === "stampa"}">prima stampa / ristampa</button></div>
    <div class="vols">${cells}</div>
    <p class="hint-p legend"><span class="sw ho"></span>ce l'ho <span class="sw desiderato"></span>desiderato <span class="sw manca"></span>manca · <b>1ª</b> prima stampa · <b>R</b> ristampa</p>
    <form id="vol-bulk" class="ai-row" novalidate>
      <label class="f">Segna come<select id="vb-s">${Object.entries(VOL_STATI).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <label class="f">i volumi<input id="vb-r" inputmode="numeric" placeholder="es. 1-40, 42, 45-62"></label>
      <button class="btn small" type="submit">Applica</button>
    </form>
    <div class="miss"><p class="hint-p"><b>Mancanti (${manc.length}):</b> ${manc.length ? esc(fmtRange(manc)) : "nessuno 🎉"}${des.length ? ` · <b>Desiderati:</b> ${esc(fmtRange(des))}` : ""}</p>
    ${manc.length || des.length ? '<button class="btn ghost small" type="button" id="copy-miss">Copia elenco mancanti</button>' : ""}</div>
  </section>`;
}
function bindSerie(it){
  document.querySelectorAll("[data-vm]").forEach(b => b.onclick = () => { volMode = b.dataset.vm; renderDetail(); });
  document.querySelectorAll("[data-vol]").forEach(b => b.onclick = () => {
    const cur = structuredClone(items.get(it.id)); const n = +b.dataset.vol; const v = volOf(cur, n);
    if (volMode === "stampa"){ const nx = { "": "prima", prima: "ristampa", ristampa: "" }[v.st || ""]; setVol(cur, n, { st: nx, s: v.s || "ho" }); }
    else { const nx = { manca: "ho", ho: "desiderato", desiderato: "manca" }[v.s || "manca"]; setVol(cur, n, { s: nx }); }
    saveItemSoon(it.id, cur);
  });
  const f = $("#vol-bulk"); if (f) f.onsubmit = e => {
    e.preventDefault();
    const nums = parseRange($("#vb-r").value).filter(n => n <= serieTot(it));
    if (!nums.length){ toast("Scrivi i numeri, per esempio 1-40, 42."); return; }
    const cur = structuredClone(items.get(it.id)); const st = $("#vb-s").value;
    nums.forEach(n => setVol(cur, n, { s: st }));
    saveItemSoon(it.id, cur); toast(`${nums.length} volumi segnati come «${VOL_STATI[st]}».`);
  };
  const cp = $("#copy-miss"); if (cp) cp.onclick = async () => {
    const t = `${it.titolo}${it.editore && !String(it.titolo).includes(it.editore) ? " (" + it.editore + ")" : ""}\nMi mancano: ${fmtRange(volsWith(it, "manca")) || "nessuno"}` + (volsWith(it, "desiderato").length ? `\nCerco in particolare: ${fmtRange(volsWith(it, "desiderato"))}` : "");
    try { await navigator.clipboard.writeText(t); toast("Elenco copiato: incollalo dove vuoi."); } catch { toast("Non riesco a copiare: " + t.replace(/\n/g, " · ")); }
  };
}

/* ---------------- intelligenza artificiale (Gemini, piano gratuito) ---------------- */
// La chiave Gemini è salvata nel tuo database (meta/ai), protetta dalle regole: la imposti una volta e vale su tutti i dispositivi.
// Modelli: li chiedo a Google (cambiano spesso); se non riesco uso questo elenco di riserva.
const AI_FALLBACK_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
let aiKey = LS.get("cj_aikey", null);
async function loadAiKey(){
  try { const d = await api("/meta/ai"); aiKey = (d && d.fields && d.fields.key && d.fields.key.stringValue) || null; }
  catch (e) { if (e instanceof HttpError && e.status === 404) aiKey = null; else return; }
  if (aiKey) LS.set("cj_aikey", aiKey); else LS.del("cj_aikey");
}
async function saveAiKey(k){
  if (k) await api("/meta/ai", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { key: { stringValue: k } } }) });
  else await api("/meta/ai", { method: "DELETE" });
  aiKey = k || null; if (aiKey) LS.set("cj_aikey", aiKey); else LS.del("cj_aikey");
  LS.del("cj_aimodels"); LS.del("cj_aiok"); LS.del("cj_skipsearch");
}
class AiError extends Error {}
async function aiModels(key){
  const cache = LS.get("cj_aimodels", null);
  if (cache && cache.k === key.slice(-6) && Date.now() - cache.at < 86400000 && cache.list.length) return cache.list;
  let list = [];
  try {
    const res = await fetch(`${EP.ai}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
    if (res.ok){
      const j = await res.json();
      const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
      const score = n => {
        const m = n.match(/^gemini-(\d+(?:\.\d+)?)-(flash(?:-lite)?)$/); if (!m) return -1;
        return parseFloat(m[1]) * 10 + (m[2] === "flash" ? 1 : 0);      // più recente prima; a parità, flash prima di flash-lite
      };
      list = ok.filter(n => score(n) >= 0).sort((a, b) => score(b) - score(a));
      const best = list.filter(n => /-flash$/.test(n)).slice(0, 2).concat(list.filter(n => /-flash-lite$/.test(n)).slice(0, 2)).sort((a, b) => score(b) - score(a));
      list = [...new Set(best.concat(ok.filter(n => /^gemini-flash(-lite)?-latest$/.test(n))))];
    }
  } catch {}
  if (!list.length) list = AI_FALLBACK_MODELS;
  LS.set("cj_aimodels", { k: key.slice(-6), at: Date.now(), list });
  return list;
}
/* Prova, nell'ordine: ricerca Google → lettura di pagine scelte → solo conoscenze del modello.
   build(mode) restituisce le "parts" della richiesta per quel modo. */
async function gemini(build, { modes = ["search", "url", "none"], key = aiKey } = {}){
  if (!key) throw new AiError("nokey");
  if (!navigator.onLine) throw new AiError("Serve la connessione a internet.");
  let models = (await aiModels(key)).slice(0, 4);
  const okModel = LS.get("cj_aiok", null);                  // il modello che ha funzionato l'ultima volta va per primo
  if (okModel && models.includes(okModel)) models = [okModel].concat(models.filter(m => m !== okModel));
  const skip = LS.get("cj_skipsearch", 0);                   // se la ricerca Google non è concessa alla chiave, non la riprovo per un giorno
  if (Date.now() - skip < 86400000) modes = modes.filter(m => m !== "search" || modes.length === 1);
  let last = null, quota = false, tries = 0;
  for (const mode of modes){
    for (const model of models){
      const parts = build(mode); if (!parts) break;         // es. nessuna pagina da leggere: passo al modo successivo
      if (++tries > 9) break;
      const tools = mode === "search" ? [{ google_search: {} }] : mode === "url" ? [{ url_context: {} }] : undefined;
      let res;
      try {
        res = await fetch(`${EP.ai}/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts }], tools, generationConfig: { temperature: 0.2 } })
        });
      } catch { throw new AiError("Nessuna connessione con Gemini."); }
      if (res.ok){
        const j = await res.json();
        const cand = (j.candidates || [])[0] || {};
        const text = ((cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
        if (!text.trim()){ last = { status: 200, msg: "risposta vuota" }; continue; }
        const web = (((cand.groundingMetadata || {}).groundingChunks) || []).map(c => c.web).filter(Boolean)
          .map(w => (w.title ? w.title.replace(/\|/g, "/") + " | " : "") + w.uri);
        const um = cand.urlContextMetadata || cand.url_context_metadata || {};
        const urls = (um.urlMetadata || um.url_metadata || [])
          .filter(u => /SUCCESS/.test(u.urlRetrievalStatus || u.url_retrieval_status || "")).map(u => u.retrievedUrl || u.retrieved_url);
        LS.set("cj_aiok", model);
        return { text, fonti: web.concat(urls), model, mode };
      }
      let msg = ""; try { const e = await res.json(); msg = (e.error && (e.error.message || e.error.status)) || ""; } catch {}
      if (res.status === 400 && /API key|API_KEY/i.test(msg)) throw new AiError("La chiave Gemini non è valida: controllala in Impostazioni.");
      if (res.status === 404){                                // modello ritirato: lo tolgo dall'elenco
        const c = LS.get("cj_aimodels", null); if (c){ c.list = c.list.filter(m => m !== model); LS.set("cj_aimodels", c); }
        models = models.filter(m => m !== model); if (okModel === model) LS.del("cj_aiok");
        continue;
      }
      last = { status: res.status, msg };
      if (mode === "search"){ LS.set("cj_skipsearch", Date.now()); break; }   // ricerca non concessa: provo subito il modo successivo
      if (mode === "url" && res.status === 400) break;        // lettura pagine non supportata: modo successivo
      if (res.status === 429) quota = true;
    }
  }
  if (quota) throw new AiError("Hai esaurito le richieste gratuite di Gemini per oggi: riprova domani (si azzerano verso le 9 del mattino, ora italiana).");
  throw new AiError("Gemini non ha risposto (" + (last ? last.status + " " + String(last.msg).slice(0, 160) : "nessun modello disponibile per questa chiave") + "). Riprova tra poco.");
}
const AI_SCHEMA = `{
  "riconosciuto": true,
  "confidenza": "alta | media | bassa",
  "tipo": "rivista | volume | serie",
  "testata": "es. V Jump, Weekly Shonen Jump, One Piece, Batman",
  "editore": "es. Shueisha, Panini Comics, Star Comics",
  "collana": "es. DC Black Label, Planet Manga (vuoto per le riviste)",
  "anno": 2026,
  "mese": 3,
  "numero": "3",
  "titolo": "titolo completo in italiano nel formato degli esempi",
  "titoloOriginale": "titolo in lingua originale, es. Vジャンプ 2026年3月特大号",
  "dataUscita": "AAAA-MM-GG",
  "prezzo": "es. 680 ¥ oppure 5,90 €",
  "copertina": "chi o cosa c'è in copertina",
  "autori": "autori (soprattutto per i volumi)",
  "fumetti": [{ "titolo": "serie e capitolo/arco", "autori": "soggetto / disegni", "verificato": true }],
  "allegati": [{ "tipo": "carta | codice | libretto | adesivi | altro", "gioco": "es. Yu-Gi-Oh! OCG", "nome": "nome della carta o dell'allegato", "codice": "es. VJMP-JP281" }],
  "totale": "solo per tipo serie: numero totale di volumi dell'edizione, es. 42",
  "anni": "solo per tipo serie: anni di pubblicazione, es. 1995–1997",
  "statoSerie": "solo per tipo serie: completa | in corso | interrotta",
  "annoCerto": "true se l'anno è stampato o certo, false se l'hai dedotto",
  "anniPossibili": [2026, 2020],
  "dataCopertina": "data stampata in copertina, es. 5/28 (vuoto se non c'è)",
  "note": "dubbi, cose da verificare, differenze tra le fonti"
}`;
const MESI_IT = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
function guessYM(text){
  const t = String(text || "").toLowerCase();
  let y = (t.match(/(19|20)\d{2}/) || [])[0]; y = y ? parseInt(y) : null;
  let m = null;
  const jm = t.match(/年\s*(\d{1,2})\s*月/); if (jm) m = parseInt(jm[1]);
  if (!m) MESI_IT.forEach((n, i) => { if (t.includes(n) || t.includes(n.slice(0, 3) + " ")) m = m || i + 1; });
  if (!m) MONTHS_EN.forEach((n, i) => { if (t.includes(n.toLowerCase())) m = m || i + 1; });
  return { y, m };
}
function pagesFor(info){
  const t = (info.text || "").toLowerCase(); const u = [];
  if (/v ?jump|vジャンプ/.test(t)){
    u.push("https://www.fujisan.co.jp/product/2318/b/list/", "https://www.fujisan.co.jp/product/2318/b/list/?page=2&limit=45");
    if (info.y && info.m) u.push("https://yugipedia.com/wiki/V_Jump_" + MONTHS_EN[info.m - 1] + "_" + info.y + "_promotional_card");
  } else if (/jump|ジャンプ/.test(t)){
    u.push("https://www.jajanken.net/en/issues");
  }
  return u;
}
function aiPrompt(kind, query, mode, info = {}){
  const esempi = [...items.values()].filter(i => i.titolo).slice(0, 3).map(i => "- " + i.titolo).join("\n");
  const how = mode === "search" ? "usa la ricerca Google per trovare"
    : mode === "url" ? "leggi queste pagine (se una non si apre, ignorala) per trovare:\n" + pagesFor(info).join("\n") + "\nCerca nelle pagine il numero giusto e ricava"
    : "NON hai accesso a internet: usa solo quello che sai per indicare";
  const task = kind === "foto-id"
    ? "Nell'immagine c'è la copertina di un fumetto o di una rivista fotografata dal collezionista. Leggi con attenzione testata, numero, mese/anno o numero di volume stampati in copertina e riconosci la pubblicazione esatta. Elenca anche le carte promo e gli allegati annunciati in copertina (付録)."
    : `Il collezionista cerca: "${query}". Identifica esattamente quella pubblicazione e ${how} i dati del numero: data di uscita, prezzo, chi c'è in copertina, fumetti pubblicati, carte promo e allegati (付録), codici digitali.`;
  const oggi = new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  const fotoRegole = kind === "foto-id" ? `
- ATTENZIONE ALL'ANNO: le riviste settimanali giapponesi (Weekly Shōnen Jump, Champion, Magazine, Sunday…) di solito NON stampano l'anno in copertina, solo il numero (es. 24) e una data (es. 5/28). Se l'anno non è scritto chiaramente, NON indovinarlo: metti "annoCerto": false, in "anno" l'anno più probabile e in "anniPossibili" tutti gli anni compatibili con numero, data, prezzo e serie annunciate in copertina (fino a 4).
- Oggi è ${oggi}: la foto è spesso di un numero recente, anche più nuovo di quelli che conosci. Se in copertina vedi un nuovo arco o una nuova serie che non conosci, è probabilmente un numero uscito dopo le tue conoscenze: includi l'anno in corso tra gli anni possibili.
- Copia in "dataCopertina" la data stampata in copertina e in "prezzo" il prezzo stampato (es. 400円).
- Nel "titolo" metti l'anno solo se "annoCerto" è true.` : "";
  return `Sei un esperto di fumetti, manga e riviste giapponesi (V Jump, Weekly Shōnen Jump, Champion, Saikyō Jump...) e delle edizioni italiane (Panini, Star Comics, J-Pop, Planet Manga). Oggi è ${oggi}.
${task}

Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa struttura:
${AI_SCHEMA}

Regole:
- Scrivi in italiano (tranne titoloOriginale e i nomi originali delle carte, che puoi mettere tra parentesi).
- Per le riviste giapponesi "anno" e "mese" sono quelli del NUMERO (Vジャンプ 2026年3月号 → anno 2026, mese 3), non della data di uscita, che è circa due mesi prima.
- Titolo nel formato della collezione, per esempio:
${esempi || "- V Jump – Marzo 2026 (n. 3/2026, 特大号)\n- Weekly Shōnen Jump n. 34/2022 – Ritorno di One Piece (cap. 1054)\n- Batman: Anno Uno"}
- "verificato": false per i fumetti che non trovi confermati su quel numero preciso.
- Non inventare: se un dato non lo sai con sicurezza (soprattutto i nomi delle carte), lascia il campo vuoto e scrivilo in "note".${mode === "none" ? "\n- Senza internet i dettagli del numero sono incerti: usa \"confidenza\": \"bassa\" o \"media\"." : ""}
- Se il collezionista cerca un'intera serie o edizione (tutti i volumi), usa "tipo": "serie": indica editore, collana/edizione, anni, autori, "totale" (numero di volumi di QUELLA edizione italiana o originale) e "statoSerie"; lascia vuoti numero, mese, fumetti e allegati.
- Se riconosci un singolo volume di una serie (es. il n. 12 di un manga), usa "tipo": "volume", "testata" = nome della serie e "numero" = numero del volume.
- Se non riesci a capire di che pubblicazione si tratta: "riconosciuto": false e in "note" descrivi cosa vedi o cosa manca.${fotoRegole}`;
}
function parseAiJson(text){
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z < a) throw new AiError("Gemini ha risposto in un formato inatteso. Riprova.");
  try { return JSON.parse(t.slice(a, z + 1)); } catch { throw new AiError("Gemini ha risposto in un formato inatteso. Riprova."); }
}
const MODE_LABEL = { search: "ricerca Google", url: "pagine di Fujisan/Yugipedia", none: "solo conoscenze di Gemini, senza internet", foto: "lettura della copertina" };
function normalizeAi(r, fonti, mode){
  const s = v => (v === null || v === undefined) ? "" : String(v).trim();
  const n = v => { const x = parseInt(v); return isNaN(x) ? null : x; };
  const tipi = Object.keys(TIPI_ALL);
  let conf = s(r.confidenza).toLowerCase();
  if (mode === "none" && conf === "alta") conf = "media";
  return {
    riconosciuto: r.riconosciuto !== false, confidenza: conf, mode,
    tipo: ["volume", "serie"].includes(r.tipo) ? r.tipo : "rivista",
    totale: n(r.totale), anni: s(r.anni), statoSerie: Object.keys(STATI_SERIE).includes(s(r.statoSerie).toLowerCase()) ? s(r.statoSerie).toLowerCase() : "",
    testata: s(r.testata), editore: s(r.editore), collana: s(r.collana),
    anno: n(r.anno), mese: (n(r.mese) >= 1 && n(r.mese) <= 12) ? n(r.mese) : null, numero: s(r.numero),
    titolo: s(r.titolo), titoloOriginale: s(r.titoloOriginale),
    dataUscita: /^\d{4}-\d{2}-\d{2}$/.test(s(r.dataUscita)) ? s(r.dataUscita) : "",
    prezzo: s(r.prezzo), copertina: s(r.copertina), autori: s(r.autori), note: s(r.note),
    fumetti: (Array.isArray(r.fumetti) ? r.fumetti : []).map(f => ({ titolo: s(f && f.titolo), autori: s(f && f.autori), verificato: mode === "none" ? false : !!(f && f.verificato) })).filter(f => f.titolo),
    allegati: (Array.isArray(r.allegati) ? r.allegati : []).map(a => ({ tipo: tipi.includes(a && a.tipo) ? a.tipo : "altro", gioco: s(a && a.gioco), nome: s(a && a.nome), codice: s(a && a.codice), ho: false })).filter(a => a.nome || a.gioco),
    annoCerto: !(r.annoCerto === false || r.annoCerto === "false"),
    anniPossibili: [...new Set((Array.isArray(r.anniPossibili) ? r.anniPossibili : []).map(n).filter(y => y && y > 1900 && y < 2100))].slice(0, 4),
    dataCopertina: s(r.dataCopertina),
    fonti: [...new Set(fonti || [])].slice(0, 8)
  };
}
/* foto, passo 1: leggo la copertina (non serve internet) */
async function aiIdentify(imageDataUrl){
  const id = await gemini(() => [{ text: aiPrompt("foto-id", "", "none") }, { inlineData: { mimeType: "image/jpeg", data: imageDataUrl.split(",")[1] } }], { modes: ["none"] });
  return normalizeAi(parseAiJson(id.text), [], "foto");
}
/* cambio l'anno anche nei titoli (es. dopo che l'hai scelto tu) */
function setYear(a, y){
  const old = a.anno; a.anno = y; a.annoCerto = true;
  const fix = t => !t ? t : (old && String(t).includes(String(old)) ? String(t).split(String(old)).join(String(y)) : t);
  a.titolo = fix(a.titolo); a.titoloOriginale = fix(a.titoloOriginale);
  if (a.titolo && !a.titolo.includes(String(y)) && a.numero && a.tipo === "rivista") a.titolo = a.titolo.replace(new RegExp("n\\.\\s*" + a.numero + "(?!\\d|/)"), "n. " + a.numero + "/" + y);
  return a;
}
/* foto, passo 2: cerco i dettagli di quel numero; se non riesco tengo quello che c'è in copertina */
async function aiDetails(a){
    try {
      const q = [a.titoloOriginale, a.titolo, a.anno && ("anno " + a.anno), a.dataCopertina && ("data di copertina " + a.dataCopertina)].filter(Boolean).join(" / ");
      const b = await aiLookup({ query: q, hint: { y: a.anno, m: a.mese } });
      if (!b.riconosciuto) return a;
      const merged = Object.assign({}, b);
      for (const k of ["tipo","testata","editore","anno","mese","numero","titolo","titoloOriginale","copertina"]) if (a[k]) merged[k] = a[k];
      const names = new Set(b.allegati.map(x => x.nome.toLowerCase()));
      merged.allegati = b.allegati.concat(a.allegati.filter(x => !names.has(x.nome.toLowerCase())));
      merged.note = [a.note, b.note].filter(Boolean).join("\n");
      merged.confidenza = b.mode === "none" ? "bassa" : b.confidenza;
      if (a.prezzo && !b.prezzo) merged.prezzo = a.prezzo;
      return merged;
    } catch { return a; }
}
async function aiLookup({ query, imageDataUrl, hint = {} }){
  if (imageDataUrl){ const a = await aiIdentify(imageDataUrl); return (!a.riconosciuto || !a.titolo) ? a : aiDetails(a); }
  const g = guessYM(query); const info = { text: query, y: hint.y || g.y, m: hint.m || g.m };
  const res = await gemini(mode => mode === "url" && !pagesFor(info).length ? null : [{ text: aiPrompt("testo", query, mode, info) }]);
  return normalizeAi(parseAiJson(res.text), res.fonti, res.mode);
}
/* foto di un volume che appartiene a una serie già in collezione */
function findSerieFor(r){
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, "");
  const num = parseInt(r.numero); if (!num || r.tipo === "rivista") return null;
  const name = norm(r.testata || ""); if (name.length < 3) return null;
  for (const it of items.values()){
    if (!isSerie(it)) continue;
    const t = norm(it.testata || it.titolo);
    if (!(t === name || norm(it.titolo).includes(name) || name.includes(t))) continue;
    if (it.editore && r.editore && norm(it.editore) !== norm(r.editore) && !norm(it.editore).includes(norm(r.editore)) && !norm(r.editore).includes(norm(it.editore))) continue;
    if (serieTot(it) && num > serieTot(it)) continue;
    return { serie: it, num };
  }
  return null;
}
/* doppioni: stessa testata e stesso numero/anno, oppure stesso titolo originale */
function findDuplicate(r){
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, "");
  for (const it of items.values()){
    if (r.titoloOriginale && it.titoloOriginale && norm(r.titoloOriginale) === norm(it.titoloOriginale)) return it;
    if (r.testata && norm(r.testata) === norm(it.testata)){
      if (r.tipo === "rivista" && r.anno && r.anno === it.anno && ((r.mese && r.mese === it.mese) || (r.numero && norm(r.numero) === norm(it.numero)))) return it;
      if (r.tipo === "volume" && r.numero && norm(r.numero) === norm(it.numero)) return it;
    }
    if (r.tipo === "volume" && r.titolo && norm(r.titolo) === norm(it.titolo)) return it;
  }
  return null;
}

/* ---------------- "Cerca su…": siti per il copia-incolla ---------------- */
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function searchLinks(f){
  const q = (f.titoloOriginale || f.titolo || f.testata || "").trim();
  const g = (site, text) => "https://www.google.com/search?q=" + encodeURIComponent((site ? "site:" + site + " " : "") + text);
  const t = (f.testata || f.titolo || "").toLowerCase();
  const L = [["Google", g("", q || "fumetto")]];
  if (/v ?jump|vジャンプ/.test(t + q.toLowerCase())){
    L.push(["Fujisan", g("fujisan.co.jp", q || "Vジャンプ")], ["furoku.net", g("furoku.net", q || "Vジャンプ")]);
    L.push(["Yugipedia", f.anno && f.mese ? "https://yugipedia.com/wiki/V_Jump_" + MONTHS_EN[f.mese - 1] + "_" + f.anno + "_promotional_card" : g("yugipedia.com", "V Jump promotional card " + (f.anno || ""))]);
    L.push(["CDJapan", g("cdjapan.co.jp", q || "V JUMP")], ["V Jump ufficiale", "https://vjump.shueisha.co.jp/"]);
  } else if (/jump|ジャンプ/.test(t + q.toLowerCase())){
    L.push(["Jajanken", "https://www.jajanken.net/en/issues"], ["Fujisan", g("fujisan.co.jp", q)], ["CDJapan", g("cdjapan.co.jp", q)]);
  } else if (f.tipo === "volume"){
    L.push(["AnimeClick", g("animeclick.it", q)], ["Panini", g("panini.it", q)], ["Star Comics", g("starcomics.com", q)], ["Amazon", "https://www.amazon.it/s?k=" + encodeURIComponent(q)]);
  } else {
    L.push(["Fujisan", g("fujisan.co.jp", q)], ["AnimeClick", g("animeclick.it", q)], ["CDJapan", g("cdjapan.co.jp", q)]);
  }
  return L;
}

/* ---------------- impostazioni (chiave Gemini) ---------------- */
function openSettings(msg = ""){
  openId = null; editing = true;
  $("#scrim").classList.add("open"); $("#sheet").classList.add("open");
  $("#sheet-title").textContent = "Impostazioni"; $("#edit").hidden = true;
  const masked = aiKey ? "••••••••" + aiKey.slice(-4) : "";
  const body = $("#sheet-body"); body.dataset.for = "";
  body.innerHTML = `<section class="blk"><h3>Autocompilazione con Gemini</h3>
    ${msg ? `<div class="aibox warn">${esc(msg)}</div>` : ""}
    <p class="hint-p">Serve per <b>Compila</b> (dal titolo) e <b>Da foto</b> (dalla copertina). La chiave è gratuita e la imposti una volta sola: vale su telefono e PC.</p>
    <ol class="hint-p">
      <li>Apri <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> con il tuo account Google.</li>
      <li>Premi <b>Crea chiave API</b> (se te lo chiede, scegli il progetto <b>collezione-jump</b>) e copiala.</li>
      <li>Incollala qui sotto e premi <b>Salva e prova</b>.</li>
    </ol>
    <p class="hint-p">Stato: <b>${aiKey ? "chiave impostata (" + esc(masked) + ")" : "nessuna chiave"}</b></p>
    <form id="ai-frm" class="ai-row" novalidate>
      <label class="f" style="flex:1">Chiave Gemini<input id="ai-key" type="password" autocomplete="off" placeholder="AIza…"></label>
      <button class="btn primary" type="submit" id="ai-save">Salva e prova</button>
    </form>
    <div id="ai-msg" class="hint-p"></div>
    ${aiKey ? '<button class="btn ghost small" type="button" id="ai-del">Rimuovi la chiave</button>' : ""}
    <p class="hint-p" style="margin-top:12px">Il piano gratuito ha un numero limitato di richieste al giorno: per qualche fumetto al giorno basta. Google può usare le richieste gratuite per migliorare i suoi servizi (qui sono solo titoli e copertine).</p>
  </section>`;
  $("#ai-frm").onsubmit = async e => {
    e.preventDefault();
    const k = $("#ai-key").value.trim(); if (k.length < 20){ $("#ai-msg").textContent = "Incolla la chiave completa (di solito inizia con AIza)."; return; }
    const b = $("#ai-save"); b.disabled = true; $("#ai-msg").textContent = "Provo la chiave…";
    try {
      await gemini(() => [{ text: "Rispondi solo: OK" }], { modes: ["none"], key: k });
      await saveAiKey(k); toast("Chiave Gemini salvata e funzionante."); openSettings();
    } catch (err) { $("#ai-msg").textContent = err instanceof AiError ? err.message : "Non riesco a salvare la chiave (" + (err.message || "errore") + ")."; }
    finally { b.disabled = false; }
  };
  const del = $("#ai-del"); if (del) del.onclick = async () => { try { await saveAiKey(null); toast("Chiave rimossa."); openSettings(); } catch { toast("Non riesco a rimuovere la chiave adesso."); } };
}

/* ---------------- ricerca da foto ---------------- */
async function photoToDataUrl(file, max = 1024, q = 0.82){
  const img = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", q);
}
/* l'anno non è stampato in copertina: lo chiedo a te (un tocco) invece di tirare a indovinare */
function askYear(body, photo, r){
  return new Promise(resolve => {
    const now = new Date().getFullYear();
    const ys = [...new Set([...(r.anniPossibili || []), r.anno, now, now - 1].filter(Boolean))].sort((a, b) => b - a).slice(0, 5);
    body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
      <div><h2>Di che anno è?</h2>
      <p class="hint-p">Ho letto: <b>${esc(r.testata || r.titolo)}${r.numero ? " n. " + esc(r.numero) : ""}</b>${r.dataCopertina ? ", data di copertina <b>" + esc(r.dataCopertina) + "</b>" : ""}.</p>
      <p class="hint-p">L'anno non è stampato in copertina e da solo non posso esserne sicuro.${r.anno ? " Il più probabile secondo Gemini è il <b>" + r.anno + "</b>." : ""} Quale?</p>
      <div class="cover-actions">${ys.map(y => `<button class="btn ${y === now ? "primary" : "ghost"}" type="button" data-y="${y}">${y}</button>`).join("")}</div>
      <form id="y-frm" class="ai-row" novalidate style="margin-top:8px"><label class="f">Altro anno<input id="y-in" type="number" inputmode="numeric" min="1950" max="${now + 1}" placeholder="es. 2018" style="width:110px"></label><button class="btn small" type="submit">Continua</button></form>
      <p class="hint-p" style="margin-top:8px">Indizio: nel retro o nella prima pagina interna l'anno è quasi sempre stampato in piccolo.</p></div></div>`;
    body.querySelectorAll("[data-y]").forEach(b => b.onclick = () => resolve(+b.dataset.y));
    $("#y-frm").onsubmit = e => { e.preventDefault(); const y = parseInt($("#y-in").value); if (y > 1900 && y <= now + 1) resolve(y); else toast("Scrivi un anno valido."); };
    const obs = new MutationObserver(() => { if (!$("#sheet").classList.contains("open")){ obs.disconnect(); resolve(null); } });
    obs.observe($("#sheet"), { attributes: true, attributeFilter: ["class"] });
  });
}
async function photoSearch(file){
  if (!aiKey){ openSettings("Per riconoscere le copertine serve la chiave gratuita di Gemini."); return; }
  let photo; try { photo = await photoToDataUrl(file); } catch { toast("Non riesco a leggere questa foto."); return; }
  openId = null; editing = true;
  $("#scrim").classList.add("open"); $("#sheet").classList.add("open");
  $("#sheet-title").textContent = "Riconoscimento copertina"; $("#edit").hidden = true;
  const body = $("#sheet-body"); body.dataset.for = "";
  body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
    <div><h2>Sto riconoscendo la copertina…</h2><p class="hint-p">Gemini legge testata, numero e allegati stampati in copertina. Di solito bastano 5–20 secondi.</p><div class="spinner" aria-hidden="true"></div></div></div>`;
  try {
    let r = await aiIdentify(photo);
    if (!$("#sheet").classList.contains("open")) return;            // chiuso nel frattempo
    if (r.riconosciuto && r.titolo && r.tipo === "rivista" && (!r.annoCerto || !r.anno)){
      const y = await askYear(body, photo, r);
      if (!y || !$("#sheet").classList.contains("open")) return;
      setYear(r, y);
    }
    if (!r.riconosciuto || !r.titolo){
      body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
        <div><h2>Non l'ho riconosciuto</h2><p class="hint-p">${esc(r.note || "La foto non basta per capire di che numero si tratta.")}</p>
        <div class="cover-actions"><button class="btn primary" type="button" id="ph-manual">Inserisci a mano</button><button class="btn ghost" type="button" id="ph-retry">Riprova con un'altra foto</button></div></div></div>`;
      $("#ph-manual").onclick = () => openForm(null, {}, { photo });
      $("#ph-retry").onclick = () => $("#file-photo").click();
      return;
    }
    const sm = findSerieFor(r);
    if (sm){
      const st = volStato(sm.serie, sm.num);
      body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
        <div><h2>Volume ${sm.num} di una tua serie</h2><p class="hint-p">Ho riconosciuto <b>${esc(r.titolo)}</b>: è il n. ${sm.num} di <b>${esc(sm.serie.titolo)}</b>.</p>
        <p class="hint-p">Adesso è segnato come: <b>${VOL_STATI[st]}</b></p>
        <div class="cover-actions"><button class="btn primary" type="button" id="ph-ho">Segna «ce l'ho»</button><button class="btn ghost" type="button" id="ph-des">Segna «desiderato»</button></div>
        <div class="cover-actions"><button class="btn ghost small" type="button" id="ph-serie">Apri la serie</button><button class="btn ghost small" type="button" id="ph-sep">È un pezzo a parte: aggiungi</button></div></div></div>`;
      const mark = s2 => { const cur = structuredClone(items.get(sm.serie.id)); setVol(cur, sm.num, { s: s2 }); saveItem(sm.serie.id, cur); toast(`Volume ${sm.num} segnato come «${VOL_STATI[s2]}».`); editing = false; openSheet(sm.serie.id); };
      $("#ph-ho").onclick = () => mark("ho"); $("#ph-des").onclick = () => mark("desiderato");
      $("#ph-serie").onclick = () => { editing = false; openSheet(sm.serie.id); };
      $("#ph-sep").onclick = () => openForm(null, aiPreset(r), { photo, ai: r });
      return;
    }
    const dup = findDuplicate(r);
    const goForm = async () => {
      body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
        <div><h2>${esc(r.titolo)}</h2><p class="hint-p">Cerco i dettagli del numero (fumetti, allegati, data di uscita)…</p><div class="spinner" aria-hidden="true"></div></div></div>`;
      const full = await aiDetails(r);
      if ($("#sheet").classList.contains("open")) openForm(null, aiPreset(full), { photo, ai: full });
    };
    if (dup){
      body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
        <div><h2>Ce l'hai già!</h2><p class="hint-p">Ho riconosciuto <b>${esc(r.titolo)}</b> ed è già nella tua collezione come:</p>
        <p><b>${esc(dup.titolo)}</b> <span class="pill ${esc(dup.stato || "posseduto")}">${STATI[dup.stato] || "Posseduto"}</span></p>
        <div class="cover-actions"><button class="btn primary" type="button" id="ph-open">Apri la scheda</button><button class="btn ghost" type="button" id="ph-add">È un'altra copia: aggiungi</button></div></div></div>`;
      $("#ph-open").onclick = () => { editing = false; openSheet(dup.id); };
      $("#ph-add").onclick = () => goForm();
      return;
    }
    await goForm();
  } catch (err) {
    body.innerHTML = `<div class="hero"><div><div class="cover"><img src="${photo}" alt="La tua foto"></div></div>
      <div><h2>Riconoscimento non riuscito</h2><p class="hint-p">${esc(err instanceof AiError ? err.message : "Errore imprevisto: riprova.")}</p>
      <div class="cover-actions"><button class="btn primary" type="button" id="ph-manual">Inserisci a mano</button></div></div></div>`;
    $("#ph-manual").onclick = () => openForm(null, {}, { photo });
  }
}
function aiPreset(r){
  const p = {}; for (const k of ["tipo","testata","editore","collana","anno","mese","numero","titolo","titoloOriginale","dataUscita","prezzo","copertina","autori","fumetti","allegati","fonti","totale","anni","statoSerie"]) p[k] = r[k];
  p.stato = "posseduto";
  p.note = aiNote(r);
  return p;
}
function aiNote(r){
  const d = new Date().toLocaleDateString("it-IT");
  return `Compilato con Gemini il ${d} (${MODE_LABEL[r.mode] || "Gemini"}; affidabilità: ${r.confidenza || "non indicata"}): da verificare.` + (r.note ? "\n" + r.note : "");
}

/* ---------------- modulo ---------------- */
function subFumetto(f = {}){ return `<div class="subrow fu"><label class="f">Titolo<input data-k="titolo" value="${esc(f.titolo)}"></label><label class="f">Autori<input data-k="autori" value="${esc(f.autori)}"></label><button type="button" class="x" aria-label="Rimuovi">✕</button><input type="hidden" data-k="verificato" value="${f.verificato === false ? "0" : "1"}"></div>`; }
function subAllegato(a = {}){ return `<div class="subrow al"><label class="f">Tipo<select data-k="tipo">${Object.entries(TIPI_ALL).map(([k, v]) => `<option value="${k}" ${a.tipo === k ? "selected" : ""}>${v}</option>`).join("")}</select></label><label class="f">Gioco<input data-k="gioco" value="${esc(a.gioco)}" list="giochi"></label><label class="f">Nome<input data-k="nome" value="${esc(a.nome)}"></label><label class="f">Codice<input data-k="codice" value="${esc(a.codice)}"></label><button type="button" class="x" aria-label="Rimuovi">✕</button><input type="hidden" data-k="ho" value="${a.ho ? "1" : "0"}"></div>`; }
let pendingPhoto = null;   // foto scattata con "Da foto", diventa la copertina al salvataggio
function openForm(id, preset = {}, opts = {}){
  const it = id ? items.get(id) : Object.assign({ tipo:"rivista", testata:"", editore:"", stato:"posseduto", fumetti:[], allegati:[] }, preset);
  pendingPhoto = id ? null : (opts.photo || null);
  openId = id || null; editing = true;
  $("#scrim").classList.add("open"); $("#sheet").classList.add("open");
  $("#sheet-title").textContent = id ? "Modifica" : "Nuovo pezzo"; $("#edit").hidden = true;
  const giochi = [...new Set([...items.values()].flatMap(i => (i.allegati || []).map(a => a.gioco)).filter(Boolean))];
  const testate = [...new Set(["V Jump", "Weekly Shonen Jump", ...[...items.values()].map(i => i.testata)].filter(Boolean))];
  const body = $("#sheet-body"); body.dataset.for = "";
  const aiBox = opts.ai ? `<div class="aibox ${opts.ai.confidenza === "alta" ? "" : "warn"}"><b>Compilato da Gemini</b> · fonte: ${esc(MODE_LABEL[opts.ai.mode] || "lettura della copertina")} · affidabilità ${esc(opts.ai.confidenza || "non indicata")}. Controlla i dati prima di salvare: i campi incerti sono indicati nelle note.</div>` : "";
  const hoNow = isSerie(it) ? fmtRange(volsWith(it, "ho")) : "";
  body.innerHTML = `<form id="frm" novalidate data-tipo="${esc(it.tipo || "rivista")}">
    <div id="f-aibox">${aiBox}</div>
    ${pendingPhoto ? `<div class="photo-row"><img src="${pendingPhoto}" alt=""><span class="hint-p">La tua foto diventerà la copertina di questo pezzo.</span></div>` : ""}
    <datalist id="giochi">${giochi.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <datalist id="testate">${testate.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <div class="row">
      <label class="f">Tipo<select name="tipo" id="f-tipo"><option value="rivista" ${it.tipo !== "volume" && it.tipo !== "serie" ? "selected" : ""}>Rivista</option><option value="volume" ${it.tipo === "volume" ? "selected" : ""}>Volume / albo</option><option value="serie" ${it.tipo === "serie" ? "selected" : ""}>Serie (tutti i volumi)</option></select></label>
      <label class="f only-single">Stato<select name="stato" id="f-stato">${Object.entries(STATI).map(([k, v]) => `<option value="${k}" ${it.stato === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <label class="f">Titolo completo<input name="titolo" id="f-titolo" required value="${esc(it.titolo)}" placeholder="es. V Jump – Aprile 2026 (n. 4/2026)"></label>
    <div class="ai-row">
      <button type="button" class="btn primary small" id="f-ai">✨ Compila con Gemini</button>
      <span class="hint-p">Scrivi il titolo (anche breve, es. «V Jump aprile 2025») e premi Compila: riempie i campi vuoti.</span>
    </div>
    <div class="searchlinks" id="f-links"></div>
    <div class="row only-serie">
      <label class="f">Volumi totali<input name="totale" id="f-totale" type="number" min="1" inputmode="numeric" value="${esc(it.totale)}" placeholder="es. 42"></label>
      <label class="f">Anni di pubblicazione<input name="anni" id="f-anni" value="${esc(it.anni)}" placeholder="es. 1995–1997"></label>
      <label class="f">Stato della serie<select name="statoSerie" id="f-statoserie"><option value="">—</option>${Object.entries(STATI_SERIE).map(([k, v]) => `<option value="${k}" ${it.statoSerie === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <label class="f only-serie">Volumi che hai (numeri o intervalli)<input name="range" id="f-range" inputmode="numeric" value="${esc(hoNow)}" placeholder="es. 1-40, 42, 45-62"></label>
    <p class="hint-p only-serie">Poi, nella scheda della serie, tocchi i singoli numeri per segnarli «ce l'ho», «manca», «desiderato» o «prima stampa / ristampa».</p>
    <label class="f">Titolo originale<input name="titoloOriginale" id="f-jp" value="${esc(it.titoloOriginale)}" placeholder="es. Vジャンプ 2026年4月号"></label>
    <div class="row">
      <label class="f">Testata / serie<input name="testata" id="f-testata" list="testate" value="${esc(it.testata)}"></label>
      <label class="f">Editore<input name="editore" id="f-editore" value="${esc(it.editore)}"></label>
      <label class="f">Collana / edizione<input name="collana" id="f-collana" value="${esc(it.collana)}" placeholder="es. prima edizione"></label>
    </div>
    <div class="row only-single">
      <label class="f">Anno<input name="anno" id="f-anno" type="number" inputmode="numeric" value="${esc(it.anno)}"></label>
      <label class="f">Mese (1–12)<input name="mese" id="f-mese" type="number" min="1" max="12" inputmode="numeric" value="${esc(it.mese)}"></label>
      <label class="f">Numero<input name="numero" id="f-numero" value="${esc(it.numero)}"></label>
      <label class="f">Uscita<input name="dataUscita" id="f-uscita" type="date" value="${esc(it.dataUscita)}"></label>
    </div>
    <div class="row">
      <label class="f">Autori<input name="autori" id="f-autori" value="${esc(it.autori)}"></label>
      <label class="f only-single">Prezzo<input name="prezzo" id="f-prezzo" value="${esc(it.prezzo)}"></label>
      <label class="f">Condizioni<input name="condizione" id="f-cond" value="${esc(it.condizione)}" placeholder="es. sigillato, ottimo"></label>
    </div>
    <label class="f only-single">In copertina<input name="copertina" id="f-cop" value="${esc(it.copertina)}"></label>
    <section class="blk only-single"><h3>Allegati e carte promo</h3><div class="sub" id="f-al">${(it.allegati || []).map(subAllegato).join("")}</div><button type="button" class="btn ghost small" id="add-al" style="margin-top:6px">+ Allegato</button></section>
    <section class="blk only-single"><h3>Fumetti contenuti</h3><div class="sub" id="f-fu">${(it.fumetti || []).map(subFumetto).join("")}</div><button type="button" class="btn ghost small" id="add-fu" style="margin-top:6px">+ Fumetto</button></section>
    <label class="f">Note<textarea name="note" id="f-note">${esc(it.note)}</textarea></label>
    <label class="f">Fonti (un link per riga)<textarea name="fonti" id="f-fonti">${esc((it.fonti || []).join("\n"))}</textarea></label>
    <div class="formbar">${id ? '<button type="button" class="btn ghost" id="del">Elimina</button>' : ""}<span style="flex:1"></span><button type="button" class="btn ghost" id="cancel">Annulla</button><button type="submit" class="btn primary">Salva</button></div>
  </form>`;
  body.scrollTop = 0;
  $("#f-tipo").addEventListener("change", () => { $("#frm").dataset.tipo = $("#f-tipo").value; });
  const formVals = () => ({ titolo: $("#f-titolo").value, titoloOriginale: $("#f-jp").value, testata: $("#f-testata").value, tipo: $("#f-tipo").value, anno: parseInt($("#f-anno").value) || null, mese: parseInt($("#f-mese").value) || null });
  const drawLinks = () => { $("#f-links").innerHTML = '<span class="hint-p">Cerca su:</span> ' + searchLinks(formVals()).map(([n, u]) => `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join(""); };
  drawLinks(); ["#f-titolo","#f-jp","#f-testata","#f-tipo","#f-anno","#f-mese"].forEach(s => $(s).addEventListener("input", drawLinks));
  $("#f-ai").onclick = async () => {
    const q = ($("#f-titolo").value || $("#f-jp").value).trim();
    if (!q){ toast("Scrivi prima il titolo (anche breve)."); $("#f-titolo").focus(); return; }
    if (!aiKey){ openSettings("Per usare Compila serve la chiave gratuita di Gemini."); return; }
    const b = $("#f-ai"); b.disabled = true; b.textContent = "Cerco… (10–30 s)";
    try {
      const r = await aiLookup({ query: [q, $("#f-tipo").value === "serie" ? "serie completa: tutti i volumi di questa edizione" : "", $("#f-testata").value, $("#f-anno").value && ("anno " + $("#f-anno").value), $("#f-mese").value && ("mese " + $("#f-mese").value)].filter(Boolean).join(", "), hint: { y: parseInt($("#f-anno").value) || null, m: parseInt($("#f-mese").value) || null } });
      if (!$("#f-ai")) return;
      if (!r.riconosciuto){ $("#f-aibox").innerHTML = `<div class="aibox warn"><b>Gemini non ha trovato questo numero.</b> ${esc(r.note)} Prova a scrivere il titolo in modo più preciso o usa i pulsanti «Cerca su».</div>`; return; }
      const n = fillForm(r);
      $("#f-aibox").innerHTML = `<div class="aibox ${r.confidenza === "alta" ? "" : "warn"}"><b>Compilati ${n} campi</b> · fonte: ${esc(MODE_LABEL[r.mode] || "Gemini")} · affidabilità ${esc(r.confidenza || "non indicata")}. Ho riempito solo i campi vuoti: controlla prima di salvare.</div>`;
      drawLinks(); $("#sheet-body").scrollTop = 0;
    } catch (err) { if (err instanceof AiError) $("#f-aibox").innerHTML = `<div class="aibox warn">${esc(err.message)}</div>`; else toast("Compilazione non riuscita."); }
    finally { const bb = $("#f-ai"); if (bb){ bb.disabled = false; bb.textContent = "✨ Compila con Gemini"; } }
  };
  $("#add-al").onclick = () => $("#f-al").insertAdjacentHTML("beforeend", subAllegato({ tipo:"carta" }));
  $("#add-fu").onclick = () => $("#f-fu").insertAdjacentHTML("beforeend", subFumetto());
  body.onclick = e => { if (e.target.classList.contains("x")) e.target.closest(".subrow").remove(); };
  $("#cancel").onclick = () => { if (id){ editing = false; renderDetail(); } else closeSheet(); };
  const del = $("#del"); if (del) del.onclick = () => confirmDelete(id);
  $("#frm").onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target); const d = {};
    for (const [k, v] of fd.entries()) d[k] = String(v).trim();
    if (!d.titolo){ toast("Scrivi almeno il titolo."); $("#f-titolo").focus(); return; }
    d.anno = d.anno ? parseInt(d.anno) : null; d.mese = d.mese ? parseInt(d.mese) : null;
    const range = d.range; delete d.range;
    if (d.tipo === "serie"){
      d.totale = parseInt(d.totale) || null; d.stato = "posseduto";
      const prevIt = id ? items.get(id) : null;
      const tmp = { volumi: structuredClone((prevIt && prevIt.volumi) || {}), totale: d.totale };
      const want = new Set(parseRange(range));
      if (d.totale) for (const n of want) if (n > d.totale) want.delete(n);
      for (let n = 1; n <= (d.totale || 0); n++){
        const cur = volStato(tmp, n);
        if (want.has(n) && cur !== "ho") setVol(tmp, n, { s: "ho" });
        if (!want.has(n) && cur === "ho") setVol(tmp, n, { s: "manca" });
      }
      d.volumi = tmp.volumi; d.allegati = []; d.fumetti = [];
      ["mese", "numero", "dataUscita", "prezzo", "copertina"].forEach(k => delete d[k]);
    } else { delete d.totale; delete d.anni; delete d.statoSerie; }
    d.fonti = d.fonti ? d.fonti.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
    if (d.tipo !== "serie") d.fumetti = [...document.querySelectorAll("#f-fu .subrow")].map(r => ({ titolo: r.querySelector('[data-k="titolo"]').value.trim(), autori: r.querySelector('[data-k="autori"]').value.trim(), verificato: r.querySelector('[data-k="verificato"]').value !== "0" })).filter(f => f.titolo);
    if (d.tipo !== "serie") d.allegati = [...document.querySelectorAll("#f-al .subrow")].map(r => ({ tipo: r.querySelector('[data-k="tipo"]').value, gioco: r.querySelector('[data-k="gioco"]').value.trim(), nome: r.querySelector('[data-k="nome"]').value.trim(), codice: r.querySelector('[data-k="codice"]').value.trim(), ho: r.querySelector('[data-k="ho"]').value === "1" })).filter(a => a.nome || a.gioco);
    const prev = id ? items.get(id) : null; if (prev && prev.coverV) d.coverV = prev.coverV;
    const newId = id || ("it-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    if (!id && pendingPhoto){
      const v = Date.now(); const c = { v, img: pendingPhoto }; covers.set(newId, c); IDB.put(newId, c);
      d.coverV = v; queue({ op: "cover", id: newId, v }); pendingPhoto = null;
    }
    editing = false; openId = newId; saveItem(newId, d); toast("Salvato.");
  };
}
function confirmDelete(id){
  const bar = document.querySelector(".formbar");
  bar.innerHTML = '<span style="flex:1;align-self:center;font-weight:700">Eliminare questo pezzo? Non si può annullare.</span><button type="button" class="btn ghost" id="no">No</button><button type="button" class="btn primary" id="yes">Sì, elimina</button>';
  $("#no").onclick = () => openForm(id);
  $("#yes").onclick = () => {
    closeSheet(); deleteItem(id); toast("Eliminato.");
  };
}

function fillForm(r){
  let n = 0;
  const set = (sel, v) => { const el = $(sel); if (el && v !== null && v !== undefined && v !== "" && !el.value.trim()){ el.value = v; n++; } };
  if (r.tipo && !$("#f-testata").value.trim() && $("#f-tipo").value !== "serie"){ $("#f-tipo").value = r.tipo; $("#frm").dataset.tipo = r.tipo; }
  set("#f-jp", r.titoloOriginale); set("#f-testata", r.testata); set("#f-editore", r.editore); set("#f-collana", r.collana);
  set("#f-anno", r.anno); set("#f-mese", r.mese); set("#f-numero", r.numero); set("#f-uscita", r.dataUscita);
  set("#f-autori", r.autori); set("#f-prezzo", r.prezzo); set("#f-cop", r.copertina);
  if (r.tipo === "serie" || $("#f-tipo").value === "serie"){
    set("#f-totale", r.totale); set("#f-anni", r.anni);
    if (r.statoSerie && !$("#f-statoserie").value){ $("#f-statoserie").value = r.statoSerie; n++; }
  }
  // il titolo scritto a mano lo sostituisco con quello completo solo se era breve
  const t = $("#f-titolo"); if (r.titolo && t.value.trim().length < r.titolo.length && !t.value.includes("–")){ t.value = r.titolo; n++; }
  if (!document.querySelector("#f-al .subrow") && r.allegati.length){ $("#f-al").insertAdjacentHTML("beforeend", r.allegati.map(subAllegato).join("")); n++; }
  if (!document.querySelector("#f-fu .subrow") && r.fumetti.length){ $("#f-fu").insertAdjacentHTML("beforeend", r.fumetti.map(subFumetto).join("")); n++; }
  const note = $("#f-note"); note.value = note.value.trim() ? note.value.trim() + "\n" + aiNote(r) : aiNote(r);
  const fo = $("#f-fonti"); const have = new Set(fo.value.split(/\n+/).map(x => x.trim()).filter(Boolean));
  r.fonti.forEach(x => have.add(x)); fo.value = [...have].join("\n");
  return n;
}

/* ---------------- backup ---------------- */
async function saveFile(name, data, mime){
  const P = NATIVE && window.Capacitor.Plugins;
  if (P && P.Filesystem && P.Share){
    try {
      const r = await P.Filesystem.writeFile({ path: name, data, directory: "CACHE", encoding: "utf8" });
      await P.Share.share({ title: name, url: r.uri, dialogTitle: "Salva o invia " + name });
    } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast("Esportazione non riuscita."); }
    return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportData(fmt){
  const list = [...items.values()].sort(cmp);
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === "json") return saveFile(`collezione-fumetti-${stamp}.json`, JSON.stringify(list, null, 2), "application/json");
  const cols = ["tipo","stato","testata","editore","collana","anno","mese","numero","titolo","titoloOriginale","dataUscita","copertina","autori","fumetti","allegati","totale","anni","volumi","note"];
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const rows = list.map(i => cols.map(c => c === "fumetti" ? q((i.fumetti || []).map(f => f.titolo).join(" | ")) : c === "allegati" ? q((i.allegati || []).map(a => (a.ho ? "[x] " : "[ ] ") + a.gioco + ": " + a.nome).join(" | ")) : c === "volumi" ? q(isSerie(i) ? `ce l'ho: ${fmtRange(volsWith(i, "ho"))} | mancano: ${fmtRange(volsWith(i, "manca"))} | desiderati: ${fmtRange(volsWith(i, "desiderato"))}` : "") : q(i[c])).join(";"));
  return saveFile(`collezione-fumetti-${stamp}.csv`, "﻿" + cols.join(";") + "\n" + rows.join("\n"), "text/csv");
}
$("#file-json").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const list = JSON.parse(await f.text()); if (!Array.isArray(list)) throw 0;
    let n = 0; for (const it of list){ if (it && it.id && it.titolo){ const d = Object.assign({}, it); delete d.id; outbox = outbox.filter(o => o.id !== it.id); const op = { op:"upsert", id: it.id, data: d }; outbox.push(op); applyOp(op); n++; } }
    persist(); render(); flush(); toast(n + " pezzi ripristinati dal backup.");
  } catch { toast("Il file non è un backup valido di Collezione Fumetti."); }
});

/* ---------------- eventi ---------------- */
$("#q").addEventListener("input", e => { query = e.target.value.trim(); render(); });
document.querySelectorAll(".views button").forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
$("#content").addEventListener("click", e => {
  const b = e.target.closest("[data-id]"); if (b){ openSheet(b.dataset.id); return; }
  const n = e.target.closest("[data-new]"); if (n){ const [y, m] = n.dataset.new.split("-").map(Number);
    openForm(null, { testata: "V Jump", editore: "Shueisha", anno: y, mese: m, numero: String(m), stato: "desiderato", titolo: `V Jump – ${MESI_LUNGHI[m - 1]} ${y} (n. ${m}/${y})`, titoloOriginale: `Vジャンプ ${y}年${m}月号` }); }
});
$("#file").addEventListener("change", e => { const f = e.target.files[0]; const id = e.target.dataset.target; e.target.value = ""; if (f && id) uploadCover(id, f); });
$("#add").onclick = () => openForm(null);
$("#photo").onclick = () => { if (!aiKey){ openSettings("Per riconoscere le copertine serve la chiave gratuita di Gemini."); return; } $("#file-photo").click(); };
$("#file-photo").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) photoSearch(f); });
$("#settings").onclick = () => openSettings();
$("#edit").onclick = () => openForm(openId);
$("#close").onclick = closeSheet; $("#scrim").onclick = closeSheet;
$("#refresh").onclick = () => pull();
$("#exp-json").onclick = () => exportData("json");
$("#exp-csv").onclick = () => exportData("csv");
$("#imp-json").onclick = () => $("#file-json").click();
$("#logout").onclick = () => { LS.del("cj_aikey"); aiKey = null; session = null; LS.del("cj_session"); LS.del("cj_items"); LS.del("cj_cursor"); cursor = null; items = new Map(); covers.clear(); IDB.clear(); showLogin(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetOpen()) closeSheet(); });
window.addEventListener("online", () => pull());
window.addEventListener("offline", () => setSync("off"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); else flushSoon(); });
window.addEventListener("pagehide", flushSoon);
setInterval(() => { if (document.visibilityState === "visible" && session) pull(); }, 5 * 60000);

/* tasto Indietro di Android: chiude la scheda invece di uscire */
if (NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins.App){
  window.Capacitor.Plugins.App.addListener("backButton", () => {
    if (sheetOpen()) closeSheet(); else window.Capacitor.Plugins.App.exitApp();
  });
}
/* installazione su PC: service worker solo nella versione web */
if (!NATIVE && "serviceWorker" in navigator && location.protocol === "https:"){
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ---------------- avvio ---------------- */
function start(){
  if (!CFG) return showSetup();
  if (!session) return showLogin();
  showApp(); setSync(navigator.onLine ? "busy" : "off"); pull().then(loadAiKey);
}
start();
})();
