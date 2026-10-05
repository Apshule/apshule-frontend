import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("teacher Curriculum Linker accepts trimmed HTTPS URLs only", () => {
  const helper = html.match(
    /^    function teacherCurriculumHttpsUrl\(value\) \{[\s\S]*?^    \}/mu,
  )?.[0];
  assert.ok(helper, "the teacher URL validator should exist in index.html");

  const context = vm.createContext({ URL });
  vm.runInContext(`${helper}\nglobalThis.validateUrl = teacherCurriculumHttpsUrl;`, context);

  assert.equal(
    context.validateUrl("  https://ncdc.go.ug/books/agriculture.pdf \n"),
    "https://ncdc.go.ug/books/agriculture.pdf",
  );
  assert.equal(context.validateUrl("http://ncdc.go.ug/book.pdf"), null);
  assert.equal(context.validateUrl("javascript:alert(1)"), null);
  assert.equal(context.validateUrl("https://"), null);
  assert.equal(context.validateUrl(null), null);
});

test("Curriculum Linker buttons and click handler use the same URL fields", () => {
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

  const renderedFields = [...renderer.matchAll(/openButton\("([^"]+)"/gu)]
    .map((match) => match[1])
    .sort();
  const mapping = handler.match(
    /const urlField = \{([\s\S]*?)\n\s+\}\[openButton\.dataset\.curriculumOpen\];/u,
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
  assert.match(handler, /window\.open\(url, "_blank"\)/u);
  assert.match(handler, /else window\.location\.href = url/u);
  assert.match(handler, /console\.log\("\[linker\] opening", url\)/u);
});
