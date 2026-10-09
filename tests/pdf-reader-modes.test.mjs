import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../settings-ui.js", import.meta.url), "utf8");
const localeCodes = ["en", "lg", "xog", "nyn", "nyo", "ach", "sw"];
const localeDictionaries = await Promise.all(localeCodes.map(async code =>
  JSON.parse(await readFile(new URL(`../workers/apshule-api/src/i18n/${code}.json`, import.meta.url), "utf8"))
));

test("the reader exposes translated book, spread, zoom, and page controls", () => {
  for (const key of [
    "reader_book_mode",
    "reader_scroll_mode",
    "reader_fit_width",
    "reader_fit_page",
    "reader_actual_size",
    "reader_go_to_page",
    "reader_top",
    "reader_page_of",
    "reader_spread_toggle",
    "reader_single_page",
    "reader_zoom_decrease",
    "reader_zoom_increase",
    "reader_zoom_slider",
    "reader_more_actions",
  ]) {
    assert.match(html, new RegExp(`data-i18n(?:-aria-label)?="${key}"`, "u"));
  }
  assert.match(html, /id="bookReaderModeToggle"/u);
  assert.match(html, /id="bookReaderZoom"/u);
  assert.match(html, /id="bookReaderZoomReset"/u);
  assert.match(html, /id="bookReaderPageJump"/u);
  assert.match(html, /id="bookReaderTop"/u);
  assert.match(html, /id="bookReaderLayoutToggle"/u);
  assert.match(html, /reader_two_page_spread/u);
  assert.match(html, /id="bookReaderZoom" min="10" max="300"/u);
  assert.match(html, /id="bookReaderMoreMenu"/u);
  assert.match(html, /window\.apshuleTranslate\('reader_page_of', fallback, \{ current: currentLabel, total: count \}\)/u);
});

