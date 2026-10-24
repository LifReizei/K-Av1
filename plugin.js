// AnimeAV1 for Kino — v2.3.1
//
// Estructura: V1 (multi-temporada, 48 géneros, 7 tabs, sección completa).
// Detección: v1.6.0 (fallback multi-servidor, verificación de link, UPNShare, AES).
// v2.3.1: opción "auto" en servidor preferido; dub-sub respeta su etiqueta.
//
// Why Voe comes first: MP4Upload sirve AV1 10-bit que muchas TVs Android y
// Fire Sticks no decodifican. Voe re-encodea el mismo episodio a H.264 HLS,
// que todas las TVs leen. MP4Upload queda como fallback (o primero, si el
// usuario lo elige en Configurar).

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SEARCH_PAGES = 3;
const ROW_LIMIT = 20;
const PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------------------------
// Config helper — tolerates both kino.config.get and kino.getSetting

function getConfig(key) {
  if (kino.config && typeof kino.config.get === "function") return kino.config.get(key);
  if (typeof kino.getSetting === "function") return kino.getSetting(key);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// SvelteKit data

function unflatten(flat) {
  const cache = new Map();
  function get(i) {
    if (typeof i !== "number" || i < 0) return undefined;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        cache.set(i, v[1]);
        return v[1];
      }
      const out = [];
      cache.set(i, out);
      for (const x of v) out.push(get(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      cache.set(i, out);
      for (const k of Object.keys(v)) out[k] = get(v[k]);
      return out;
    }
    cache.set(i, v);
    return v;
  }
  return get(0);
}

async function loadData(path, what) {
  const r = await kino.fetch(`${BASE}${path}/__data.json`, {
    headers: { Accept: "application/json" },
  });
  if (r.status === 404) throw kino.error("not_found", `${what}: ${path}`);
  if (r.status === 429) throw kino.error("rate_limited", `${what}: HTTP 429`);
  if (!r.ok) throw kino.error("unavailable", `${what}: HTTP ${r.status}`);
  const body = await r.json();
  if (body.type === "redirect" || body.type === "error") {
    throw kino.error("not_found", `${what}: ${body.type} ${path}`);
  }
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  if (nodes.length === 0) throw kino.error("unavailable", `${what}: empty __data.json`);
  return unflatten(nodes[nodes.length - 1].data);
}

// ---------------------------------------------------------------------------------------------
// Items

function isMovie(media) {
  const c = media.category || {};
  return c.slug === "pelicula" || c.malId === "Movie";
}

function toItem(media) {
  const id = String(media.id);
  const movie = isMovie(media);
  const item = {
    id,
    ref: media.slug,
    title: media.title,
    kind: movie ? "movie" : "series",
    poster: `${CDN}/covers/${id}.jpg`,
    backdrop: `${CDN}/backdrops/${id}.jpg`,
    genres: ["Anime"],
  };
  if (media.synopsis) item.overview = String(media.synopsis).trim();
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) item.year = year;
  return item;
}

async function searchOnce(q) {
  const enc = encodeURIComponent(q).replace(/%20/g, "+");
  const first = await loadSearch(enc, 1);
  const items = [...first.items];
  const pages = Math.min(first.totalPages, SEARCH_PAGES);
  for (let p = 2; p <= pages; p++) {
    try {
      items.push(...(await loadSearch(enc, p)).items);
    } catch (_) {
      break;
    }
  }
  return items;
}

async function loadSearch(enc, page) {
  const r = await kino.fetch(
    `${BASE}/catalogo/__data.json?search=${enc}` + (page > 1 ? `&page=${page}` : ""),
    { headers: { Accept: "application/json" } }
  );
  if (r.status === 429) throw kino.error("rate_limited", "search: HTTP 429");
  if (!r.ok) throw kino.error("unavailable", "search: HTTP " + r.status);
  const body = await r.json();
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = nodes.length ? unflatten(nodes[nodes.length - 1].data) : {};
  return {
    items: (data.results || []).filter((m) => m && m.id != null && m.slug && m.title).map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
  };
}

