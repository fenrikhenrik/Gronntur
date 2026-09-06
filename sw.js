/* Blåtur Istanbul — service worker
   Gjør at appen åpner seg uten dekning.
   Strategi:
     · index.html og data.json → nett først, cache som reserve (så oppdateringer kommer fram)
     · Leaflet, ikon, manifest → cache først (endres aldri)
     · kartfliser → egen cache med tak, så lagringen ikke vokser i det uendelige
   Øk CACHE-navnet hvis du endrer index.html, ellers kan gamle filer henge igjen. */

const CACHE = 'blatur-v16';
const FLISER = 'blatur-fliser-v1';
const MAKS_FLISER = 400;

/* Må ligge i cachen for at appen skal virke offline.
   Feiler én av dem, feiler hele installasjonen — det er med vilje:
   en halvveis installasjon ser vellykket ut og svikter først i Istanbul. */
const KRITISK = [
  './',
  './index.html',
  './manifest.json',
  './ikon.png',
  './data.json'
];

/* Kartbiblioteket. Blokkeres unpkg av et hotellnett, skal appen fortsatt
   installere seg — da mangler bare kartfanen offline. */
const VALGFRITT = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async c => {
        await c.addAll(KRITISK);
        await Promise.allSettled(VALGFRITT.map(u => c.add(u)));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(n => Promise.all(
        n.filter(x => x !== CACHE && x !== FLISER).map(x => caches.delete(x))
      ))
      .then(() => self.clients.claim())
  );
});

/* Holder flis-cachen under taket. Enkel FIFO — eldste nøkkel ryker først. */
async function trimFliser() {
  const c = await caches.open(FLISER);
  const n = await c.keys();
  if (n.length <= MAKS_FLISER) return;
  for (const k of n.slice(0, n.length - MAKS_FLISER)) await c.delete(k);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* Kartfliser: egen cache med tak. Uten tak vokser den med hver panorering. */
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(
      caches.open(FLISER).then(c =>
        c.match(req).then(truffet => truffet || fetch(req).then(r => {
          if (r.ok) { c.put(req, r.clone()).then(trimFliser).catch(() => {}); }
          return r;
        }))
      )
    );
    return;
  }

  /* Værmeldingen skal ALDRI caches. Uten dette unntaket faller den ned i
     cache-først-grenen nederst og viser samme melding resten av turen. */
  if (url.hostname === 'api.open-meteo.com') return;

  const egen = url.origin === self.location.origin;
  const erNavigasjon = req.mode === 'navigate';
  const ferskForst = egen && (
    erNavigasjon ||
    url.pathname.endsWith('data.json') ||
    url.pathname.endsWith('index.html') ||
    url.pathname.endsWith('/')
  );

  if (ferskForst) {
    /* Appen henter data.json?v=<tidsstempel> for å tvinge fram ferske data.
       Cachen nøkles derfor på URL uten spørrestreng — ellers legges det igjen
       en ny kopi hvert 30. sekund, og reserven treffer aldri når nettet er borte. */
    const nokkel = new Request(url.origin + url.pathname);

    e.respondWith(
      fetch(req)
        .then(r => {
          if (r.ok) {
            const kopi = r.clone();
            caches.open(CACHE).then(c => c.put(nokkel, kopi)).catch(() => {});
          }
          return r;
        })
        .catch(() =>
          caches.match(nokkel).then(r => {
            if (r) return r;
            /* Bare navigasjon skal få index.html som reserve. En data.json-
               forespørsel må feile ærlig — ellers får appen HTML med status 200
               og tolker det som gyldig svar. */
            return erNavigasjon ? caches.match('./index.html') : Response.error();
          })
        )
    );
    return;
  }

  /* Alt annet — Leaflet, ikon, manifest: cache først.
     Lagres også ved treff på nett, slik at appen reparerer seg selv hvis
     unpkg var utilgjengelig da service workeren ble installert. */
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(resp => {
      if (resp && (resp.ok || resp.type === 'opaque')) {
        const kopi = resp.clone();
        caches.open(CACHE).then(c => c.put(req, kopi)).catch(() => {});
      }
      return resp;
    }))
  );
});
