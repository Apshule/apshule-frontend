import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

export interface ReportImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

export interface ReportCardPdfRow {
  template_level: string;
  class_name: string;
  term: string;
  year: number;
  learner_name: string;
  learner_lin: string | null;
  learner_gender: string | null;
  school_name: string;
  school_contact: string | null;
  school_location: string | null;
  term_dates: string | null;
  fees: string | null;
  class_position: number | null;
}

export interface ReportMarkPdfRow {
  subject_code: string | null;
  subject_name: string;
  a1: number | null;
  a2: number | null;
  a3: number | null;
  avg: number | null;
  pct_20: number | null;
  eot: number | null;
  pct_80: number | null;
  pct_100: number | null;
  identifier: number | null;
  grade: string | null;
  remarks: string | null;
  teacher_initials: string | null;
}

export interface ReportCardPdfData {
  report: ReportCardPdfRow;
  marks: ReportMarkPdfRow[];
  comments: {
    class_teacher_comment: string | null;
    headteacher_comment: string | null;
    principal_comment: string | null;
  };
  schoolLogo?: ReportImage;
  teacherSignature?: ReportImage;
}

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 30;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.15, 0.16, 0.19);
const MUTED = rgb(0.36, 0.38, 0.43);
const PURPLE = rgb(0.25, 0.19, 0.49);
const LIGHT = rgb(0.94, 0.93, 0.97);
const GRID = rgb(0.79, 0.78, 0.82);

function pdfSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\x20-\x7e]/gu, "?")
    .replace(/\s+/gu, " ")
    .trim();
}

function fitText(value: unknown, font: PDFFont, size: number, maxWidth: number): string {
  let text = pdfSafe(value);
  if (!text || font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
}

function displayNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toFixed(Number.isInteger(Number(value)) ? 0 : 1);
}

async function embedImage(
  document: PDFDocument,
  image: ReportImage | undefined,
): Promise<PDFImage | undefined> {
  if (!image) return undefined;
  return image.mimeType === "image/png"
    ? document.embedPng(image.bytes)
    : document.embedJpg(image.bytes);
}

function templateColumns(level: string): { labels: string[]; widths: number[] } {
  if (level === "nursery") {
    return {
      labels: ["Area", "Score", "Remark", "Achievement grid"],
      widths: [190, 70, 240, 282],
    };
  }
  if (level === "primary") {
    return {
      labels: ["Code", "Subject", "Marks", "Aggr", "Position", "Remarks", "Gr"],
      widths: [48, 180, 75, 48, 58, 315, 58],
    };
  }
  if (level === "o_level") {
    return {
      labels: ["Code", "Subject", "A1", "A2", "A3", "AVG", "20%", "80%", "100%", "Ident", "Grade", "Remarks", "TR"],
      widths: [45, 100, 38, 38, 38, 40, 40, 40, 45, 42, 42, 230, 44],
    };
  }
  return {
    labels: ["Code", "Subject", "Paper", "A1", "A2", "A3", "AVG", "20%", "EOT", "80%", "100%", "Grade", "Comment", "TR"],
    widths: [42, 105, 45, 32, 32, 32, 36, 36, 36, 36, 40, 39, 233, 38],
  };
}

function drawImage(
  page: PDFPage,
  image: PDFImage | undefined,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): void {
  if (!image) return;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x, y: y + (maxHeight - height) / 2, width, height });
}

