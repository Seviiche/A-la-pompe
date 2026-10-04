/* À la pompe — logique de l'application
   Sources :
   - Prix, ruptures, dates : flux officiel « Prix des carburants en France – Flux instantané v2 »
     (ministère de l'Économie, data.economie.gouv.fr, licence ouverte)
   - Enseignes : API tierce prix-carburants.2aaz.fr (enrichissement facultatif, mis en cache 30 jours)
   - Géocodage : Géoplateforme IGN (data.geopf.fr)
*/
"use strict";

const C = {
  OFFICIEL: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2",
  ENSEIGNES: "https://api.prix-carburants.2aaz.fr",
  GEOCODAGE: "https://data.geopf.fr/geocodage",
  RAYON_DEFAUT: 30, RAYON_MIN: 5, RAYON_MAX: 50,
  COEF_ROUTE: 1.3,            // vol d'oiseau -> distance routière approchée
  RECENT_H: 72,               // seuil « prix fiable » pour les comparaisons
  SUSPECT: 0.20,              // écart > 20 % à la médiane = prix suspect
  ENSEIGNES_PAGES_MAX: 8,     // 8 × 20 stations les plus proches au maximum
  ENSEIGNES_TTL_J: 30,
  ENSEIGNES_MAX: 4000,
  NATIONAL_TTL_MIN: 60
};
const CARBUS = [
  { k: "gazole", n: "Gazole",   d: "B7, diesel" },
  { k: "e10",    n: "SP95-E10", d: "Sans plomb 95, 10 % éthanol" },
  { k: "sp95",   n: "SP95",     d: "Sans plomb 95 (E5)" },
  { k: "sp98",   n: "SP98",     d: "Sans plomb 98 (E5)" },
  { k: "e85",    n: "E85",      d: "Superéthanol" },
  { k: "gplc",   n: "GPLc",     d: "GPL carburant" }
];
const H = 36e5, J = 864e5;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const enc = encodeURIComponent;

/* ================= Stockage local tolérant aux erreurs ================= */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

/* ================= Préférences ================= */
const prefs = Object.assign(
  { carbu: "gazole", rayon: C.RAYON_DEFAUT, volume: 40, conso: 6.5, tri: "prix",
    filtres: { recent: false, rupt: false, autoroute: false, h24: false } },
  store.get("prefs", {})
);
(function lireURL() {
  const q = new URLSearchParams(location.search);
  if (CARBUS.some(c => c.k === q.get("carbu"))) prefs.carbu = q.get("carbu");
  const r = Number(q.get("rayon"));
  if (r >= C.RAYON_MIN && r <= C.RAYON_MAX) prefs.rayon = Math.round(r / 5) * 5;
})();
const sauverPrefs = () => store.set("prefs", prefs);
const nomCarbu = k => (CARBUS.find(c => c.k === k) || {}).n || k;

/* ================= État ================= */
const etat = {
  pos: null,                 // {lat, lon, precision?, libelle, source:"gps"|"adresse"}
  brut: [], charge: null,    // stations chargées + contexte {carbu, rayon, pos, t}
  nat: null, flux: null,
  enseignes: store.get("enseignes", {}),
  enseignesStatut: "attente",
  horsLigne: false,
  carte: null, grappes: null, cercle: null, moi: null, marqueurs: new Map(),
  jeton: 0
};

/* ================= Utilitaires ================= */
const pause = ms => new Promise(r => setTimeout(r, ms));
class ErreurHTTP extends Error { constructor(s) { super(`HTTP ${s}`); this.status = s; } }

async function fetchJSON(url, { timeout = 12000, retries = 2, headers = {} } = {}) {
  let derniere;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return { data: await r.json(), headers: r.headers };
      derniere = new ErreurHTTP(r.status);
      if (r.status < 500 && r.status !== 429) break;          // erreur client : inutile de réessayer
    } catch (e) {
      clearTimeout(t);
      derniere = e.name === "AbortError" ? new Error("délai de réponse dépassé")
               : e instanceof TypeError ? new Error("serveur injoignable ou pas de connexion") : e;
    }
    if (i < retries) await pause(700 * 2 ** i);
  }
  throw derniere;
}

