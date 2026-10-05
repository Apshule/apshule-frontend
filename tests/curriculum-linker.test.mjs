import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function sourceFunction(name, parameters) {
  const source = html.match(
    new RegExp(`^    function ${name}\\(${parameters}\\) \\{[\\s\\S]*?^    \\}`, "mu"),
  )?.[0];
  assert.ok(source, `${name} should exist in index.html`);
  return source;
}

const validator = sourceFunction("teacherCurriculumHttpsUrl", "value");
const topicTitle = sourceFunction("teacherCurriculumTopicTitle", "link");
const resourceLink = sourceFunction(
  "teacherCurriculumResourceLinkMarkup",
  "link, field, label, title",
);
const context = vm.createContext({
  URL,
  escapeHtml: value => String(value).replace(/[&<>"]/gu, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  })[character]),
});
vm.runInContext(
  `${validator}\n${topicTitle}\n${resourceLink}\nglobalThis.validateUrl = teacherCurriculumHttpsUrl;\nglobalThis.topicTitle = teacherCurriculumTopicTitle;\nglobalThis.renderResourceLink = teacherCurriculumResourceLinkMarkup;`,
  context,
);

test("teacher Curriculum Linker accepts trimmed HTTPS URLs only", () => {
  assert.equal(
    context.validateUrl("  https://ncdc.go.ug/books/agriculture.pdf \n"),
    "https://ncdc.go.ug/books/agriculture.pdf",
  );
  assert.equal(context.validateUrl("http://ncdc.go.ug/book.pdf"), null);
  assert.equal(context.validateUrl("javascript:alert(1)"), null);
  assert.equal(context.validateUrl("https://"), null);
  assert.equal(context.validateUrl(null), null);
});

test("topic labels use topic, legacy title/name, then the record ID", () => {
  assert.equal(
    context.topicTitle({ topic: "Photosynthesis", title: "Old title", name: "Name", id: "abc123" }),
    "Photosynthesis",
  );
  assert.equal(
    context.topicTitle({ topic: " ", title: "Legacy title", name: "Name", id: "abc123" }),
    "Legacy title",
  );
  assert.equal(
    context.topicTitle({ topic: null, title: null, name: "Legacy name", id: "abc123" }),
    "Legacy name",
  );
  assert.equal(
    context.topicTitle({ topic: null, title: null, name: null, id: "abc12345" }),
    "Topic #abc123",
  );
});

test("valid curriculum URLs render real anchors and a copyable fallback", () => {
  const url = "https://ncdc.go.ug/books/agriculture.pdf?download=1&course=al";
  const markup = context.renderResourceLink(
    { syllabus_url: ` ${url} ` },
    "syllabus_url",
    "📖 Open Syllabus",
    "Syllabus",
  );

  assert.equal((markup.match(/<a\b/gu) || []).length, 2);
  assert.match(
    markup,
    /<a class="teacher-primary teacher-primary-link" href="https:\/\/ncdc\.go\.ug\/books\/agriculture\.pdf\?download=1&amp;course=al" target="_blank" rel="noopener noreferrer"/u,
  );
  assert.match(markup, /If the book doesn't open, copy this link:/u);
  assert.match(markup, /data-curriculum-open="syllabus_url"/u);
  assert.doesNotMatch(markup, /Not linked/u);
});

test("missing and insecure curriculum URLs ask the teacher to contact an admin", () => {
  for (const value of [null, "http://ncdc.go.ug/book.pdf", "javascript:alert(1)"]) {
    const markup = context.renderResourceLink(
      { learner_book_url: value },
      "learner_book_url",
      "📗 Open Learner Book",
      "Learner Book",
    );
    assert.match(markup, /Not linked yet — ask admin/u);
    assert.doesNotMatch(markup, /<a\b/u);
  }
});

test("Curriculum Linker opens documents in the reader and keeps direct-link fallbacks", () => {
  const rendererStart = html.indexOf("function renderTeacherCurriculumDetail()");
  const rendererEnd = html.indexOf(
    "\n    async function toggleTeacherCurriculumFavorite",
    rendererStart,
  );
  assert.notEqual(rendererStart, -1);
  assert.notEqual(rendererEnd, -1);
  const renderer = html.slice(rendererStart, rendererEnd);

  const handlerStart = html.indexOf(
    'document.getElementById("teacherCurriculumDetail")?.addEventListener("click"',
  );
  const handlerEnd = html.indexOf(
    '\n\n        window.addEventListener("offline"',
    handlerStart,
  );
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = html.slice(handlerStart, handlerEnd);

  const renderedFields = [...renderer.matchAll(/teacherCurriculumResourceLinkMarkup\(link, "([^"]+)"/gu)]
    .map((match) => match[1])
    .sort();
  const mapping = handler.match(
    /const urlField = \{([\s\S]*?)\n\s+\}\[openLink\.dataset\.curriculumOpen\];/u,
  )?.[1];
  assert.ok(mapping, "the click handler should whitelist the link fields");
  const handledFields = [...mapping.matchAll(/^\s*([a-z_]+):/gmu)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(renderedFields, [
    "learner_book_url",
    "syllabus_url",
    "teacher_guide_url",
  ]);
  assert.deepEqual(handledFields, renderedFields);
  assert.match(handler, /if \(url\) console\.log\("\[linker\] opening", url\)/u);
  assert.match(handler, /openLink\.hasAttribute\("data-curriculum-reader"\)/u);
  assert.match(handler, /event\.preventDefault\(\)/u);
  assert.match(handler, /openBookReader\(\{/u);
  assert.doesNotMatch(handler, /window\.open|window\.location/u);
  assert.match(resourceLink, /data-curriculum-reader/u);
  assert.match(resourceLink, /If the book doesn't open, copy this link:/u);
  assert.match(renderer, /teacherCurriculumTopicTitle\(link\)/u);
});

test("document reader uses Microsoft viewer, authenticated downloads, and viewer fallbacks", () => {
  const reader = html.match(
    /^    async function openBookReader\(pdf\) \{[\s\S]*?^    \}/mu,
  )?.[0];
  assert.ok(reader, "openBookReader should exist in index.html");
  const officeViewer = sourceFunction("appendMicrosoftOfficeViewer", "container, url, title");
  const fileActions = sourceFunction("appendReaderFileActions", "container, url, title");
  const viewerFallback = sourceFunction("renderViewerWithFallback", "container, url");
  const blobFetcher = html.match(
    /^    async function fetchReaderDocumentBlob\(url\) \{[\s\S]*?^    \}/mu,
  )?.[0];
  assert.ok(blobFetcher, "fetchReaderDocumentBlob should exist in index.html");
  assert.match(reader, /\/api\/detect-doc-kind/u);
  assert.match(reader, /\/api\/doc-proxy/u);
  assert.match(reader, /appendReaderFileActions\(actions, directUrl/u);
  assert.match(officeViewer, /view\.officeapps\.live\.com\/op\/embed\.aspx/u);
  assert.doesNotMatch(html, /docs\.google\.com\/gview/u);
  assert.match(fileActions, /link\.download = fileName/u);
  assert.match(fileActions, /Preparing your file/u);
  assert.match(fileActions, /Open original link/u);
  assert.match(blobFetcher, /\/api\/doc-proxy/u);
  assert.match(viewerFallback, /This is an external viewer page\. It will open in a new tab\./u);
  assert.match(viewerFallback, /book-reader-open-page/u);
  assert.match(reader, /kind === 'pdf'/u);
  assert.match(reader, /kind === 'image'/u);
  assert.match(reader, /\['document', 'spreadsheet', 'presentation'\]\.includes\(kind\)/u);
  assert.match(reader, /kind === 'video' \|\| kind === 'audio'/u);
  assert.match(reader, /kind === 'other'/u);
  assert.match(reader, /A preview is not available for this link/u);
  assert.match(reader, /kind === 'text'/u);
  assert.match(reader, /kind === 'viewer'/u);
  assert.match(reader, /renderViewerWithFallback\(media, directUrl\)/u);
});

test("the service worker uses cache v7 and claims clients on activation", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /const CACHE_NAME = "apshule-cache-v7"/u);
  assert.match(sw, /await self\.clients\.claim\(\)/u);
});