function drawHeader(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  report: ReportCardPdfRow,
  logo: PDFImage | undefined,
  includeTable: boolean,
): number {
  drawImage(page, logo, MARGIN, PAGE_HEIGHT - 68, 46, 42);
  page.drawText(fitText(report.school_name, bold, 15, 455), {
    x: MARGIN + 54,
    y: PAGE_HEIGHT - 40,
    size: 15,
    font: bold,
    color: PURPLE,
  });
  const schoolLine = [report.school_contact, report.school_location].filter(Boolean).join(" | ");
  if (schoolLine) {
    page.drawText(fitText(schoolLine, font, 8, 445), {
      x: MARGIN + 54,
      y: PAGE_HEIGHT - 54,
      size: 8,
      font,
      color: MUTED,
    });
  }
  const title =
    report.template_level === "nursery"
      ? "NURSERY REPORT CARD"
      : report.template_level === "primary"
        ? "PRIMARY REPORT CARD"
        : report.template_level === "o_level"
          ? "O-LEVEL CBC REPORT CARD"
          : "A-LEVEL CBC REPORT CARD";
  page.drawText(title, {
    x: PAGE_WIDTH - 280,
    y: PAGE_HEIGHT - 40,
    size: 12,
    font: bold,
    color: PURPLE,
  });

  const infoY = PAGE_HEIGHT - 111;
  page.drawRectangle({
    x: MARGIN,
    y: infoY,
    width: TABLE_WIDTH,
    height: 37,
    color: LIGHT,
    borderColor: GRID,
    borderWidth: 0.5,
  });
  const details = [
    [`Learner: ${report.learner_name}`, 185],
    [`Reg No: ${report.learner_lin ?? "-"}`, 105],
    [`Class: ${report.class_name}`, 90],
    [`Term: ${report.term}`, 115],
    [`Year: ${report.year}`, 58],
    [`Gender: ${report.learner_gender ?? "-"}`, 110],
  ] as const;
  let x = MARGIN + 8;
  for (const [label, width] of details) {
    page.drawText(fitText(label, bold, 8, width - 9), {
      x,
      y: infoY + 14,
      size: 8,
      font: bold,
      color: INK,
    });
    x += width;
  }

  if (!includeTable) return infoY - 15;
  const columns = templateColumns(report.template_level);
  const headerY = infoY - 15;
  page.drawRectangle({
    x: MARGIN,
    y: headerY - 17,
    width: TABLE_WIDTH,
    height: 20,
    color: PURPLE,
  });
  let columnX = MARGIN;
  columns.labels.forEach((label, index) => {
    const width = columns.widths[index] ?? 0;
    page.drawText(fitText(label, bold, 7.2, width - 6), {
      x: columnX + 3,
      y: headerY - 10,
      size: 7.2,
      font: bold,
      color: rgb(1, 1, 1),
    });
    columnX += width;
  });
  return headerY - 25;
}

function markCells(
  level: string,
  mark: ReportMarkPdfRow,
  classPosition: number | null,
): string[] {
  if (level === "nursery") {
    const achievement =
      mark.grade === "A"
        ? "Advanced"
        : mark.grade === "B"
          ? "Achieved"
          : mark.grade === "C"
            ? "Developing"
            : mark.grade === "D"
              ? "Emerging"
              : "Beginning";
    return [mark.subject_name, displayNumber(mark.pct_100), mark.remarks ?? "", achievement];
  }
  if (level === "primary") {
    return [
      mark.subject_code ?? "",
      mark.subject_name,
      displayNumber(mark.pct_100),
      displayNumber(mark.identifier),
      classPosition === null ? "-" : String(classPosition),
      mark.remarks ?? "",
      mark.grade ?? "",
    ];
  }
  if (level === "o_level") {
    return [
      mark.subject_code ?? "",
      mark.subject_name,
      displayNumber(mark.a1),
      displayNumber(mark.a2),
      displayNumber(mark.a3),
      displayNumber(mark.avg),
      displayNumber(mark.pct_20),
      displayNumber(mark.pct_80),
      displayNumber(mark.pct_100),
      displayNumber(mark.identifier),
      mark.grade ?? "",
      mark.remarks ?? "",
      mark.teacher_initials ?? "",
    ];
  }
  return [
    mark.subject_code ?? "",
    mark.subject_name,
    "-",
    displayNumber(mark.a1),
    displayNumber(mark.a2),
    displayNumber(mark.a3),
    displayNumber(mark.avg),
    displayNumber(mark.pct_20),
    displayNumber(mark.eot),
    displayNumber(mark.pct_80),
    displayNumber(mark.pct_100),
    mark.grade ?? "",
    mark.remarks ?? "",
    mark.teacher_initials ?? "",
  ];
}

