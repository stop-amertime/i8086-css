// Fetches pre-baked BIOS bytes + metadata from /prebake/*.bin.
// Returns the same shape that builder/stages/bios.mjs::buildBios returns,
// so Kiln can consume either interchangeably.

const KNOWN_FLAVORS = new Set(['muslin', 'gossamer', 'corduroy']);

export async function loadPrebakedBios(flavor, { baseUrl = '/prebake' } = {}) {
  if (!KNOWN_FLAVORS.has(flavor)) {
    throw new Error(`unknown bios flavor: ${flavor}`);
  }
  const binRes = await fetch(`${baseUrl}/${flavor}.bin`);
  if (!binRes.ok) throw new Error(`failed to fetch ${flavor}.bin: ${binRes.status}`);
  const bytes = [...new Uint8Array(await binRes.arrayBuffer())]; // match buildBios' Array<number>

  const metaRes = await fetch(`${baseUrl}/${flavor}.meta.json`);
  if (!metaRes.ok) throw new Error(`failed to fetch ${flavor}.meta.json: ${metaRes.status}`);
  const meta = await metaRes.json();

  return {
    bytes,
    entrySegment: meta.entrySegment,
    entryOffset: meta.entryOffset,
    meta,
  };
}

export async function loadPrebakeManifest({ baseUrl = '/prebake' } = {}) {
  const res = await fetch(`${baseUrl}/manifest.json`);
  if (!res.ok) throw new Error(`failed to fetch manifest: ${res.status}`);
  return res.json();
}
