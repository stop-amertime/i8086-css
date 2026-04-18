const CACHE_NAME = 'cssdos-cabinets-v1';
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