const echap = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titreCasse = s => String(s || "").toLowerCase().replace(/(^|[\s\-'’(])\p{L}/gu, m => m.toUpperCase()).trim();
const euros3 = v => v.toFixed(3).replace(".", ",");
const euros2 = v => v.toFixed(2).replace(".", ",");
const km = v => (v < 10 ? v.toFixed(1) : Math.round(v).toString()).replace(".", ",");
const centimes = d => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d * 100).toFixed(1).replace(".", ",")} ct`;
const signeEuros = d => `${d > 0 ? "+" : d < 0 ? "−" : ""}${euros2(Math.abs(d))} €`;
function mediane(t) {
  if (!t.length) return null;
  const s = [...t].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function distanceKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---- Dates : le flux affiche « +00:00 » mais les heures sont en heure de Paris ---- */
const fmtParis = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function decalageParis(ts) {
  const p = Object.fromEntries(fmtParis.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}
function heureParis(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const naif = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const d = new Date(naif - decalageParis(naif));
  return d.getTime() > Date.now() + 2 * H ? null : d;            // date dans le futur = donnée invalide
}
const hhmm = d => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h");
function quand(d) {
  if (!d) return "à une date inconnue";
  const auj = new Date(); auj.setHours(0, 0, 0, 0);
  const jour = new Date(d); jour.setHours(0, 0, 0, 0);
  const n = Math.round((auj - jour) / J);
  if (n <= 0) return `aujourd'hui à ${hhmm(d)}`;
  if (n === 1) return `hier à ${hhmm(d)}`;
  return `il y a ${n} jours (${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })})`;
}
function fiabilite(ageH) {
  if (!isFinite(ageH)) return { c: "f-douteux", t: "très faible" };
  if (ageH <= 24) return { c: "f-frais", t: "élevée" };
  if (ageH <= 72) return { c: "f-moyen", t: "moyenne" };
  if (ageH <= 168) return { c: "f-vieux", t: "faible" };
  return { c: "f-douteux", t: "très faible" };
}

