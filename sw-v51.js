// Preserve offline snapshots; activation deletes every other apshule-cache-* namespace.
const CACHE_NAME = "apshule-cache-v51";
const APP_SHELL_URLS = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/idb.js",
    "/offline-data.js",
    "/report-cards-ui.js",
    "/report-card-foundation-ui.js",
    "/teacher-marks-ui.js",
    "/bulk-import-ui.js",
    "/account-profile-ui.js",
    "/retooling-ui.js",
    "/mfi-ui.js",
    "/mfi-loans-ui.js",
    "/mfi-loans-domain.mjs",
    "/mfi-ui.css",
    "/clinic-ui.js",
    "/clinic-ui.css",
    "/settings-ui.js",
    "/settings-ui.css",
    "/video-studio-ui.js",
    "/video-studio-ui.css",
    "/command-center-ui-v3.js",
    "/school-admin-ui-v2.js",
    "/command-center-ui.css",
    "/virtual-lab-ui.js",
    "/virtual-lab-ui.css",
    "/lab-simulators.js",
    "/terms.html",
    "/privacy.html",
    "/terms/",
    "/privacy/",
    "/ai-diagram-renderer.js",
    "/ai-upgrade.html",
    "/clinic-billing-ui.css",
    "/clinic-pharmacy-ui.js",
    "/clinic-billing-ui.js",
    "/clinic-patient-portal-ui.js",
    "/farm-ui.js",
    "/farm-commerce-ui.js",
    "/farm-operations-ui.js",
    "/farm-ui.css"
];
function offlineResponse() {
    return new Response("Offline", { status: 503, statusText: "Service Unavailable", headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function isNoStore(response) { return /\bno-store\b/i.test(response.headers.get("Cache-Control") || ""); }
function isCacheableResponse(response) {
    if (!response || response.status === 206 || isNoStore(response)) return false;
    if ((response.headers.get("Vary") || "").trim() === "*") return false;
    return response.type === "opaque" || response.ok;
}
function isAppShellRequest(url, request) {
    const destinations = new Set(["document", "style", "script", "font", "image", "manifest"]);
    return destinations.has(request.destination) || /\.(?:html?|css|m?js|webmanifest|woff2?|ttf|otf|svg|png|jpe?g|gif|ico)$/i.test(url.pathname);
}
function isExternalVideo(url, request) {
    if (url.origin === self.location.origin) return false;
    const host = url.hostname.toLowerCase();
    const videoHosts = ["youtube.com", "youtube-nocookie.com", "youtu.be", "googlevideo.com", "vimeo.com", "vimeocdn.com"];
    return videoHosts.some(domain => host === domain || host.endsWith(`.${domain}`)) ||
        /\.(?:mp4|m4v|webm|mov|m3u8|mpd)$/i.test(url.pathname) || request.destination === "video";
}
async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, request.mode === "navigate" ? { ignoreSearch: true } : undefined);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (isCacheableResponse(response)) try { await cache.put(request, response.clone()); } catch (error) { console.warn("[SW] cache write failed", error); }
        return response;
    } catch { return offlineResponse(); }
}
async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (isCacheableResponse(response)) try { await cache.put(request, response.clone()); } catch (error) { console.warn("[SW] cache write failed", error); }
        return response;
    } catch { return await cache.match(request) || offlineResponse(); }
}
self.addEventListener("install", event => event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL_URLS);
    await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => /^apshule-cache-/.test(name) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || request.headers.has("range")) return;
    const url = new URL(request.url);
    if (url.pathname.includes("/api/")) { event.respondWith(fetch(request).catch(() => offlineResponse())); return; }
    if (url.origin === self.location.origin) { if (isAppShellRequest(url, request)) event.respondWith(cacheFirst(request)); return; }
    if (isExternalVideo(url, request)) return;
    event.respondWith(networkFirst(request));
});
