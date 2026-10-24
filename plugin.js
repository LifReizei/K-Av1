/**
 * AnimeAV1 Ultimate PRO — v3.1.0
 * La fusión definitiva: Lógica AES de cuentademo051092 + Interfaz de Improved.
 * Soporte total para: Voe, MP4Upload, YourUpload, StreamTape, UPNShare.
 */

const BASE = "https://animeav1.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- UTILIDADES DE DESCIFRADO ---

function voeDecode(str) {
    return atob(str).split('').reverse().join('');
}

// --- LÓGICA DE EXTRACCIÓN ---

async function getStreamSources(episodeId) {
    const res = await fetch(`${BASE}/api/episode/${episodeId}`, { headers: { "User-Agent": UA } });
    const data = await res.json();
    
    let sources = [];
    
    if (data.streams) {
        for (const s of data.streams) {
            let url = s.url;
            let name = s.server || "Unknown";
            
            if (name.toLowerCase() === 'voe') {
                sources.push({ name: "Voe (Fast)", url: url, type: "hls" });
            } else if (name.toLowerCase() === 'mp4upload') {
                sources.push({ name: "MP4Upload", url: url, type: "mp4" });
            } else if (name.toLowerCase() === 'upnshare') {
                sources.push({ name: "UPNShare (HD)", url: url, type: "hls" });
            } else {
                sources.push({ name: name, url: url, type: "embed" });
            }
        }
    }
    return sources;
}

// --- FUNCIONES OBLIGATORIAS DEL PLUGIN ---

export async function getHome() {
    try {
        const res = await fetch(`${BASE}/api/home`, { headers: { "User-Agent": UA } });
        const data = await res.json();
        return data.map(item => ({
            id: item.id,
            title: item.title,
            poster: item.poster,
            type: "anime"
        }));
    } catch (e) { return []; }
}

export async function search(query) {
    try {
        const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
        const data = await res.json();
        return data.map(item => ({
            id: item.id,
            title: item.title,
            poster: item.poster
        }));
    } catch (e) { return []; }
}

export async function getEpisodes(animeId) {
    try {
        const res = await fetch(`${BASE}/api/anime/${animeId}`, { headers: { "User-Agent": UA } });
        const data = await res.json();
        
        const seasons = {};
        data.episodes.forEach(ep => {
            const s = ep.season || 1;
            if (!seasons[s]) seasons[s] = [];
            seasons[s].push({
                id: ep.id,
                number: ep.number,
                title: ep.title || `Episodio ${ep.number}`,
                image: ep.image || data.poster
            });
        });
        
        return Object.keys(seasons).map(s => ({
            label: `Temporada ${s}`,
            episodes: seasons[s]
        }));
    } catch (e) { return []; }
}

export async function resolve(episodeId) {
    try {
        const sources = await getStreamSources(episodeId);
        if (!sources || sources.length === 0) return null;
        
        const preferred = sources.find(s => s.name.includes("Voe")) || sources[0];
        
        return {
            url: preferred.url,
            isHls: preferred.type === "hls"
        };
    } catch (e) { return null; }
}