/* ================= Sources de données ================= */
async function chargerOfficiel(carbu, pos, rayon) {
  const f = carbu;
  const champs = ["id", "adresse", "ville", "cp", "pop", "geom", "horaires_automate_24_24",
    `${f}_prix`, `${f}_maj`, `${f}_rupture_debut`, `${f}_rupture_type`].join(",");
  const ou = `within_distance(geom, geom'POINT(${pos.lon.toFixed(5)} ${pos.lat.toFixed(5)})', ${rayon}km)` +
             ` and (${f}_prix is not null or ${f}_rupture_type="temporaire")`;
  const { data } = await fetchJSON(`${C.OFFICIEL}/exports/json?select=${enc(champs)}&where=${enc(ou)}`, { timeout: 20000 });
  if (!Array.isArray(data)) throw new Error("réponse inattendue de l'API officielle");
  const sortie = [];
  for (const s of data) {
    const lat = Number(s.geom?.lat), lon = Number(s.geom?.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const rupture = s[`${f}_rupture_type`] === "temporaire";
    const p = Number(s[`${f}_prix`]);
    const prix = !rupture && p > 0.2 && p < 6 ? p : null;      // bornes physiques grossières
    if (prix == null && !rupture) continue;
    sortie.push({
      id: String(s.id), adresse: titreCasse(s.adresse), ville: titreCasse(s.ville), cp: s.cp || "",
      autoroute: s.pop === "A", h24: s.horaires_automate_24_24 === "Oui", lat, lon,
      prix, maj: heureParis(s[`${f}_maj`]),
      rupture, ruptureDebut: rupture ? heureParis(s[`${f}_rupture_debut`]) : null,
      dist: distanceKm(pos.lat, pos.lon, lat, lon)
    });
  }
  return sortie;
}

async function chargerNational(carbu) {
  const cache = store.get("national", {});
  const c = cache[carbu];
  if (c && Date.now() - c.t < C.NATIONAL_TTL_MIN * 60000) return c;
  const sel = `median(${carbu}_prix) as med, count(*) as n`;
  const ou = `${carbu}_maj >= now(days=-7)`;
  const { data } = await fetchJSON(`${C.OFFICIEL}/records?select=${enc(sel)}&where=${enc(ou)}&limit=1`, { retries: 1 });
  const r = data?.results?.[0];
  if (!r || !(r.med > 0)) return null;
  cache[carbu] = { med: r.med, n: r.n, t: Date.now() };
  store.set("national", cache);
  return cache[carbu];
}

async function chargerFlux() {
  const { data } = await fetchJSON(C.OFFICIEL, { retries: 1, timeout: 8000 });
  const d = data?.metas?.default?.data_processed;          // horodatage réellement en UTC
  return d ? new Date(d) : null;
}

/* ---- Enseignes (source tierce, facultative) ---- */
function nettoyerEnseigne(b) {
  if (!b) return null;
  return /sans enseigne/i.test(b) ? "Indépendant" : b;
}
function enseigneDe(id) {
  const e = etat.enseignes[id];
  return e && Date.now() - e.t < C.ENSEIGNES_TTL_J * J ? e : null;
}
function memoriserEnseigne(s) {
  etat.enseignes[String(s.id)] = { b: nettoyerEnseigne(s.Brand?.name), n: s.name ? titreCasse(s.name) : null, t: Date.now() };
}
function sauverEnseignes() {
  const ids = Object.keys(etat.enseignes);
  if (ids.length > C.ENSEIGNES_MAX) {
    ids.sort((a, b) => etat.enseignes[a].t - etat.enseignes[b].t)
       .slice(0, ids.length - C.ENSEIGNES_MAX).forEach(id => delete etat.enseignes[id]);
  }
  store.set("enseignes", etat.enseignes);
}
async function enrichirEnseignes(pos, rayon, ids) {
  const manquants = new Set(ids.filter(id => !enseigneDe(id)));
  if (!manquants.size) { etat.enseignesStatut = "ok"; return false; }
  let modifie = false;
  try {
    for (let p = 0; p < C.ENSEIGNES_PAGES_MAX && manquants.size; p++) {
      const a = p * 20 + 1, b = a + 19;
      const rep = await fetchJSON(`${C.ENSEIGNES}/stations/around/${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`,
        { headers: { Range: `station=${a}-${b}` }, retries: 1, timeout: 8000 });
      const liste = Array.isArray(rep.data) ? rep.data : [];
      for (const s of liste) { memoriserEnseigne(s); manquants.delete(String(s.id)); modifie = true; }
      const total = Number((rep.headers.get("Content-Range") || "").split("/")[1]) || 0;
      const dernier = liste[liste.length - 1];
      if (!liste.length || (total && b >= total) || (dernier && dernier.distance > rayon * 1000)) break;
    }
    etat.enseignesStatut = manquants.size ? "partiel" : "ok";
  } catch (e) {
    etat.enseignesStatut = modifie || ids.some(id => enseigneDe(id)) ? "partiel" : "ko";
  }
  if (modifie) sauverEnseignes();
  return modifie;
}
async function enseigneUnitaire(id) {
  try {
    const { data } = await fetchJSON(`${C.ENSEIGNES}/station/${enc(id)}`, { retries: 1, timeout: 6000 });
    if (data && data.id) { memoriserEnseigne(data); sauverEnseignes(); return enseigneDe(id); }
  } catch (e) { /* source tierce indisponible : on garde l'adresse */ }
  return null;
}

/* ---- Géolocalisation et géocodage ---- */
function localiser() {
  return new Promise((ok, ko) => {
    if (!("geolocation" in navigator)) return ko(new Error("Ce navigateur ne permet pas la géolocalisation. Cherchez autour d'une adresse."));
    navigator.geolocation.getCurrentPosition(
      p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy, source: "gps",
                libelle: `position GPS (± ${p.coords.accuracy < 1000 ? Math.round(p.coords.accuracy) + " m" : km(p.coords.accuracy / 1000) + " km"})` }),
      e => ko(new Error(e.code === 1
        ? "Localisation refusée. Autorisez-la pour ce site dans les réglages du navigateur, ou cherchez autour d'une adresse."
        : "Position introuvable pour le moment. Vérifiez que la localisation de l'appareil est activée, ou cherchez autour d'une adresse.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
  });
}
async function geocoder(q) {
  const { data } = await fetchJSON(`${C.GEOCODAGE}/search?q=${enc(q)}&limit=6&autocomplete=1`, { retries: 1, timeout: 6000 });
  return (data?.features || []).map(f => ({
    lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    libelle: f.properties.label, contexte: f.properties.context, source: "adresse"
  }));
}

/* ================= Persistance du dernier résultat (hors ligne) ================= */
function sauverDernier() {
  const s = etat.brut.map(x => ({ ...x, maj: x.maj?.toISOString() || null, ruptureDebut: x.ruptureDebut?.toISOString() || null }));
  store.set("dernier", { charge: { ...etat.charge, t: etat.charge.t.toISOString() }, brut: s,
    nat: etat.nat, flux: etat.flux?.toISOString() || null });
}
function restaurerDernier() {
  const d = store.get("dernier", null);
  if (!d || !Array.isArray(d.brut)) return false;
  etat.brut = d.brut.map(x => ({ ...x, maj: x.maj ? new Date(x.maj) : null, ruptureDebut: x.ruptureDebut ? new Date(x.ruptureDebut) : null }));
  etat.charge = { ...d.charge, t: new Date(d.charge.t) };
  etat.pos = d.charge.pos; etat.nat = d.nat; etat.flux = d.flux ? new Date(d.flux) : null;
  prefs.carbu = d.charge.carbu;
  prefs.rayon = d.charge.rayon;          // on affiche le rayon réellement couvert par ces données
  return true;
}

/* ================= Analyse ================= */
function coutPlein(s) {
  const kmTrajet = 2 * s.dist * C.COEF_ROUTE;
  return s.prix * prefs.volume + kmTrajet * prefs.conso / 100 * s.prix;
}
function analyser() {
  const now = Date.now(), f = prefs.filtres;
  const tous = etat.brut.filter(s => s.dist <= prefs.rayon + 1e-9);
  const recents7 = tous.filter(s => s.prix != null && s.maj && now - s.maj < 7 * J);
  const medZone = mediane(recents7.map(s => s.prix));
  const refSuspect = etat.nat?.med ?? medZone;
  for (const s of tous) {
    s.ageH = s.maj ? (now - s.maj) / H : Infinity;
    s.ecartZone = s.prix != null && medZone ? s.prix - medZone : null;
    s.ecartNat = s.prix != null && etat.nat ? s.prix - etat.nat.med : null;
    s.suspect = s.prix != null && refSuspect ? Math.abs(s.prix - refSuspect) / refSuspect > C.SUSPECT : false;
    s.ruptureAncienne = s.rupture && s.ruptureDebut ? now - s.ruptureDebut > 7 * J : false;
    s.cout = s.prix != null ? coutPlein(s) : null;
  }
  const fiables = tous.filter(s => s.prix != null && !s.suspect && s.ageH <= C.RECENT_H);
  const reference = fiables.reduce((m, s) => (!m || s.dist < m.dist ? s : m), null);
  for (const s of tous) s.gain = reference && s.cout != null ? reference.cout - s.cout : null;
  const visibles = tous.filter(s =>
    !(f.rupt && s.rupture) &&
    !(f.recent && !s.rupture && s.ageH > C.RECENT_H) &&
    !(f.autoroute && s.autoroute) &&
    !(f.h24 && !s.h24));
  const meilleurPrix = fiables.reduce((m, s) => (!m || s.prix < m.prix || (s.prix === m.prix && s.dist < m.dist) ? s : m), null);
  const meilleurCout = fiables.reduce((m, s) => (!m || s.cout < m.cout ? s : m), null);
  return { tous, visibles, fiables, medZone, n7: recents7.length, reference, meilleurPrix, meilleurCout };
}
function trier(liste) {
  const l = [...liste], inf = Infinity;
  const k = prefs.tri;
  if (k === "prix") l.sort((a, b) => (a.prix ?? inf) - (b.prix ?? inf) || a.dist - b.dist);
  if (k === "cout") l.sort((a, b) => (a.cout ?? inf) - (b.cout ?? inf) || a.dist - b.dist);
  if (k === "dist") l.sort((a, b) => a.dist - b.dist);
  if (k === "maj")  l.sort((a, b) => a.ageH - b.ageH);
  return l;
}

/* ================= Rendu ================= */
function nomStation(s) {
  const e = enseigneDe(s.id);
  return e?.b || e?.n || "Enseigne inconnue";
}
function rendreSource() {
  const morceaux = [];
  morceaux.push(etat.flux ? `Flux officiel rafraîchi ${quand(etat.flux)}` : "Fraîcheur du flux officiel inconnue");
  if (etat.charge) morceaux.push(`données chargées ${quand(etat.charge.t)}`);
  if (etat.pos) morceaux.push(`autour de : ${etat.pos.libelle}`);
  const ens = { ok: "enseignes : 2aaz.fr (source tierce)", partiel: "enseignes partielles (source tierce)",
                ko: "enseignes indisponibles", attente: "enseignes en cours…" }[etat.enseignesStatut];
  morceaux.push(ens);
  $("#source").textContent = morceaux.join(" · ");
}
function bandeau(msg) {
  const b = $("#bandeau");
  if (msg) { b.textContent = msg; b.hidden = false; } else { b.hidden = true; b.textContent = ""; }
}

function rendreSynthese(a) {
  const n = nomCarbu(prefs.carbu);
  const el = $("#synthese");
  if (!a.tous.length) {
    el.innerHTML = `<p>Aucune station ne déclare de ${n} dans un rayon de ${prefs.rayon} km. Augmentez la distance ou changez de carburant.</p>`;
    return;
  }
  let h = "";
  const mp = a.meilleurPrix;
  if (mp) {
    h += `<div class="grand">${euros3(mp.prix)} €</div>
      <p>Meilleur prix ${n} à jour (moins de 72 h) : <b>${echap(nomStation(mp))}</b>, ${echap(mp.ville)}, à ${km(mp.dist)} km — ${quand(mp.maj)}.</p>`;
  } else {
    h += `<p><b>Aucun prix ${n} mis à jour depuis moins de 72 h</b> dans ce rayon. Les prix affichés sont anciens : à vérifier sur place.</p>`;
  }
  const mc = a.meilleurCout, ref = a.reference;
  if (mc && ref) {
    if (mc.id !== ref.id && mc.gain > 0.5) {
      h += `<p class="detour">Pour ${prefs.volume} L, trajet aller-retour compris : <b>${echap(nomStation(mc))}</b> (${echap(mc.ville)}, ${km(mc.dist)} km)
        revient à <b>${euros2(mc.cout)} €</b>, soit <b class="plus">${signeEuros(mc.gain)}</b> d'économie nette par rapport à la station à jour la plus proche
        (${echap(nomStation(ref))}, ${km(ref.dist)} km, ${euros2(ref.cout)} €).</p>`;
    } else {
      h += `<p class="detour">Pour ${prefs.volume} L, le détour ne vaut pas le coup : une fois le trajet compté, la station à jour la plus proche
        (${echap(nomStation(ref))}, ${km(ref.dist)} km) est la plus avantageuse ou à moins de 0,50 € de la meilleure.</p>`;
    }
  }
  h += `<div class="reperes">
    <div><b>${a.medZone ? euros3(a.medZone) + " €" : "—"}</b><span>Médiane de la zone (${a.n7} prix de moins de 7 j)</span></div>
    <div><b>${etat.nat ? euros3(etat.nat.med) + " €" : "—"}</b><span>${etat.nat ? `Médiane nationale (${etat.nat.n.toLocaleString("fr-FR")} stations à jour sur 7 j)` : "Médiane nationale indisponible"}</span></div>
  </div>`;
  const rupt = a.tous.filter(s => s.rupture).length;
  const susp = a.tous.filter(s => s.suspect).length;
  const avecPrix = a.tous.length - rupt;
  h += `<p>${avecPrix} station${avecPrix > 1 ? "s" : ""} avec prix · ${rupt} en rupture déclarée${susp ? ` · ${susp} prix suspect${susp > 1 ? "s" : ""}` : ""}${a.visibles.length < a.tous.length ? ` · ${a.tous.length - a.visibles.length} masquée${a.tous.length - a.visibles.length > 1 ? "s" : ""} par les filtres` : ""}.</p>`;
  el.innerHTML = h;
}

function badgesStation(s) {
  let b = "";
  if (s.rupture) {
    b += `<span class="badge f-rupture">Indisponible</span>déclarée ${quand(s.ruptureDebut)}`;
    if (s.ruptureAncienne) b += ` <span class="badge alerte">Rupture ancienne, statut incertain</span>`;
    return b;
  }
  const f = fiabilite(s.ageH);
  b += `<span class="badge ${f.c}">Fiabilité ${f.t}</span>${quand(s.maj)}`;
  if (s.suspect) b += ` <span class="badge alerte">Prix suspect</span>`;
  return b;
}
function rendreListe(a) {
  const ol = $("#liste");
  if (!a.visibles.length) {
    ol.innerHTML = `<li class="vide">${a.tous.length ? "Aucune station ne correspond aux filtres choisis." : "Aucune station dans ce rayon."}</li>`;
    return;
  }
  ol.innerHTML = trier(a.visibles).map(s => {
    const prix = s.rupture
      ? `<span class="prix rupt">Rupture</span>`
      : `<span class="prix">${euros3(s.prix)}${s.ecartZone != null ? `<small>${centimes(s.ecartZone)} / zone</small>` : ""}</span>`;
    const gain = s.gain != null && a.reference && s.id !== a.reference.id
      ? ` · plein + trajet : <span class="${s.gain >= 0 ? "plus" : "moins"}">${signeEuros(s.gain)}</span>` : "";
    return `<li data-id="${s.id}" tabindex="0">${prix}
      <div class="marque">${echap(nomStation(s))}</div>
      <div class="meta">${echap(s.adresse)}, ${echap(s.ville)} · ${km(s.dist)} km${s.autoroute ? " · autoroute" : ""}${gain}</div>
      <div class="meta">${badgesStation(s)}</div></li>`;
  }).join("");
}

function contenuPopup(s, a) {
  const e = enseigneDe(s.id);
  const titre = e?.b || "Station";
  const nom = e?.n && e.n !== e.b ? `<br><span class="meta">${echap(e.n)}</span>` : "";
  let corps;
  if (s.rupture) {
    corps = `<div class="p" style="color:var(--rupture)">Rupture</div>
      ${nomCarbu(prefs.carbu)} indisponible, déclarée ${quand(s.ruptureDebut)}.
      ${s.ruptureAncienne ? "<br><b>Rupture déclarée il y a plus de 7 jours : la station a peut-être oublié de lever le statut.</b>" : ""}`;
  } else {
    const f = fiabilite(s.ageH);
    corps = `<div class="p">${euros3(s.prix)} €/L</div>
      <span class="badge ${f.c}">Fiabilité ${f.t}</span>prix mis à jour ${quand(s.maj)}
      ${s.suspect ? `<br><b style="color:var(--rupture)">Prix suspect : plus de 20 % d'écart avec la médiane. Erreur de saisie probable.</b>` : ""}
      <table>
        ${s.ecartZone != null ? `<tr><td>Écart à la médiane de la zone</td><td>${centimes(s.ecartZone)}</td></tr>` : ""}
        ${s.ecartNat != null ? `<tr><td>Écart à la médiane nationale</td><td>${centimes(s.ecartNat)}</td></tr>` : ""}
        <tr><td>Plein de ${prefs.volume} L + trajet</td><td>${euros2(s.cout)} €</td></tr>
        ${s.gain != null && a.reference && a.reference.id !== s.id ? `<tr><td>Par rapport à la plus proche à jour</td><td class="${s.gain >= 0 ? "plus" : "moins"}">${signeEuros(s.gain)}</td></tr>` : ""}
      </table>`;
  }
  const dest = `${s.lat},${s.lon}`;
  return `<b>${echap(titre)}</b>${nom}<br>${echap(s.adresse)}, ${echap(s.cp)} ${echap(s.ville)} · ${km(s.dist)} km
    ${s.autoroute ? "<br>Station d'autoroute" : ""}${s.h24 ? "<br>Automate 24 h/24" : ""}
    <div style="margin-top:.5rem">${corps}</div>
    <div class="liens">
      <a href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">Waze</a>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">Google Maps</a>
      <a href="https://maps.apple.com/?daddr=${dest}" target="_blank" rel="noopener">Plans</a>
      <a href="https://www.prix-carburants.gouv.fr/station/${enc(s.id)}" target="_blank" rel="noopener">Fiche officielle</a>
    </div>`;
}

function initCarte() {
  if (etat.carte) return;
  etat.carte = L.map("carte", { zoomControl: true });
  const prix = ' · Prix : <a href="https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/">data.economie.gouv.fr</a>';
  // Fond principal : Plan IGN v2 (Géoplateforme, sans clé). Secours : OpenStreetMap si le service IGN échoue.
  const ign = L.tileLayer("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2" +
    "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}", {
    minZoom: 2, maxZoom: 19, attribution: '&copy; <a href="https://geoservices.ign.fr/">IGN Géoplateforme</a>' + prix
  }).addTo(etat.carte);
  let echecs = 0;
  ign.on("tileerror", () => {
    if (++echecs !== 6) return;
    etat.carte.removeLayer(ign);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' + prix
    }).addTo(etat.carte);
  });
  window.addEventListener("resize", () => etat.carte.invalidateSize());
}
function iconeGrappe(grappe) {
  const enfants = grappe.getAllChildMarkers();
  const prix = enfants.map(m => m.options.prixAffiche).filter(p => p != null);
  const min = prix.length ? Math.min(...prix) : null;
  return L.divIcon({ className: "", iconSize: [0, 0],
    html: `<div class="grappe">${min != null ? "dès " + euros3(min) : "Rupture"}<small>${enfants.length} stations</small></div>` });
}
function rendreCarte(a, recadrer) {
  const c = etat.carte, pos = etat.pos;
  if (etat.grappes) etat.grappes.remove();
  if (etat.cercle) etat.cercle.remove();
  if (etat.moi) etat.moi.remove();
  etat.marqueurs.clear();
  etat.cercle = L.circle([pos.lat, pos.lon], { radius: prefs.rayon * 1000, color: "#475056", weight: 1.5, dashArray: "6 6", fill: false, interactive: false });
  // La vue doit exister avant d'ajouter quoi que ce soit (sinon markercluster échoue au premier rendu)
  if (recadrer || !c._loaded) c.fitBounds(L.latLng(pos.lat, pos.lon).toBounds(prefs.rayon * 2000), { padding: [8, 8] });
  etat.cercle.addTo(c);
  etat.moi = L.marker([pos.lat, pos.lon], { icon: L.divIcon({ className: "", html: '<div class="moi"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    title: "Point de recherche", keyboard: false, zIndexOffset: 2000 }).addTo(c);
  etat.grappes = L.markerClusterGroup({ maxClusterRadius: 50, disableClusteringAtZoom: 13, showCoverageOnHover: false,
    spiderfyOnMaxZoom: true, iconCreateFunction: iconeGrappe });
  const topId = a.meilleurPrix?.id;
  for (const s of a.visibles) {
    const cls = s.rupture ? "f-rupture" : fiabilite(s.ageH).c;
    const txt = s.rupture ? "Rupture" : euros3(s.prix);
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "", iconSize: [0, 0],
        html: `<div class="pin ${cls}${s.suspect ? " suspect" : ""}${s.id === topId ? " top" : ""}">${txt}</div>` }),
      title: `${nomStation(s)}, ${s.ville}`,
      zIndexOffset: s.id === topId ? 1000 : s.rupture ? -500 : 0,
      prixAffiche: s.rupture || s.suspect ? null : s.prix
    });
    m.bindPopup(() => contenuPopup(s, a), { maxWidth: 320 });
    m.on("popupopen", async () => {
      if (!enseigneDe(s.id)) {
        const e = await enseigneUnitaire(s.id);
        if (e && m.isPopupOpen()) m.setPopupContent(contenuPopup(s, a));
      }
    });
    etat.grappes.addLayer(m);
    etat.marqueurs.set(s.id, m);
  }
  c.addLayer(etat.grappes);
}

let derniereAnalyse = null;
function rendre(recadrer = true) {
  initCarte();
  const a = analyser();
  derniereAnalyse = a;
  rendreSynthese(a);
  rendreListe(a);
  rendreCarte(a, recadrer);
  rendreSource();
  synchroniserControles();
}

/* ================= Orchestration ================= */
function memeContexte() {
  const ch = etat.charge;
  return ch && ch.carbu === prefs.carbu && ch.pos && etat.pos &&
         ch.pos.lat === etat.pos.lat && ch.pos.lon === etat.pos.lon && prefs.rayon <= ch.rayon;
}
async function charger({ forcer = false } = {}) {
  if (!etat.pos) return;
  if (!forcer && memeContexte()) { rendre(true); return; }   // simple réduction du rayon : pas de nouvel appel
  const mon = ++etat.jeton;
  const carbu = prefs.carbu, rayon = prefs.rayon, pos = { ...etat.pos };
  $("#source").textContent = `Chargement des prix ${nomCarbu(carbu)} dans un rayon de ${rayon} km…`;
  bandeau(null);
  const [off, nat, flux] = await Promise.allSettled([chargerOfficiel(carbu, pos, rayon), chargerNational(carbu), chargerFlux()]);
  if (mon !== etat.jeton) return;                               // une demande plus récente a pris le relais
  if (off.status === "rejected") {
    const raison = off.reason?.message || "erreur réseau";
    const d = store.get("dernier", null);
    if (d && d.charge?.carbu === carbu && restaurerDernier()) {
      etat.horsLigne = true;
      rendre(true);
      bandeau(`Le flux officiel ne répond pas (${raison}). Affichage des dernières données enregistrées : rayon de ${etat.charge.rayon} km, chargées ${quand(etat.charge.t)}.`);
    } else {
      $("#source").textContent = "Données indisponibles.";
      bandeau(`Le flux officiel des prix ne répond pas (${raison}). Vérifiez votre connexion puis touchez « Actualiser ».`);
    }
    return;
  }
  etat.brut = off.value;
  etat.nat = nat.status === "fulfilled" ? nat.value : null;
  etat.flux = flux.status === "fulfilled" ? flux.value : null;
  etat.charge = { carbu, rayon, pos, t: new Date() };
  etat.horsLigne = false;
  etat.enseignesStatut = "attente";
  sauverDernier();
  rendre(true);
  if (etat.flux && Date.now() - etat.flux > 6 * H) {
    bandeau(`Attention : le flux officiel n'a pas été rafraîchi depuis ${quand(etat.flux)}. Les ruptures récentes peuvent manquer.`);
  } else if (etat.pos.source === "gps" && etat.pos.precision > 3000) {
    bandeau(`Position peu précise (± ${km(etat.pos.precision / 1000)} km). Les distances sont approximatives ; vous pouvez chercher autour d'une adresse.`);
  }
  const modifie = await enrichirEnseignes(pos, rayon, etat.brut.map(s => s.id));
  if (mon !== etat.jeton) return;
  if (modifie) rendre(false); else rendreSource();
}

/* ================= Contrôles ================= */
function remplirCarbus() {
  $("#listeCarbus").innerHTML = CARBUS.map(c => `
    <input type="radio" name="carbu" id="c-${c.k}" value="${c.k}" ${c.k === prefs.carbu ? "checked" : ""}>
    <label for="c-${c.k}"><b>${c.n}</b><span>${c.d}</span></label>`).join("");
  $("#selCarbu").innerHTML = CARBUS.map(c => `<option value="${c.k}">${c.n}</option>`).join("");
}
function synchroniserControles() {
  $("#selCarbu").value = prefs.carbu;
  $("#rayon").value = prefs.rayon; $("#rayonVal").textContent = `${prefs.rayon} km`;
  $("#rayonAccueil").value = prefs.rayon; $("#rayonAccueilVal").textContent = `${prefs.rayon} km`;
  $$(".tri button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tri === prefs.tri)));
  $$("[data-filtre]").forEach(i => { i.checked = !!prefs.filtres[i.dataset.filtre]; });
  const u = new URL(location.href);
  u.searchParams.set("carbu", prefs.carbu); u.searchParams.set("rayon", prefs.rayon);
  history.replaceState(null, "", u);
}
function ouvrirAppli() {
  $("#accueil").hidden = true;
  $("#appli").classList.add("on");
  initCarte();
  setTimeout(() => etat.carte.invalidateSize(), 0);
}
async function demarrerGPS(bouton) {
  const libelle = bouton?.textContent;
  if (bouton) { bouton.disabled = true; bouton.textContent = "Localisation en cours…"; }
  try {
    etat.pos = await localiser();
    ouvrirAppli();
    await charger({ forcer: true });
    return true;
  } catch (e) {
    if ($("#appli").classList.contains("on")) bandeau(e.message);
    else $("#msgAccueil").innerHTML = `<div class="erreur">${echap(e.message)}</div>`;
    return false;
  } finally {
    if (bouton) { bouton.disabled = false; bouton.textContent = libelle; }
  }
}

/* ---- Recherche d'adresse ---- */
let minuteur = null, requeteAdresse = 0;
function ouvrirAdresse() {
  const d = $("#dlgAdresse");
  $("#resultatsAdresse").innerHTML = "";
  $("#champAdresse").value = "";
  d.showModal();
  $("#champAdresse").focus();
}
$("#champAdresse").addEventListener("input", e => {
  clearTimeout(minuteur);
  const q = e.target.value.trim();
  if (q.length < 3) { $("#resultatsAdresse").innerHTML = ""; return; }
  minuteur = setTimeout(async () => {
    const mon = ++requeteAdresse;
    try {
      const res = await geocoder(q);
      if (mon !== requeteAdresse) return;
      $("#resultatsAdresse").innerHTML = res.length
        ? res.map((r, i) => `<li><button type="button" data-i="${i}">${echap(r.libelle)}<br><span class="meta">${echap(r.contexte || "")}</span></button></li>`).join("")
        : `<li class="meta" style="padding:.5rem">Aucune adresse trouvée.</li>`;
      $("#resultatsAdresse").onclick = ev => {
        const b = ev.target.closest("button[data-i]");
        if (!b) return;
        etat.pos = res[+b.dataset.i];
        $("#dlgAdresse").close();
        ouvrirAppli();
        charger({ forcer: true });
      };
    } catch (err) {
      if (mon === requeteAdresse) $("#resultatsAdresse").innerHTML = `<li class="meta" style="padding:.5rem">Service d'adresses indisponible (${echap(err.message)}). Réessayez.</li>`;
    }
  }, 300);
});
$("#fermerAdresse").addEventListener("click", () => $("#dlgAdresse").close());

/* ---- Accueil ---- */
$("#formAccueil").addEventListener("submit", ev => {
  ev.preventDefault();
  prefs.carbu = new FormData(ev.target).get("carbu") || prefs.carbu;
  sauverPrefs();
  demarrerGPS($("#btnGo"));
});
$("#btnAdresseAccueil").addEventListener("click", () => {
  prefs.carbu = new FormData($("#formAccueil")).get("carbu") || prefs.carbu;
  sauverPrefs();
  ouvrirAdresse();
});
$("#rayonAccueil").addEventListener("input", e => {
  prefs.rayon = +e.target.value; $("#rayonAccueilVal").textContent = `${prefs.rayon} km`; sauverPrefs();
});

/* ---- Barre de l'application ---- */
$("#selCarbu").addEventListener("change", e => { prefs.carbu = e.target.value; sauverPrefs(); charger(); });
$("#rayon").addEventListener("input", e => { $("#rayonVal").textContent = `${e.target.value} km`; });
let minuteurRayon = null;
$("#rayon").addEventListener("change", e => {
  prefs.rayon = +e.target.value; sauverPrefs();
  clearTimeout(minuteurRayon);
  minuteurRayon = setTimeout(() => charger(), 150);
});
$("#btnPosition").addEventListener("click", e => demarrerGPS(e.currentTarget));
$("#btnAdresse").addEventListener("click", ouvrirAdresse);
$("#btnMaj").addEventListener("click", () => charger({ forcer: true }));
$("#btnPlein").addEventListener("click", () => {
  $("#volume").value = prefs.volume; $("#conso").value = prefs.conso;
  $("#dlgPlein").showModal();
});
$("#dlgPlein").addEventListener("close", () => {
  if ($("#dlgPlein").returnValue !== "ok") return;
  const v = Number($("#volume").value), c = Number($("#conso").value);
  if (v >= 5 && v <= 150) prefs.volume = v;
  if (c >= 2 && c <= 30) prefs.conso = c;
  sauverPrefs();
  if (etat.brut.length || etat.charge) rendre(false);
});
$$("[data-filtre]").forEach(i => i.addEventListener("change", () => {
  prefs.filtres[i.dataset.filtre] = i.checked; sauverPrefs(); rendre(false);
}));
$$(".tri button").forEach(b => b.addEventListener("click", () => {
  prefs.tri = b.dataset.tri; sauverPrefs(); synchroniserControles();
  if (derniereAnalyse) rendreListe(derniereAnalyse);
}));
function ouvrirStation(li) {
  const m = etat.marqueurs.get(li?.dataset.id);
  if (!m) return;
  etat.grappes.zoomToShowLayer(m, () => m.openPopup());
  if (matchMedia("(max-width:860px)").matches) $("#carte").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#liste").addEventListener("click", e => ouvrirStation(e.target.closest("li[data-id]")));
$("#liste").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ouvrirStation(e.target.closest("li[data-id]")); } });
window.addEventListener("online", () => { if (etat.horsLigne) charger({ forcer: true }); });

/* ================= Démarrage ================= */
(async function demarrer() {
  remplirCarbus();
  synchroniserControles();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (!navigator.onLine && restaurerDernier()) {
    etat.horsLigne = true;
    ouvrirAppli(); rendre(true);
    bandeau(`Hors ligne : affichage des données chargées ${quand(etat.charge.t)}. Le fond de carte peut ne pas s'afficher.`);
    return;
  }
  // Si la localisation a déjà été autorisée, on saute l'accueil
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" });
    if (p && p.state === "granted" && store.get("prefs", null)) await demarrerGPS(null);
  } catch (e) { /* API Permissions absente : on reste sur l'accueil */ }
})();