test("Book remains the default, Fit Width is the initial zoom, and manual zoom persists per device", () => {
  assert.match(html, /PDF_READER_MODE_KEY = 'pdf_reader_mode'/u);
  assert.match(html, /PDF_READER_ZOOM_KEY = 'pdf_reader_zoom_mode_v2'/u);
  assert.match(html, /let pdfReaderMode = 'book'/u);
  assert.match(html, /let pdfReaderZoom = 'fit-width'/u);
  assert.match(html, /readPdfReaderSetting\(PDF_READER_MODE_KEY, 'book', \['book', 'scroll'\]\)/u);
  assert.match(html, /readPdfReaderSetting\(PDF_READER_ZOOM_KEY, 'fit-width'/u);
  assert.match(html, /localStorage\.setItem\(PDF_READER_MODE_KEY, pdfReaderMode\)/u);
  assert.match(html, /localStorage\.setItem\(PDF_READER_ZOOM_KEY, nextMode\)/u);
  assert.match(html, /if \(nextMode === 'custom'\) \{\s*localStorage\.setItem\(PDF_READER_ZOOM_LEVEL_KEY, String\(nextLevel\)\)/u);
  assert.match(html, /function setPdfReaderZoomLevelFromScale\(scale\)/u);
  assert.match(html, /id="bookReaderZoomReset"[^>]*reader_zoom_reset/u);
  assert.match(html, /bookReaderZoomReset'\)\?\.addEventListener\('click', \(\) => \{\s*void changePdfReaderZoom\('fit-width'\)/u);
  assert.match(html, /Math\.max\(10, pdfReaderZoomLevel - 10\)/u);
  assert.match(html, /Math\.min\(300, pdfReaderZoomLevel \+ 10\)/u);
  assert.match(html, /function togglePdfReaderMode\(\)/u);
  assert.match(html, /function togglePdfReaderLayout\(\)/u);
  assert.match(html, /let pdfReaderBookLayout = window\.innerWidth < 600 \? 'single' : 'spread'/u);
  assert.match(html, /function jumpToPdfReaderPage\(pageNumber\)/u);
});

test("Scroll mode lazy-renders visible pages and enforces the ten-page canvas cap", () => {
  assert.match(html, /PDF_READER_MAX_RENDERED_SCROLL_PAGES = 10/u);
  assert.match(html, /new IntersectionObserver/u);
  assert.match(html, /pdfScrollObserver\.observe\(state\.element\)/u);
  assert.match(html, /canvas\.width = 0;\s*canvas\.height = 0;\s*canvas\.hidden = true/u);
  assert.match(html, /function trimPdfScrollPages/u);
  assert.match(html, /rootMargin: '700px 0px'/u);
  assert.match(html, /const outputScale = Math\.max\(0\.5, Math\.min\(\s*2,\s*window\.devicePixelRatio/u);
});

test("the reader saves per-document progress and offline page snapshots without replacing PDF fetch paths", () => {
  assert.match(html, /PDF_READER_PROGRESS_PREFIX = 'apshule_pdf_reader_progress_v1:'/u);
  assert.match(html, /function pdfReaderDocumentKey\(pdf\)/u);
  assert.match(html, /parsed\.origin\}\$\{parsed\.pathname/u);
  assert.match(html, /PDF_READER_OFFLINE_TTL_SECONDS = 30 \* 24 \* 60 \* 60/u);
  assert.match(html, /window\.idb\.set\(/u);
  assert.match(html, /window\.idb\?\.get\?\./u);
  assert.match(html, /Offline copy · only pages already saved on this device are available/u);
  assert.match(html, /localStorage\.setItem\(pdfReaderProgressKey\(activePdfReaderDocumentKey\)/u);

  assert.match(html, /isR2DocumentUrl\(directUrl\)\s*\?\s*directUrl\s*:/u);
  assert.match(html, /\/api\/doc-proxy-direct\?url=\$\{encodeURIComponent\(directUrl\)\}/u);
  assert.match(html, /disableRange: false/u);
  assert.match(html, /disableStream: false/u);
  assert.match(html, /disableAutoFetch: false/u);
  assert.match(html, /rangeChunkSize: 65536/u);
  assert.match(html, /appendReaderFileActions\(actions, directUrl/u);
});

test("every supported language has the reader controls and streaming progress keys", () => {
  const keys = [
    "elibrary_title_en",
    "elibrary_title_lg",
    "reader_spread_toggle",
    "reader_single_page",
    "reader_two_page_spread",
    "reader_zoom_decrease",
    "reader_zoom_increase",
    "reader_zoom_slider",
    "reader_more_actions",
    "reader_download_progress",
    "reader_loading_pages",
    "reader_zoom_reset",
  ];
  for (const [index, dictionary] of localeDictionaries.entries()) {
    for (const key of keys) {
      assert.equal(typeof dictionary[key], "string", `${localeCodes[index]} is missing ${key}`);
    }
  }
});

test("dynamic reader labels use the shared translation function and refresh on language changes", () => {
  assert.match(settings, /globalThis\.apshuleTranslate = t/u);
  assert.match(settings, /const t = \(key, fallback, values = \{\}\)/u);
  assert.match(settings, /apshule:language-changed/u);
});

test("page retry, keyboard controls, Book tap zones, swipe navigation, and pinch zoom are wired", () => {
  assert.match(html, /data-pdf-page-retry/u);
  assert.match(html, /reader_page_failed/u);
  assert.match(html, /event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'/u);
  assert.match(html, /\['PageUp', 'PageDown', ' ', 'Spacebar'\]/u);
  assert.match(html, /deltaX < 0 \? 1 : -1/u);
  assert.match(html, /fraction < 0\.3/u);
  assert.match(html, /reader-controls-hidden/u);
  assert.match(html, /enablePdfCanvasPinchZoom\(canvas, container\)/u);
  assert.match(html, /reader_top/u);
});

test("PDF loading uses a 2px non-blocking progress line and a 3-second toast", () => {
  assert.match(html, /id="bookReaderRenderProgress"[^>]*role="progressbar"/u);
  assert.match(html, /\.book-reader-render-progress \{[^}]*height:2px[^}]*background:transparent/su);
  assert.match(html, /id="bookReaderLoadingToast"[^>]*data-i18n="reader_loading_pages"[^>]*hidden/u);
  assert.match(html, /function showPdfReaderLoadingToast\(\)/u);
  assert.match(html, /setTimeout\(\(\) => \{\s*toast\.hidden = true;\s*pdfReaderLoadingToastTimer = null;\s*\}, 3000\)/u);
  assert.match(html, /const downloading = !activePdfOfflineOnly &&\s*pdfReaderLoadProgress\.active &&\s*reader\?\.dataset\.firstPageReady !== 'true'/u);
  assert.match(html, /strip\.hidden = !downloading/u);
  assert.match(html, /loading\.hidden = true;\s*flipbook\.hidden = false;\s*showPdfReaderLoadingToast\(\)/u);
  assert.doesNotMatch(html, /id="bookReaderProgress"/u);
  assert.doesNotMatch(html, /\.book-reader-loading progress/u);
  assert.match(html, /reader\.dataset\.firstPageReady = 'true';\s*pdfReaderLoadProgress\.active = false;\s*updatePdfReaderRenderProgress\(\)/u);
});

test("the service worker advances its cache namespace for the reader update", () => {
  assert.match(sw, /const CACHE_NAME = "apshule-cache-v31"/u);
});