function drawTableRow(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  report: ReportCardPdfRow,
  mark: ReportMarkPdfRow,
  y: number,
  rowIndex: number,
): void {
  const columns = templateColumns(report.template_level);
  const rowHeight = 19;
  if (rowIndex % 2 === 1) {
    page.drawRectangle({
      x: MARGIN,
      y: y - 5,
      width: TABLE_WIDTH,
      height: rowHeight,
      color: rgb(0.975, 0.972, 0.985),
    });
  }
  const values = markCells(report.template_level, mark, report.class_position);
  let x = MARGIN;
  values.forEach((value, index) => {
    const width = columns.widths[index] ?? 0;
    const fontSize = index === 1 ? 6.7 : 6.5;
    page.drawText(fitText(value, index === 1 ? bold : font, fontSize, width - 6), {
      x: x + 3,
      y: y + 2,
      size: fontSize,
      font: index === 1 ? bold : font,
      color: INK,
    });
    x += width;
  });
  page.drawLine({
    start: { x: MARGIN, y: y - 5 },
    end: { x: MARGIN + TABLE_WIDTH, y: y - 5 },
    thickness: 0.35,
    color: GRID,
  });
}

function drawFooter(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  report: ReportCardPdfRow,
  comments: ReportCardPdfData["comments"],
  signature: PDFImage | undefined,
): void {
  const top = 116;
  page.drawLine({
    start: { x: MARGIN, y: top },
    end: { x: PAGE_WIDTH - MARGIN, y: top },
    thickness: 0.8,
    color: PURPLE,
  });
  const classComment = comments.class_teacher_comment || "No class teacher comment recorded.";
  const headComment = comments.headteacher_comment || comments.principal_comment || "No headteacher comment recorded.";
  page.drawText("Class teacher:", { x: MARGIN, y: top - 15, size: 7.5, font: bold, color: PURPLE });
  page.drawText(fitText(classComment, font, 7.3, 390), {
    x: MARGIN + 67,
    y: top - 15,
    size: 7.3,
    font,
    color: INK,
  });
  page.drawText("Headteacher:", { x: MARGIN, y: top - 29, size: 7.5, font: bold, color: PURPLE });
  page.drawText(fitText(headComment, font, 7.3, 390), {
    x: MARGIN + 67,
    y: top - 29,
    size: 7.3,
    font,
    color: INK,
  });
  page.drawText(`Term dates: ${fitText(report.term_dates || "Not set", font, 7, 245)}`, {
    x: MARGIN,
    y: top - 45,
    size: 7,
    font,
    color: MUTED,
  });
  page.drawText(`Fees: ${fitText(report.fees || "Not set", font, 7, 245)}`, {
    x: MARGIN,
    y: top - 58,
    size: 7,
    font,
    color: MUTED,
  });
  page.drawText("Not valid without official stamp.", {
    x: MARGIN,
    y: 35,
    size: 7,
    font: bold,
    color: MUTED,
  });
  page.drawRectangle({
    x: PAGE_WIDTH - 196,
    y: 31,
    width: 160,
    height: 54,
    borderColor: GRID,
    borderWidth: 0.7,
  });
  page.drawText("Class teacher signature", {
    x: PAGE_WIDTH - 189,
    y: 73,
    size: 6.5,
    font,
    color: MUTED,
  });
  drawImage(page, signature, PAGE_WIDTH - 187, 37, 145, 34);
  page.drawText("Headteacher stamp / signature", {
    x: PAGE_WIDTH - 196,
    y: 18,
    size: 6.5,
    font,
    color: MUTED,
  });
}

export async function generateReportPDF(data: ReportCardPdfData): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`${data.report.learner_name} - ${data.report.term} ${data.report.year} report`);
  document.setAuthor(data.report.school_name);
  document.setSubject(`${data.report.template_level} report card`);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedImage(document, data.schoolLogo);
  const signature = await embedImage(document, data.teacherSignature);

  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = drawHeader(page, font, bold, data.report, logo, true);
  data.marks.forEach((mark, index) => {
    if (y < 142) {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = drawHeader(page, font, bold, data.report, logo, true);
    }
    drawTableRow(page, font, bold, data.report, mark, y, index);
    y -= 19;
  });

  if (y < 205) {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawHeader(page, font, bold, data.report, logo, false);
  }
  drawFooter(page, font, bold, data.report, data.comments, signature);
  return document.save();
}