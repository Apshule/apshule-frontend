import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../settings-ui.js", import.meta.url), "utf8");

test("the reader exposes the requested translated modes, zoom presets, and page controls", () => {
  for (const key of [
    "reader_book_mode",
    "reader_scroll_mode",
    "reader_fit_width",
    "reader_fit_page",
    "reader_actual_size",
    "reader_go_to_page",
    "reader_top",
    "reader_page_of",
  ]) {
    assert.match(html, new RegExp(`data-i18n(?:-aria-label)?="${key}"`, "u"));
  }
  assert.match(html, /id="bookReaderModeToggle"/u);
  assert.match(html, /id="bookReaderZoom"/u);
  assert.match(html, /id="bookReaderPageJump"/u);
  assert.match(html, /id="bookReaderTop"/u);
  assert.match(html, /apshuleTranslate\('reader_page_of', fallback, \{ current, total: count \}\)/u);
});

test("Book remains the default, and mode and zoom preferences persist", () => {
  assert.match(html, /PDF_READER_MODE_KEY = 'pdf_reader_mode'/u);
  assert.match(html, /PDF_READER_ZOOM_KEY = 'pdf_reader_zoom'/u);
  assert.match(html, /let pdfReaderMode = 'book'/u);
  assert.match(html, /readPdfReaderSetting\(PDF_READER_MODE_KEY, 'book', \['book', 'scroll'\]\)/u);
  assert.match(html, /localStorage\.setItem\(PDF_READER_MODE_KEY, pdfReaderMode\)/u);
  assert.match(html, /localStorage\.setItem\(PDF_READER_ZOOM_KEY, zoom\)/u);
  assert.match(html, /function togglePdfReaderMode\(\)/u);
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
  assert.match(html, /rangeChunkSize: 65536/u);
  assert.match(html, /appendReaderFileActions\(actions, directUrl/u);
});

test("dynamic reader labels use the shared translation function and refresh on language changes", () => {
  assert.match(settings, /globalThis\.apshuleTranslate = t/u);
  assert.match(settings, /const t = \(key, fallback, values = \{\}\)/u);
  assert.match(settings, /apshule:language-changed/u);
});

test("page retry, mode-specific keyboard controls, Book swipes, and double-tap zoom are wired", () => {
  assert.match(html, /data-pdf-page-retry/u);
  assert.match(html, /reader_page_failed/u);
  assert.match(html, /event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'/u);
  assert.match(html, /\['PageUp', 'PageDown', ' ', 'Spacebar'\]/u);
  assert.match(html, /deltaX < 0 \? 1 : -1/u);
  assert.match(html, /now - pdfScrollLastTapAt < 320/u);
  assert.match(html, /reader_top/u);
});

test("the service worker advances its cache namespace for the reader update", () => {
  assert.match(sw, /const CACHE_NAME = "apshule-cache-v29"/u);
});