export async function search(query) {
  const tries = [query.q, query.originalTitle, ...(query.altTitles || [])]
    .map((s) => (s || "").trim())
    .filter((s, i, all) => s && all.indexOf(s) === i);

  for (const q of tries) {
    const items = await searchOnce(q);
    if (items.length === 0) continue;
    const seen = new Set();
    const unique = items.filter((it) => !seen.has(it.id) && seen.add(it.id));
    if (query.type === "movie" || query.type === "series") {
      unique.sort((a, b) => (a.kind === query.type ? 0 : 1) - (b.kind === query.type ? 0 : 1));
    }
    return unique.slice(0, 100);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Episodes

function deriveSeasonAndNumber(e) {
  const orig = Number(e && e.number);
  if (!Number.isInteger(orig) || orig < 1) return null;
  if (e.season) return { season: Number(e.season), number: orig, original: orig };
  if (orig >= 100) {
    const s = Math.floor(orig / 100);
    const n = orig % 100 === 0 ? 100 : orig % 100;
    return { season: s, number: n, original: orig };
  }
  return { season: 1, number: orig, original: orig };
}

function findTargetEpisode(list, seasonNum, episodeNum) {
  if (Number.isInteger(seasonNum) && Number.isInteger(episodeNum)) {
    for (const e of list) {
      const d = deriveSeasonAndNumber(e);
      if (d && d.season === seasonNum && d.number === episodeNum) return e;
    }
  }
  if (Number.isInteger(episodeNum)) {
    for (const e of list) {
      if (Number(e.number) === episodeNum) return e;
    }
  }
  return null;
}

export async function episodes(ref) {
  const slug = String(ref).split("/")[0];
  const data = await loadData(`/media/${slug}`, "episodes");
  const media = data.media;
  if (!media) throw kino.error("not_found", "episodes: no media for " + slug);

  const id = String(media.id);
  const rawEps = (media.episodes || []).filter((e) => deriveSeasonAndNumber(e));
  if (rawEps.length === 0) throw kino.error("not_found", "episodes: none listed for " + slug);

  const series = {
    title: media.title,
    poster: `${CDN}/covers/${id}.jpg`,
    backdrop: `${CDN}/backdrops/${id}.jpg`,
  };
  if (media.synopsis) series.overview = String(media.synopsis).trim();
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) series.year = year;

  const seasonsMap = new Map();
  for (const e of rawEps) {
    const d = deriveSeasonAndNumber(e);
    if (!seasonsMap.has(d.season)) seasonsMap.set(d.season, []);
    seasonsMap.get(d.season).push({
      season: d.season,
      number: d.number,
      originalNumber: d.original,
      ref: `${slug}/${d.season}/${d.number}`,
      title: e.title || `Episodio ${d.number}`,
      overview: e.synopsis || null,
      still: `${CDN}/screenshots/${id}/${d.original}.jpg`,
    });
  }

  const seasons = Array.from(seasonsMap.keys())
    .sort((a, b) => a - b)
    .map((sNum) => ({
      seasonNumber: sNum,
      label: `Temporada ${sNum}`,
      episodes: seasonsMap.get(sNum).sort((a, b) => a.number - b.number),
    }));

  const allEpisodes = [];
  seasons.forEach((s) => allEpisodes.push(...s.episodes));

  return {
    series,
    seasons,
    episodes: allEpisodes,
    totalSeasons: seasons.length,
    totalEpisodes: allEpisodes.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Hosters

function decodeEscapes(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");
}

async function fromMp4Upload(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error("mp4upload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
    html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
    html.match(/<source[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("mp4upload: no video in embed");
  return {
    url: decodeEscapes(m[1]),
    mime: "video/mp4",
    headers: { Referer: "https://www.mp4upload.com/", "User-Agent": BROWSER_UA },
    expiresInSeconds: 3600,
  };
}

function voeDecode(packed) {
  let s = packed.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  for (const junk of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(junk).join("");
  s = atob(s);
  let shifted = "";
  for (let i = 0; i < s.length; i++) shifted += String.fromCharCode(s.charCodeAt(i) - 3);
  return JSON.parse(atob(shifted.split("").reverse().join("")));
}

function voeSourceFrom(html) {
  const packed = html.match(/<script type="application\/json">\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/);
  if (packed) {
    try {
      const data = voeDecode(packed[1]);
      if (data && data.source) return data.source;
    } catch (_) {
      // fall through to the older hls: regex
    }
  }
  const hls = html.match(/["']hls["']\s*:\s*["']([^"']+)["']/);
  if (hls) {
    const v = hls[1];
    if (v.startsWith("http")) return v;
    try { return atob(v); } catch (_) { return null; }
  }
  return null;
}

async function fromVoe(embedUrl) {
  let url = embedUrl;
  for (let hop = 0; hop < 3; hop++) {
    const r = await kino.fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!r.ok) throw new Error("voe HTTP " + r.status);
    const html = await r.text();
    const source = voeSourceFrom(html);
    if (source) {
      await checkHls(source, { "User-Agent": BROWSER_UA });
      return {
        url: source,
        mime: "video/vnd.apple.mpegurl",
        headers: { "User-Agent": BROWSER_UA },
        expiresInSeconds: 3600,
      };
    }
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    url = next[1];
  }
  throw new Error("voe: no source in page");
}

function decodeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[m]));
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch (_) {
    return rel;
  }
}

async function checkVideo(url, headers) {
  const r = await kino.fetch(url, {
    headers: Object.assign({ Range: "bytes=0-1" }, headers),
    timeoutMs: 8000,
  });
  if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
  return r;
}

async function checkHls(url, headers) {
  const get = async (u, h) => {
    const r = await kino.fetch(u, { headers: h, timeoutMs: 8000 });
    if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
    return r;
  };
  const linesOf = (t) => String(t).split("\n").map((l) => l.trim()).filter(Boolean);
  let playlistUrl = url;
  let text = await (await get(playlistUrl, headers)).text();
  if (text.indexOf("#EXTM3U") === -1) throw new Error("not a playlist");
  let lines = linesOf(text);
  if (lines.some((l) => l.indexOf("#EXT-X-STREAM-INF") === 0)) {
    const variant = lines.find((l) => l.charAt(0) !== "#");
    if (!variant) throw new Error("empty master playlist");
    playlistUrl = resolveUrl(playlistUrl, variant);
    text = await (await get(playlistUrl, headers)).text();
    lines = linesOf(text);
  }
  const seg = lines.find((l) => l.charAt(0) !== "#");
  if (!seg) throw new Error("no segments in playlist");
  await get(resolveUrl(playlistUrl, seg), Object.assign({ Range: "bytes=0-1" }, headers));
}

async function fromYourUpload(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("yourupload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/<meta[^>]+og:video["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+og:video["']/i) ||
    html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("yourupload: no video in embed");
  const url = decodeHtml(decodeEscapes(m[1]));
  const headers = { Referer: "https://www.yourupload.com/", "User-Agent": BROWSER_UA };
  await checkVideo(url, headers);
  return { url, mime: "video/mp4", headers, expiresInSeconds: 1800 };
}

async function fromStreamTape(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("streamtape HTTP " + r.status);
  const html = await r.text();
  const re = /getElementById\(\s*['"](?:robotlink|ideoolink|norobotlink)['"]\s*\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]*)['"]\s*\)((?:\s*\.substring\(\s*\d+\s*\))*)/g;
  const links = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    let tail = m[2];
    const cuts = m[3].match(/\d+/g) || [];
    for (let i = 0; i < cuts.length; i++) tail = tail.substring(Number(cuts[i]));
    const head = m[1];
    links.push((head.indexOf("//") === 0 ? "https:" : "") + head + tail);
  }
  if (links.length === 0) throw new Error("streamtape: no link in embed");
  let lastErr;
  for (const link of links.slice(0, 3)) {
    try {
      await checkVideo(link, { "User-Agent": BROWSER_UA });
      return {
        url: link,
        mime: "video/mp4",
        headers: { "User-Agent": BROWSER_UA },
        expiresInSeconds: 900,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("streamtape: no working link");
}

// --- AES-128-CBC decrypt (UPNShare encrypts its /api/v1/video JSON) ----------------------------
const AES_SBOX_HEX = "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
const AES_SBOX = new Uint8Array(256);
const AES_INV = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_SBOX[i] = parseInt(AES_SBOX_HEX.substr(i * 2, 2), 16);
  AES_INV[AES_SBOX[i]] = i;
}
function aesMul(a, b) {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
    b >>= 1;
  }
  return p;
}
const AES_M9 = new Uint8Array(256), AES_M11 = new Uint8Array(256), AES_M13 = new Uint8Array(256), AES_M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_M9[i] = aesMul(i, 9);
  AES_M11[i] = aesMul(i, 11);
  AES_M13[i] = aesMul(i, 13);
  AES_M14[i] = aesMul(i, 14);
}
function aesExpandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const x = t0;
      t0 = AES_SBOX[t1] ^ rcon;
      t1 = AES_SBOX[t2];
      t2 = AES_SBOX[t3];
      t3 = AES_SBOX[x];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function aesDecryptBlock(w, input, out) {
  const s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[160 + i];
  for (let round = 9; round >= 0; round--) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
    for (let i = 0; i < 16; i++) s[i] = AES_INV[t[i]] ^ w[round * 16 + i];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = AES_M14[a0] ^ AES_M11[a1] ^ AES_M13[a2] ^ AES_M9[a3];
        s[c * 4 + 1] = AES_M9[a0] ^ AES_M14[a1] ^ AES_M11[a2] ^ AES_M13[a3];
        s[c * 4 + 2] = AES_M13[a0] ^ AES_M9[a1] ^ AES_M14[a2] ^ AES_M11[a3];
        s[c * 4 + 3] = AES_M11[a0] ^ AES_M13[a1] ^ AES_M9[a2] ^ AES_M14[a3];
      }
    }
  }
  out.set(s);
}
function aesCbcDecryptHex(hex, keyText, ivText) {
  const clean = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 32 !== 0) throw new Error("not AES-CBC hex");
  const data = new Uint8Array(clean.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = parseInt(clean.substr(i * 2, 2), 16);
  const w = aesExpandKey(Uint8Array.from(keyText, (c) => c.charCodeAt(0)));
  let prev = Uint8Array.from(ivText, (c) => c.charCodeAt(0));
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    aesDecryptBlock(w, data.subarray(off, off + 16), block);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev = data.subarray(off, off + 16);
  }
  const pad = out[out.length - 1];
  const end = pad >= 1 && pad <= 16 ? out.length - pad : out.length;
  return new TextDecoder().decode(out.subarray(0, end));
}

const UPN_KEY = "kiemtienmua911ca";
const UPN_IV = "1234567890oiuytr";
async function fromUpnShare(embedUrl) {
  const id = (String(embedUrl).split("#")[1] || "").replace(/^\//, "");
  const om = String(embedUrl).match(/^https?:\/\/[^\/#?]+/);
  if (!id || !om) throw new Error("upnshare: bad embed url");
  const origin = om[0];
  const headers = { Referer: origin + "/", "User-Agent": BROWSER_UA };
  const api = origin + "/api/v1/video?id=" + encodeURIComponent(id) + "&w=1920&h=1080&r=" + encodeURIComponent(BASE + "/");
  const r = await kino.fetch(api, { headers });
  if (!r.ok) throw new Error("upnshare api HTTP " + r.status);
  let info;
  try {
    info = JSON.parse(aesCbcDecryptHex(await r.text(), UPN_KEY, UPN_IV));
  } catch (e) {
    throw new Error("upnshare: cannot read reply (" + (e && e.message) + ")");
  }
  const candidates = [info.cfNative, info.source]
    .filter((s) => typeof s === "string" && s)
    .map((s) => resolveUrl(origin + "/", s));
  if (candidates.length === 0) throw new Error("upnshare: no playlist in reply");
  let lastErr;
  for (const url of candidates) {
    try {
      await checkHls(url, headers);
      return { url, mime: "video/vnd.apple.mpegurl", headers, expiresInSeconds: 900 };
    } catch (e) {
      lastErr = e;
      kino.log("animeav1 upnshare candidate failed:", e && e.message);
    }
  }
  throw lastErr || new Error("upnshare: no playable link");
}

// ---------------------------------------------------------------------------------------------
// Server preference

const SERVER_KEYS = {
  voe: "Voe",
  mp4upload: "MP4Upload",
  yourupload: "YourUpload",
  streamtape: "StreamTape",
  upnshare: "UPNShare",
};
const RESOLVERS = {
  Voe: fromVoe,
  MP4Upload: fromMp4Upload,
  YourUpload: fromYourUpload,
  StreamTape: fromStreamTape,
  UPNShare: fromUpnShare,
};
const DEFAULT_ORDER = ["Voe", "UPNShare", "MP4Upload", "YourUpload", "StreamTape"];

// "auto" (and unset/invalid) uses DEFAULT_ORDER. Any other valid key goes first.
function serverOrder() {
  const pick = String(getConfig("servidor") || "").toLowerCase();
  if (pick === "auto" || !SERVER_KEYS[pick]) return DEFAULT_ORDER;
  const first = SERVER_KEYS[pick];
  return [first].concat(DEFAULT_ORDER.filter((s) => s !== first));
}

// dub-sub label is "Doblado (si no hay, subtitulado)": honor DUB-first, SUB fallback.
function languagesToTry() {
  switch (getConfig("idioma")) {
    case "sub": return ["SUB"];
    case "dub": return ["DUB"];
    case "dub-sub": return ["DUB", "SUB"];
    default: return ["SUB", "DUB"];
  }
}

const RESOLVE_BUDGET_MS = 12000;

function normalizeV1Sources(list) {
  return (list || [])
    .map((s) => ({
      server: SERVER_KEYS[String((s && s.host) || "").toLowerCase()] || null,
      lang: String((s && s.lang) || "sub").toUpperCase(),
      url: s && s.url,
    }))
    .filter((s) => s.server && s.url);
}

function normalizeEmbeds(embeds) {
  const out = [];
  for (const lang of ["SUB", "DUB"]) {
    for (const e of embeds[lang] || []) {
      if (e && e.url && RESOLVERS[e.server]) out.push({ server: e.server, lang, url: e.url });
    }
  }
  return out;
}

async function getSources(slug, media, target) {
  const fromV1 = normalizeV1Sources(target.sources || []);
  if (fromV1.length > 0) return fromV1;
  try {
    const origNum = Number(target.number);
    const epData = await loadData(`/media/${slug}/${origNum}`, "resolve");
    return normalizeEmbeds(epData.embeds || {});
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Resolve

export async function resolve(slug, season, episode) {
  const mediaData = await loadData(`/media/${slug}`, "resolve");
  const media = mediaData.media;
  if (!media) throw kino.error("not_found", "resolve: media not found");

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);

  let target;
  if (Number.isInteger(episodeNum)) {
    target = Number.isInteger(seasonNum)
      ? findTargetEpisode(media.episodes || [], seasonNum, episodeNum)
      : findTargetEpisode(media.episodes || [], 1, episodeNum);
  } else {
    target = (media.episodes || [])[0];
  }
  if (!target) throw kino.error("not_found", "resolve: episode not found");

  const sources = await getSources(slug, media, target);
  if (sources.length === 0) throw kino.error("unavailable", "resolve: no sources for episode");

  const langs = languagesToTry();
  const order = serverOrder();
  const failures = [];
  const started = Date.now();

  for (const lang of langs) {
    const list = sources
      .filter((s) => s.lang === lang && RESOLVERS[s.server])
      .sort((a, b) => order.indexOf(a.server) - order.indexOf(b.server));
    for (const s of list) {
      if (Date.now() - started > RESOLVE_BUDGET_MS) {
        failures.push(`${lang}/${s.server}: out of time`);
        continue;
      }
      try {
        return await RESOLVERS[s.server](s.url);
      } catch (err) {
        failures.push(`${lang}/${s.server}: ${err && err.message}`);
        kino.log("animeav1:", lang, s.server, "failed:", err && err.message);
      }
    }
  }

  if (failures.length === 0) {
    const offered = sources.map((s) => `${s.lang}/${s.server}`).join(", ") || "none";
    throw kino.error("unavailable", `resolve: no ${langs.join("/")} source (offered: ${offered})`);
  }
  throw kino.error("unavailable", failures.join("; "));
}

// ---------------------------------------------------------------------------------------------
// Catalog / rows

const GENEROS = [
  ["accion", "Acción"],
  ["antropomorfico", "Antropomórfico"],
  ["artes-marciales", "Artes Marciales"],
  ["aventura", "Aventura"],
  ["carreras", "Carreras"],
  ["ciencia-ficcion", "Ciencia Ficción"],
  ["comedia", "Comedia"],
  ["deportes", "Deportes"],
  ["detectives", "Detectives"],
  ["drama", "Drama"],
  ["ecchi", "Ecchi"],
  ["elenco-adulto", "Elenco Adulto"],
  ["escolares", "Escolares"],
  ["espacial", "Espacial"],
  ["fantasia", "Fantasía"],
  ["gore", "Gore"],
  ["gourmet", "Gourmet"],
  ["harem", "Harem"],
  ["historico", "Histórico"],
  ["idols-hombre", "Idols (Hombre)"],
  ["idols-mujer", "Idols (Mujer)"],
  ["infantil", "Infantil"],
  ["isekai", "Isekai"],
  ["josei", "Josei"],
  ["juegos-estrategia", "Juegos Estrategia"],
  ["mahou-shoujo", "Mahou Shoujo"],
  ["mecha", "Mecha"],
  ["militar", "Militar"],
  ["misterio", "Misterio"],
  ["mitologia", "Mitología"],
  ["musica", "Música"],
  ["parodia", "Parodia"],
  ["psicologico", "Psicológico"],
  ["recuentos-de-la-vida", "Recuentos de la Vida"],
  ["romance", "Romance"],
  ["samurai", "Samurai"],
  ["seinen", "Seinen"],
  ["shoujo", "Shoujo"],
  ["shoujo-ai", "Shoujo Ai"],
  ["shounen", "Shounen"],
  ["shounen-ai", "Shounen Ai"],
  ["sobrenatural", "Sobrenatural"],
  ["superpoderes", "Superpoderes"],
  ["suspenso", "Suspenso"],
  ["terror", "Terror"],
  ["vampiros", "Vampiros"],
];

const MACRO_GENEROS = {
  "Acción y Aventura": ["accion", "artes-marciales", "aventura", "militar"],
  "Comedia": ["comedia", "parodia"],
  "Drama": ["drama"],
  "Romance": ["romance", "shoujo-ai", "shounen-ai"],
  "Fantasía": ["fantasia", "isekai", "mahou-shoujo", "antropomorfico"],
  "Sci-Fi y Mecha": ["ciencia-ficcion", "espacial", "mecha"],
  "Terror y Suspenso": ["terror", "gore", "psicologico", "suspenso"],
  "Misterio": ["misterio", "detectives"],
  "Slice of Life": ["recuentos-de-la-vida", "escolares", "gourmet"],
  "Deportes": ["deportes", "carreras", "juegos-estrategia"],
  "Histórico": ["historico", "samurai"],
  "Musical e Idol": ["musica", "idols-hombre", "idols-mujer"],
  "Sobrenatural": ["sobrenatural", "mitologia", "superpoderes", "vampiros"],
  "Demografías": ["josei", "seinen", "shoujo", "shounen", "infantil", "elenco-adulto"],
  "Nicho y Adulto": ["ecchi", "harem"],
};

const ORDER_CANDIDATES = ["popular", "popularity", "views", "score", "rating"];
const STATUS_CANDIDATES = ["emision", "en-emision", "airing", "1"];
const MOVIE_CANDIDATES = ["pelicula", "peliculas", "movie"];

async function loadCatalog(params, page) {
  const qs = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .concat(page > 1 ? [`page=${page}`] : [])
    .join("&");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json${qs ? "?" + qs : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw kino.error("rate_limited", "catalog: HTTP 429");
  if (!r.ok) throw kino.error("unavailable", "catalog: HTTP " + r.status);
  const body = await r.json();
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = nodes.length ? unflatten(nodes[nodes.length - 1].data) : {};
  const raw = (data.results || []).filter((m) => m && m.id != null && m.slug && m.title);
  return {
    raw,
    items: raw.map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
    orderKey: data.orderKey,
  };
}

let baselineIds = null;
async function baseline() {
  if (!baselineIds) {
    const b = await loadCatalog({}, 1);
    baselineIds = b.raw.slice(0, 10).map((m) => m.id).join(",");
  }
  return baselineIds;
}

async function pickParams(candidates, extra) {
  const base = await baseline();
  for (const c of candidates) {
    try {
      const p = Object.assign({}, extra, c);
      const res = await loadCatalog(p, 1);
      const ids = res.raw.slice(0, 10).map((m) => m.id).join(",");
      if (res.raw.length > 0 && (ids !== base || (res.orderKey && res.orderKey !== "default"))) {
        return p;
      }
    } catch (e) {
      kino.log("animeav1 probe failed:", JSON.stringify(c), e && e.message);
    }
  }
  return null;
}

async function paramsFor(ref) {
  if (ref === "ord") return pickParams(ORDER_CANDIDATES.map((o) => ({ order: o })));
  if (ref === "emi") return pickParams(STATUS_CANDIDATES.map((s) => ({ status: s })));
  if (ref === "score") return { order: "score" };
  if (ref === "latest") return { order: "latest_added" };
  if (ref === "peli") return pickParams(MOVIE_CANDIDATES.map((c) => ({ category: c })));
  if (ref === "tv") return { category: "tv" };
  if (ref === "ova") return { category: "ova" };
  if (ref === "ona") return { category: "ona" };
  if (ref === "especial") return { category: "especial" };
  if (ref.startsWith("gen:")) return { genre: ref.slice(4) };
  return null;
}

function mediaFromEpisode(e) {
  const m = e && e.media;
  if (!m || m.id == null || !m.slug || !m.title) return null;
  const it = toItem(m);
  if (e.number != null) {
    it.badges = ["EP " + e.number];
    it.backdrop = `${CDN}/screenshots/${it.id}/${e.number}.jpg`;
  }
  return it;
}

let homeCache = null;
async function loadHome() {
  if (!homeCache) homeCache = await loadData("", "home");
  return homeCache;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => !seen.has(it.id) && seen.add(it.id));
}

async function parallelLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

async function buildRow(def) {
  const [id, title, ref, genre] = def;
  let items = [];
  try {
    if (id === "eps") {
      const d = await loadHome();
      items = dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean));
    } else if (id === "serie") {
      const res = await loadCatalog({}, 1);
      items = res.raw.filter((m) => !isMovie(m)).map(toItem);
    } else {
      const p = await paramsFor(ref);
      if (p) items = (await loadCatalog(p, 1)).items;
      if (items.length === 0 && id === "emi") {
        const d = await loadHome();
        items = dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean));
      }
    }
  } catch (e) {
    kino.log("animeav1 row", id, "failed:", e && e.message);
  }
  if (items.length === 0) return null;
  const row = { id, title, items: items.slice(0, ROW_LIMIT) };
  if (id !== "eps") row.ref = ref;
  if (genre) row.genre = genre;
  return row;
}

const backdropOk = new Map();
async function hasBackdrop(it) {
  if (!it.backdrop) return false;
  if (!backdropOk.has(it.backdrop)) {
    backdropOk.set(
      it.backdrop,
      (async () => {
        try {
          const r = await kino.fetch(it.backdrop, { method: "HEAD" });
          return !!r.ok;
        } catch (_) {
          return false;
        }
      })()
    );
  }
  return backdropOk.get(it.backdrop);
}

async function withVerifiedBackdrops(items, n) {
  const head = items.slice(0, n);
  const checks = await Promise.all(head.map(hasBackdrop));
  const good = [];
  const rest = [];
  head.forEach((it, i) => {
    if (checks[i]) good.push(it);
    else {
      const copy = Object.assign({}, it);
      delete copy.backdrop;
      rest.push(copy);
    }
  });
  const out = [...good, ...rest, ...items.slice(n)];
  if (good.length === 0 && out.length > 0 && out[0].poster) out[0].backdrop = out[0].poster;
  return out;
}

export async function home() {
  const defs = [
    ["latest", "Últimos Agregados", "latest", "anime"],
    ["emi", "En emisión", "emi", "anime"],
    ["score", "Mejor Puntuados", "score", "anime"],
    ["eps", "Últimos episodios", "eps", null],
    ["ord", "Populares", "ord", "anime"],
    ["peli", "Películas", "peli", "peliculas"],
    ["serie", "Series", "serie", "series"],
    ...GENEROS.map(([slug, name]) => ["gen-" + slug, name, "gen:" + slug, "anime"]),
  ];
  const rowsRaw = await parallelLimit(defs, 6, buildRow);
  const rows = rowsRaw.filter(Boolean);
  await Promise.all(
    rows.map(async (row, i) => {
      try {
        row.items = await withVerifiedBackdrops(row.items, i === 0 ? 8 : 4);
      } catch (_) {}
    })
  );
  if (rows.length === 0) throw kino.error("unavailable", "home: no rows could be built");
  return rows;
}

const SECTION_TABS = [
  { id: "inicio", label: "Inicio" },
  { id: "tv", label: "TV" },
  { id: "peliculas", label: "Películas" },
  { id: "ovas", label: "OVAs" },
  { id: "onas", label: "ONAs" },
  { id: "especiales", label: "Especiales" },
  { id: "generos", label: "Géneros" },
];

function defsForTab(tab) {
  if (tab === "tv") return [["tv", "TV", "tv", "anime"]];
  if (tab === "peliculas") return [["peli", "Películas", "peli", "peliculas"]];
  if (tab === "ovas") return [["ova", "OVAs", "ova", "anime"]];
  if (tab === "onas") return [["ona", "ONAs", "ona", "anime"]];
  if (tab === "especiales") return [["especial", "Especiales", "especial", "anime"]];
  if (tab === "generos") {
    const rows = [];
    for (const [macroName, slugs] of Object.entries(MACRO_GENEROS)) {
      const mainSlug = slugs[0];
      rows.push(["gen-" + mainSlug, macroName, "gen:" + mainSlug, "anime"]);
    }
    return rows;
  }
  return [
    ["latest", "Últimos Agregados", "latest", "anime"],
    ["emi", "En emisión", "emi", "anime"],
    ["score", "Mejor Puntuados", "score", "anime"],
    ["eps", "Últimos episodios", "eps", null],
    ["ord", "Populares", "ord", "anime"],
  ];
}

export async function section(arg) {
  const wanted = arg && arg.tab ? String(arg.tab) : "inicio";
  const tab = SECTION_TABS.some((t) => t.id === wanted) ? wanted : "inicio";
  const rowsRaw = await parallelLimit(defsForTab(tab), 6, buildRow);
  const rows = rowsRaw.filter(Boolean);
  await Promise.all(
    rows.map(async (row, i) => {
      try {
        row.items = await withVerifiedBackdrops(row.items, i === 0 ? 8 : 4);
      } catch (_) {}
    })
  );
  if (rows.length === 0) throw kino.error("unavailable", "section: no rows for tab " + tab);
  const answer = { tabs: SECTION_TABS, tab, rows };
  const star = (rows[0].items || []).filter((it) => it.backdrop)[0];
  if (star) {
    answer.hero = { title: star.title, image: star.backdrop };
    if (star.overview) answer.hero.text = star.overview.slice(0, 300);
    answer.hero.ref = star.ref;
  }
  return answer;
}

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  ref = String(ref);
  let res;
  if (ref === "eps") {
    const d = await loadHome();
    return { items: dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean)).slice(0, PAGE_LIMIT) };
  }
  if (ref === "serie") {
    res = await loadCatalog({}, page);
    res.items = res.raw.filter((m) => !isMovie(m)).map(toItem);
  } else {
    const p = await paramsFor(ref);
    if (!p) throw kino.error("unavailable", "browse: filter not supported " + ref);
    res = await loadCatalog(p, page);
  }
  return {
    items: dedupe(res.items).slice(0, PAGE_LIMIT),
    next: page < res.totalPages ? String(page + 1) : undefined,
  };
}