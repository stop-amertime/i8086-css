// Cache Storage is the only hop between the build tab and the player tab.
// The player's <link href="/cabinet.css"> is intercepted by sw.js, which
// reads from this cache — both must agree on CACHE_NAME.
//
// Cabinets are ephemeral: purged at build start, on tab unload, and any
// time the service worker notices stale entries from a previous version.
// The bump from v1 → v2 one-time-evicts pre-flat-shape cabinets that
// existing users had lying around.
const CACHE_NAME = 'cssdos-cabinets-v2';
const LEGACY_CACHE_NAMES = ['cssdos-cabinets-v1'];
const CURRENT_URL = '/cabinet.css';

export async function saveCabinet(blob, url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  const response = new Response(blob, {
    headers: { 'Content-Type': 'text/css', 'Content-Length': String(blob.size) },
  });
  await cache.put(url, response);
  return url;
}

export async function hasCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  return hit != null;
}

export async function getCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(url);
}

export async function deleteCabinet(url = CURRENT_URL) {
  const cache = await caches.open(CACHE_NAME);
  return cache.delete(url);
}

/// Wipe every cabinet in every known cache (current + legacy).
/// Call at build start and on page unload so nothing persists beyond
/// the active build→play session.
export async function purgeCabinets() {
  const names = [CACHE_NAME, ...LEGACY_CACHE_NAMES];
  await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
}
