import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { generateReportPDF } from "../src/pdf/report.ts";

test("all four report card layouts produce valid PDFs", async () => {
  for (const template_level of ["nursery", "primary", "o_level", "a_level"]) {
    const bytes = await generateReportPDF({
      report: {
        template_level, class_name: "P.1", term: "Term 1", year: 2026,
        learner_name: "Sample Learner", learner_lin: "S1-001", learner_gender: "F",
        school_name: "APSHULE Demo", school_contact: null, school_location: null,
        term_dates: null, fees: null, class_position: 1, report_theme: "blue",
        class_teacher_name: "Teacher One", headteacher_name: "Head One", principal_name: "Principal One",
      },
      marks: [{
        subject_code: "ENG", subject_name: "English", paper: "P1",
        a1: 80, a2: 75, a3: 90, avg: 81, pct_20: 16, eot: 80,
        pct_80: 65, pct_100: 81, identifier: 2, grade: "A",
        remarks: "Good", descriptor: "Excellent", teacher_initials: "TO",
      }],
      comments: { class_teacher_comment: "Good progress", headteacher_comment: "Keep it up", principal_comment: null },
      projects: [{ project_name: "Research", score: 8, out_of: 10, percentage: 80, grade: "A", remarks: "Strong", teacher_initials: "TO" }],
      gradeScale: [{ grade_code: "A", descriptor: "Excellent" }],
      nurseryAreas: [{ name: "Language", score: 81, remark: "Good" }],
      nurseryActivities: [{ name: "Social interaction", status: "Achieved" }],
    });
    const doc = await PDFDocument.load(bytes);
    assert.ok(bytes.byteLength > 500, `${template_level} PDF has content`);
    assert.equal(doc.getPageCount(), 1, `${template_level} PDF has one page`);
  }
});
