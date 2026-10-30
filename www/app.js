/* Collezione Jump – app per PC (PWA) e Android (Capacitor).
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
  store: "https://firestore.googleapis.com/v1"
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
function sortKey(it){ return [it.tipo === "volume" ? 1 : 0, (it.testata || "").toLowerCase(), -(it.anno || 0), -(parseInt(it.mese || it.numero) || 0), (it.titolo || "").toLowerCase()]; }
function cmp(a, b){ const A = sortKey(a), B = sortKey(b); for (let i = 0; i < A.length; i++){ if (A[i] < B[i]) return -1; if (A[i] > B[i]) return 1; } return 0; }
function cards(it){ return (it.allegati || []).filter(a => a.tipo === "carta"); }
function groupKey(it){ return it.tipo === "volume" ? (it.editore || "Volumi") : (it.testata || "Altro"); }
function fmtDate(s){ if (!s) return ""; const [y, m, d] = s.split("-"); return d ? `${+d} ${MESI[+m - 1]} ${y}` : s; }

function renderStats(){
  const all = [...items.values()], own = all.filter(i => i.stato !== "desiderato"), c = all.flatMap(cards);
  $("#st-items").textContent = own.length;
  $("#st-vj").textContent = own.filter(i => kind(i) === "vj").length;
  $("#st-cards").textContent = c.length;
  $("#st-check").textContent = c.filter(a => a.ho).length + "/" + c.length;
  $("#st-wish").textContent = all.filter(i => i.stato === "desiderato").length;
}
function renderTabs(){
  const g = new Map([["Tutti", items.size]]);
  for (const it of items.values()) g.set(groupKey(it), (g.get(groupKey(it)) || 0) + 1);
  const w = [...items.values()].filter(i => i.stato === "desiderato").length; if (w) g.set("Desiderati", w);
  if (!g.has(filter)) filter = "Tutti";
  const el = $("#tabs"); el.innerHTML = "";
  for (const [k, n] of g){
    const b = document.createElement("button"); b.type = "button"; b.className = "tab"; b.setAttribute("aria-pressed", String(k === filter));
    b.innerHTML = esc(k) + '<span class="n">' + n + "</span>"; b.onclick = () => { filter = k; render(); }; el.appendChild(b);
  }
}
function matches(it){
  if (filter === "Desiderati" && it.stato !== "desiderato") return false;
  if (filter !== "Tutti" && filter !== "Desiderati" && groupKey(it) !== filter) return false;
  if (!query) return true;
  const hay = [it.titolo, it.titoloOriginale, it.testata, it.editore, it.collana, it.autori, it.copertina, it.note, it.anno, it.numero,
    ...(it.fumetti || []).flatMap(f => [f.titolo, f.autori]), ...(it.allegati || []).flatMap(a => [a.gioco, a.nome, a.codice])].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function placeholder(it){
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
    const c = cards(it); const sub = it.tipo === "volume" ? (it.autori || it.collana || "") : (it.dataUscita ? "uscito il " + fmtDate(it.dataUscita) : "");
    return `<button class="item" type="button" data-id="${esc(it.id)}">
      <div class="cover">${coverHtml(it)}${c.length ? `<span class="badge">${c.length} carte</span>` : ""}${it.stato === "desiderato" ? '<span class="badge wish">desiderato</span>' : it.stato === "arrivo" ? '<span class="badge wish">in arrivo</span>' : ""}</div>
      <div class="meta"><span class="k">${esc(it.tipo === "volume" ? (it.editore || "") : it.testata)}</span><span class="n">${esc(it.titolo)}</span><span class="s">${esc(sub)}</span></div>
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
function closeSheet(){ openId = null; editing = false; $("#scrim").classList.remove("open"); $("#sheet").classList.remove("open"); }
function sheetOpen(){ return $("#sheet").classList.contains("open"); }
function renderDetail(){
  const it = items.get(openId); if (!it){ closeSheet(); return; }
  $("#sheet-title").textContent = it.tipo === "volume" ? (it.editore || "") : it.testata; $("#edit").hidden = false;
  const c = cards(it);
  const facts = [
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
  if ((it.fonti || []).length) h += `<section class="blk"><h3>Fonti</h3><div class="src">${it.fonti.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ""))}</a>`).join("")}</div></section>`;
  const body = $("#sheet-body"); const keep = body.dataset.for === openId ? body.scrollTop : 0;
  body.innerHTML = h; body.dataset.for = openId; body.scrollTop = keep;
  $("#up").onclick = () => { $("#file").dataset.target = it.id; $("#file").click(); };
  const rm = $("#rm"); if (rm) rm.onclick = () => removeCover(it.id);
  document.querySelectorAll("[data-al]").forEach(cb => cb.onchange = () => {
    const next = structuredClone(items.get(it.id)); next.allegati[+cb.dataset.al].ho = cb.checked; saveItem(it.id, next);
  });
}

/* ---------------- modulo ---------------- */
function subFumetto(f = {}){ return `<div class="subrow fu"><label class="f">Titolo<input data-k="titolo" value="${esc(f.titolo)}"></label><label class="f">Autori<input data-k="autori" value="${esc(f.autori)}"></label><button type="button" class="x" aria-label="Rimuovi">✕</button><input type="hidden" data-k="verificato" value="${f.verificato === false ? "0" : "1"}"></div>`; }
function subAllegato(a = {}){ return `<div class="subrow al"><label class="f">Tipo<select data-k="tipo">${Object.entries(TIPI_ALL).map(([k, v]) => `<option value="${k}" ${a.tipo === k ? "selected" : ""}>${v}</option>`).join("")}</select></label><label class="f">Gioco<input data-k="gioco" value="${esc(a.gioco)}" list="giochi"></label><label class="f">Nome<input data-k="nome" value="${esc(a.nome)}"></label><label class="f">Codice<input data-k="codice" value="${esc(a.codice)}"></label><button type="button" class="x" aria-label="Rimuovi">✕</button><input type="hidden" data-k="ho" value="${a.ho ? "1" : "0"}"></div>`; }
function openForm(id, preset = {}){
  const it = id ? items.get(id) : Object.assign({ tipo:"rivista", testata:"V Jump", editore:"Shueisha", stato:"posseduto", fumetti:[], allegati:[] }, preset);
  openId = id || null; editing = true;
  $("#scrim").classList.add("open"); $("#sheet").classList.add("open");
  $("#sheet-title").textContent = id ? "Modifica" : "Nuovo pezzo"; $("#edit").hidden = true;
  const giochi = [...new Set([...items.values()].flatMap(i => (i.allegati || []).map(a => a.gioco)).filter(Boolean))];
  const testate = [...new Set(["V Jump", "Weekly Shonen Jump", ...[...items.values()].map(i => i.testata)].filter(Boolean))];
  const body = $("#sheet-body"); body.dataset.for = "";
  body.innerHTML = `<form id="frm" novalidate>
    <datalist id="giochi">${giochi.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <datalist id="testate">${testate.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <div class="row">
      <label class="f">Tipo<select name="tipo" id="f-tipo"><option value="rivista" ${it.tipo !== "volume" ? "selected" : ""}>Rivista</option><option value="volume" ${it.tipo === "volume" ? "selected" : ""}>Volume / albo</option></select></label>
      <label class="f">Stato<select name="stato" id="f-stato">${Object.entries(STATI).map(([k, v]) => `<option value="${k}" ${it.stato === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <label class="f">Titolo completo<input name="titolo" id="f-titolo" required value="${esc(it.titolo)}" placeholder="es. V Jump – Aprile 2026 (n. 4/2026)"></label>
    <label class="f">Titolo originale<input name="titoloOriginale" id="f-jp" value="${esc(it.titoloOriginale)}" placeholder="es. Vジャンプ 2026年4月号"></label>
    <div class="row">
      <label class="f">Testata / serie<input name="testata" id="f-testata" list="testate" value="${esc(it.testata)}"></label>
      <label class="f">Editore<input name="editore" id="f-editore" value="${esc(it.editore)}"></label>
      <label class="f">Collana<input name="collana" id="f-collana" value="${esc(it.collana)}"></label>
    </div>
    <div class="row">
      <label class="f">Anno<input name="anno" id="f-anno" type="number" inputmode="numeric" value="${esc(it.anno)}"></label>
      <label class="f">Mese (1–12)<input name="mese" id="f-mese" type="number" min="1" max="12" inputmode="numeric" value="${esc(it.mese)}"></label>
      <label class="f">Numero<input name="numero" id="f-numero" value="${esc(it.numero)}"></label>
      <label class="f">Uscita<input name="dataUscita" id="f-uscita" type="date" value="${esc(it.dataUscita)}"></label>
    </div>
    <div class="row">
      <label class="f">Autori<input name="autori" id="f-autori" value="${esc(it.autori)}"></label>
      <label class="f">Prezzo<input name="prezzo" id="f-prezzo" value="${esc(it.prezzo)}"></label>
      <label class="f">Condizioni<input name="condizione" id="f-cond" value="${esc(it.condizione)}" placeholder="es. sigillato, ottimo"></label>
    </div>
    <label class="f">In copertina<input name="copertina" id="f-cop" value="${esc(it.copertina)}"></label>
    <section class="blk"><h3>Allegati e carte promo</h3><div class="sub" id="f-al">${(it.allegati || []).map(subAllegato).join("")}</div><button type="button" class="btn ghost small" id="add-al" style="margin-top:6px">+ Allegato</button></section>
    <section class="blk"><h3>Fumetti contenuti</h3><div class="sub" id="f-fu">${(it.fumetti || []).map(subFumetto).join("")}</div><button type="button" class="btn ghost small" id="add-fu" style="margin-top:6px">+ Fumetto</button></section>
    <label class="f">Note<textarea name="note" id="f-note">${esc(it.note)}</textarea></label>
    <label class="f">Fonti (un link per riga)<textarea name="fonti" id="f-fonti">${esc((it.fonti || []).join("\n"))}</textarea></label>
    <div class="formbar">${id ? '<button type="button" class="btn ghost" id="del">Elimina</button>' : ""}<span style="flex:1"></span><button type="button" class="btn ghost" id="cancel">Annulla</button><button type="submit" class="btn primary">Salva</button></div>
  </form>`;
  body.scrollTop = 0;
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
    d.fonti = d.fonti ? d.fonti.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
    d.fumetti = [...document.querySelectorAll("#f-fu .subrow")].map(r => ({ titolo: r.querySelector('[data-k="titolo"]').value.trim(), autori: r.querySelector('[data-k="autori"]').value.trim(), verificato: r.querySelector('[data-k="verificato"]').value !== "0" })).filter(f => f.titolo);
    d.allegati = [...document.querySelectorAll("#f-al .subrow")].map(r => ({ tipo: r.querySelector('[data-k="tipo"]').value, gioco: r.querySelector('[data-k="gioco"]').value.trim(), nome: r.querySelector('[data-k="nome"]').value.trim(), codice: r.querySelector('[data-k="codice"]').value.trim(), ho: r.querySelector('[data-k="ho"]').value === "1" })).filter(a => a.nome || a.gioco);
    const prev = id ? items.get(id) : null; if (prev && prev.coverV) d.coverV = prev.coverV;
    const newId = id || ("it-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
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
  if (fmt === "json") return saveFile(`collezione-jump-${stamp}.json`, JSON.stringify(list, null, 2), "application/json");
  const cols = ["tipo","stato","testata","editore","collana","anno","mese","numero","titolo","titoloOriginale","dataUscita","copertina","autori","fumetti","allegati","note"];
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const rows = list.map(i => cols.map(c => c === "fumetti" ? q((i.fumetti || []).map(f => f.titolo).join(" | ")) : c === "allegati" ? q((i.allegati || []).map(a => (a.ho ? "[x] " : "[ ] ") + a.gioco + ": " + a.nome).join(" | ")) : q(i[c])).join(";"));
  return saveFile(`collezione-jump-${stamp}.csv`, "﻿" + cols.join(";") + "\n" + rows.join("\n"), "text/csv");
}
$("#file-json").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const list = JSON.parse(await f.text()); if (!Array.isArray(list)) throw 0;
    let n = 0; for (const it of list){ if (it && it.id && it.titolo){ const d = Object.assign({}, it); delete d.id; outbox = outbox.filter(o => o.id !== it.id); const op = { op:"upsert", id: it.id, data: d }; outbox.push(op); applyOp(op); n++; } }
    persist(); render(); flush(); toast(n + " pezzi ripristinati dal backup.");
  } catch { toast("Il file non è un backup valido di Collezione Jump."); }
});

/* ---------------- eventi ---------------- */
$("#q").addEventListener("input", e => { query = e.target.value.trim(); render(); });
document.querySelectorAll(".views button").forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
$("#content").addEventListener("click", e => {
  const b = e.target.closest("[data-id]"); if (b){ openSheet(b.dataset.id); return; }
  const n = e.target.closest("[data-new]"); if (n){ const [y, m] = n.dataset.new.split("-").map(Number);
    openForm(null, { anno: y, mese: m, numero: String(m), stato: "desiderato", titolo: `V Jump – ${MESI_LUNGHI[m - 1]} ${y} (n. ${m}/${y})`, titoloOriginale: `Vジャンプ ${y}年${m}月号` }); }
});
$("#file").addEventListener("change", e => { const f = e.target.files[0]; const id = e.target.dataset.target; e.target.value = ""; if (f && id) uploadCover(id, f); });
$("#add").onclick = () => openForm(null);
$("#edit").onclick = () => openForm(openId);
$("#close").onclick = closeSheet; $("#scrim").onclick = closeSheet;
$("#refresh").onclick = () => pull();
$("#exp-json").onclick = () => exportData("json");
$("#exp-csv").onclick = () => exportData("csv");
$("#imp-json").onclick = () => $("#file-json").click();
$("#logout").onclick = () => { session = null; LS.del("cj_session"); LS.del("cj_items"); LS.del("cj_cursor"); cursor = null; items = new Map(); covers.clear(); IDB.clear(); showLogin(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetOpen()) closeSheet(); });
window.addEventListener("online", () => pull());
window.addEventListener("offline", () => setSync("off"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
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
  showApp(); setSync(navigator.onLine ? "busy" : "off"); pull();
}
start();
})();
