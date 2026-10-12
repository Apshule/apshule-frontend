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
  report_theme?: string | null;
  class_teacher_name?: string | null;
  headteacher_name?: string | null;
  principal_name?: string | null;
  school_motto?: string | null;
  school_id_code?: string | null;
  school_address?: string | null;
  school_phone?: string | null;
  school_email?: string | null;
  school_website?: string | null;
  brand_color?: string | null;
  next_term_begins_on?: string | null;
  term_ended_on?: string | null;
  report_date?: string | null;
  learner_reg_no?: string | null;
  learner_vcode?: string | null;
  learner_state?: string | null;
  learner_residence?: string | null;
  next_term_fees?: number | null;
  fees_balance?: number | null;
}

export interface ReportProjectPdfRow {
  project_name: string; score: number | null; out_of: number | null;
  percentage: number | null; grade: string | null; remarks: string | null;
  teacher_initials: string | null;
}
export interface ReportNurseryArea { name: string; score: number | null; remark: string | null }
export interface ReportNurseryActivity { name: string; status: string }

export interface ReportMarkPdfRow {
  paper?: string | null;
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
  descriptor?: string | null;
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
  studentPhoto?: ReportImage;
  teacherSignature?: ReportImage;
  projects?: ReportProjectPdfRow[];
  nurseryAreas?: ReportNurseryArea[];
  nurseryActivities?: ReportNurseryActivity[];
  gradeScale?: Array<{ grade_code: string; descriptor: string | null }>;
}

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 30;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.15, 0.16, 0.19);
const MUTED = rgb(0.36, 0.38, 0.43);
function themeAccent(theme?: string | null) {
  if (theme === "blue") return rgb(0x1d / 255, 0x4e / 255, 0xd8 / 255);
  if (theme === "maroon") return rgb(0x7f / 255, 0x1d / 255, 0x1d / 255);
  return rgb(0x4b / 255, 0x2e / 255, 0x9e / 255);
}
function brandAccent(color?: string | null) {
  if (!color || !/^#[0-9a-f]{6}$/iu.test(color)) return rgb(0x4b / 255, 0x2e / 255, 0x9e / 255);
  return rgb(parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255);
}
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
      labels: ["Learning Area", "Score", "Remark"],
      widths: [260, 70, 492],
    };
  }
  if (level === "primary") {
    return {
      labels: ["Subject", "Marks", "Aggr", "Position", "Remarks", "Initials"],
      widths: [190, 80, 65, 75, 310, 62],
    };
  }
  if (level === "o_level") {
    return {
      labels: ["Code", "Subject", "A1", "A2", "A3", "AVG", "20%", "EOT", "80%", "100%", "Ident", "Grade", "Descriptor", "TR"],
      widths: [38, 90, 34, 34, 34, 36, 35, 35, 35, 38, 34, 36, 220, 43],
    };
  }
  return {
    labels: ["Code", "Subject", "Paper", "A1", "A2", "A3", "AVG", "20%", "EOT", "80%", "100%", "Ident", "Grade", "Descriptor", "TR"],
    widths: [35, 83, 37, 30, 30, 30, 32, 32, 32, 32, 34, 32, 32, 230, 36],
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
    color: themeAccent(report.report_theme),
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
    color: themeAccent(report.report_theme),
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
    color: themeAccent(report.report_theme),
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
    return [mark.subject_name, displayNumber(mark.pct_100), mark.remarks ?? ""];
  }
  if (level === "primary") {
    return [
      mark.subject_name,
      displayNumber(mark.pct_100),
      displayNumber(mark.identifier),
      classPosition === null ? "-" : String(classPosition),
      mark.remarks ?? "",
      mark.teacher_initials ?? "",
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
      displayNumber(mark.eot),
      displayNumber(mark.pct_80),
      displayNumber(mark.pct_100),
      displayNumber(mark.identifier),
      mark.grade ?? "",
      mark.descriptor ?? mark.remarks ?? "",
      mark.teacher_initials ?? "",
    ];
  }
  return [
    mark.subject_code ?? "",
    mark.subject_name,
    mark.paper ?? "-",
    displayNumber(mark.a1),
    displayNumber(mark.a2),
    displayNumber(mark.a3),
    displayNumber(mark.avg),
    displayNumber(mark.pct_20),
    displayNumber(mark.eot),
    displayNumber(mark.pct_80),
    displayNumber(mark.pct_100),
    displayNumber(mark.identifier),
    mark.grade ?? "",
    mark.descriptor ?? mark.remarks ?? "",
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
    color: themeAccent(report.report_theme),
  });
  const classComment = comments.class_teacher_comment || "No class teacher comment recorded.";
  const headComment = comments.headteacher_comment || comments.principal_comment || "No headteacher comment recorded.";
  page.drawText(fitText(`${report.class_teacher_name || "Class teacher"}:`, bold, 7.5, 88), { x: MARGIN, y: top - 15, size: 7.5, font: bold, color: themeAccent(report.report_theme) });
  page.drawText(fitText(classComment, font, 7.3, 390), {
    x: MARGIN + 67,
    y: top - 15,
    size: 7.3,
    font,
    color: INK,
  });
  page.drawText(fitText(`${report.headteacher_name || "Headteacher"}:`, bold, 7.5, 88), { x: MARGIN, y: top - 29, size: 7.5, font: bold, color: themeAccent(report.report_theme) });
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
  page.drawText(report.principal_name ? fitText(`Principal: ${report.principal_name}`, font, 7, 150) : "", { x: PAGE_WIDTH - 196, y: 7, size: 7, font, color: MUTED });
}

function drawNurseryActivities(page: PDFPage, font: PDFFont, bold: PDFFont, data: ReportCardPdfData): number {
  const leftX = MARGIN, rightX = 444, top = 444, row = 20;
  page.drawText("LEARNING AREAS", { x:leftX, y:top+13, size:8, font:bold, color:themeAccent(data.report.report_theme) });
  page.drawText("ACTIVITIES", { x:rightX, y:top+13, size:8, font:bold, color:themeAccent(data.report.report_theme) });
  const areas=data.nurseryAreas||[];
  areas.slice(0,5).forEach((a,i)=>{const y=top-i*row;page.drawText(fitText(a.name,font,7.5,200),{x:leftX,y,size:7.5,font,color:INK});page.drawText(displayNumber(a.score),{x:leftX+205,y,size:7.5,font,color:INK});page.drawText(fitText(a.remark||"",font,7,95),{x:leftX+245,y,size:7,font,color:INK});});
  const activities=data.nurseryActivities||[];
  activities.slice(0,10).forEach((a,i)=>{const col=i<5?0:1,ix=i%5;const y=top-ix*row;const x=rightX+col*180;page.drawText(fitText(a.name,font,7,124),{x,y,size:7,font,color:INK});page.drawText(fitText(a.status,font,7,50),{x:x+126,y,size:7,font: bold,color:INK});});
  const total=areas.reduce((n,a)=>n+(Number(a.score)||0),0);
  page.drawText(`Total Score: ${displayNumber(total)}     Position: ${data.report.class_position??"-"}`,{x:leftX,y:top-118,size:8,font:bold,color:themeAccent(data.report.report_theme)});
  return top-140;
}

function drawProjects(page: PDFPage, font: PDFFont, bold: PDFFont, report: ReportCardPdfRow, projects: ReportProjectPdfRow[], y: number): number {
  page.drawText("STUDENT'S PROJECTS WORK",{x:MARGIN,y,size:8,font:bold,color:themeAccent(report.report_theme)});
  const cols=["Termly Project","Average Score(/10)","OUT OF 100","Grade","Remarks","Teacher"];
  const widths=[180,110,90,55,270,77];let x=MARGIN,hy=y-14;
  page.drawRectangle({x:MARGIN,y:hy-4,width:TABLE_WIDTH,height:16,color:themeAccent(report.report_theme)});
  cols.forEach((label,i)=>{page.drawText(fitText(label,bold,6.5,widths[i]-4),{x:x+2,y:hy+1,size:6.5,font:bold,color:rgb(1,1,1)});x+=widths[i];});
  let ry=hy-18;
  if(!projects.length){page.drawText("No projects recorded.",{x:MARGIN+3,y:ry,size:7,font,color:INK});return ry-15;}
  projects.forEach((p,i)=>{const vals=[p.project_name,`${displayNumber(p.score)}/${displayNumber(p.out_of??10)}`,displayNumber(p.percentage),p.grade||"",p.remarks||"",p.teacher_initials||""];let px=MARGIN;vals.forEach((v,j)=>{page.drawText(fitText(v,font,6.5,widths[j]-4),{x:px+2,y:ry,size:6.5,font,color:INK});px+=widths[j];});ry-=15;});
  return ry;
}
function drawGradeScale(page:PDFPage,font:PDFFont,bold:PDFFont,report:ReportCardPdfRow,scale:NonNullable<ReportCardPdfData["gradeScale"]>,y:number):number{
  const text=scale.map(g=>`${g.grade_code}: ${g.descriptor||""}`).join("  |  ");
  page.drawText(fitText(`Grade scale: ${text||"Not configured"}`,font,6.5,TABLE_WIDTH),{x:MARGIN,y,size:6.5,font,color:MUTED});
  return y-13;
}

function drawOLevelTemplate(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  data: ReportCardPdfData,
  logo?: PDFImage,
  studentPhoto?: PDFImage,
): void {
  const report = data.report;
  const accent = brandAccent(report.brand_color);
  const white = rgb(1, 1, 1);
  const dash = "-";
  const headerBottom = PAGE_HEIGHT - 108;
  page.drawRectangle({ x: 0, y: headerBottom, width: PAGE_WIDTH, height: 108, color: accent });
  page.drawRectangle({ x: 22, y: headerBottom + 18, width: 62, height: 70, color: white, borderColor: white, borderWidth: 1 });
  if (logo) drawImage(page, logo, 25, headerBottom + 21, 56, 64);
  else page.drawText("LOGO", { x: 40, y: headerBottom + 49, size: 9, font: bold, color: accent });
  if (studentPhoto) drawImage(page, studentPhoto, PAGE_WIDTH - 82, headerBottom + 21, 56, 64);
  else page.drawRectangle({ x: PAGE_WIDTH - 82, y: headerBottom + 18, width: 60, height: 70, color: white, borderColor: white, borderWidth: 1 });
  const tx = 100;
  const max = PAGE_WIDTH - 205;
  const text = (value: unknown) => pdfSafe(value);
  page.drawText(fitText(text(report.school_name), bold, 17, max), { x: tx, y: PAGE_HEIGHT - 30, size: 17, font: bold, color: white });
  page.drawText(fitText(text(report.school_motto), font, 9, max), { x: tx, y: PAGE_HEIGHT - 46, size: 9, font, color: white });
  page.drawText(fitText(`SCH.ID: ${text(report.school_id_code)} | TEL: ${text(report.school_phone || report.school_contact || "")} | EMAIL: ${text(report.school_email || "")} | ${text(report.school_website || "")}`, font, 7.5, max), { x: tx, y: PAGE_HEIGHT - 61, size: 7.5, font, color: white });
  page.drawText(fitText(text(report.school_address || report.school_location), font, 7.5, max), { x: tx, y: PAGE_HEIGHT - 74, size: 7.5, font, color: white });
  page.drawText(fitText(`${text(report.class_name)} ${text(report.term)} ${text(report.year)} REPORT CARD`, bold, 10, max), { x: tx, y: PAGE_HEIGHT - 94, size: 10, font: bold, color: white });

  const infoTop = headerBottom - 12;
  const infoHeight = 52;
  page.drawRectangle({ x: MARGIN, y: infoTop - infoHeight, width: TABLE_WIDTH, height: infoHeight, color: LIGHT, borderColor: GRID, borderWidth: 0.5 });
  const info = [
    [`Name: ${text(report.learner_name) || dash}`, `Student ID: ${text(report.learner_reg_no || report.learner_lin) || dash}`, `LIN/AMIS No.: ${text(report.learner_lin) || dash}`],
    [`Term: ${text(report.term)} ${text(report.year)}`, `Class: ${text(report.class_name) || dash}`, `Vcode: ${text(report.learner_vcode) || dash}`],
    [`Date: ${text(report.report_date) || dash}`, `State: ${text(report.learner_state) || dash}`, `Residence: ${text(report.learner_residence) || dash}`],
  ];
  const colWidth = TABLE_WIDTH / 3;
  info.forEach((row, ri) => row.forEach((value, ci) => {
    page.drawText(fitText(value, ri === 0 && ci === 0 ? bold : font, 7.4, colWidth - 12), {
      x: MARGIN + 7 + ci * colWidth, y: infoTop - 14 - ri * 15, size: 7.4,
      font: ri === 0 && ci === 0 ? bold : font, color: INK,
    });
  }));

  const labels = ["Subject", "T1", "T2", "T3", "AS", "FA(20)", "EOT(80)", "FINAL(100)", "GRADE", "GRADE DESCRIPTOR", "TR"];
  const widths = [132, 38, 38, 38, 42, 49, 49, 57, 43, 246, 40];
  let y = infoTop - infoHeight - 23;
  const headerY = y;
  page.drawRectangle({ x: MARGIN, y: headerY - 5, width: TABLE_WIDTH, height: 19, color: accent });
  let x = MARGIN;
  labels.forEach((label, i) => {
    page.drawText(fitText(label, bold, 6.4, widths[i]! - 5), { x: x + 2, y: headerY + 1, size: 6.4, font: bold, color: white });
    x += widths[i]!;
  });
  const rows = data.marks.length ? data.marks : [null];
  let total = 0;
  let count = 0;
  let aggregate = 0;
  rows.slice(0, 11).forEach((mark, ri) => {
    y -= 18;
    if (ri % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 4, width: TABLE_WIDTH, height: 18, color: rgb(0.975, 0.972, 0.985) });
    const values = mark ? [
      mark.subject_name, displayNumber(mark.a1), displayNumber(mark.a2), displayNumber(mark.a3),
      displayNumber(mark.avg), displayNumber(mark.pct_20), displayNumber(mark.pct_80),
      displayNumber(mark.pct_100), mark.grade || dash, mark.descriptor || mark.remarks || dash,
      mark.teacher_initials || dash,
    ] : [dash, dash, dash, dash, dash, dash, dash, dash, dash, dash, dash];
    if (mark?.pct_100 != null) { total += Number(mark.pct_100); count += 1; }
    if (mark?.identifier != null) aggregate += Number(mark.identifier);
    let cx = MARGIN;
    values.forEach((value, i) => {
      page.drawText(fitText(value, font, 6.6, widths[i]! - 5), { x: cx + 2, y: y + 2, size: 6.6, font, color: INK });
      cx += widths[i]!;
    });
    page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: PAGE_WIDTH - MARGIN, y: y - 4 }, thickness: 0.3, color: GRID });
  });

  y -= 25;
  page.drawRectangle({ x: MARGIN, y: y - 17, width: TABLE_WIDTH, height: 22, color: LIGHT, borderColor: GRID, borderWidth: 0.5 });
  const average = count ? (total / count).toFixed(1) : dash;
  page.drawText(`OVERALL AVERAGE: ${average}`, { x: MARGIN + 8, y: y - 9, size: 8, font: bold, color: INK });
  page.drawText(`LEVEL OF ACHIEVEMENT: ${data.marks.find(m => m.grade)?.descriptor || data.marks.find(m => m.grade)?.grade || dash}`, { x: MARGIN + 210, y: y - 9, size: 7.6, font: bold, color: INK });
  page.drawText(`RESULT: ${count ? aggregate : dash}`, { x: PAGE_WIDTH - MARGIN - 128, y: y - 9, size: 8, font: bold, color: INK });

  y -= 39;
  page.drawText(`NEXT TERM BEGINS: ${text(report.next_term_begins_on) || dash}     Ends: ${text(report.term_ended_on) || text(report.term_dates) || dash}     Next term fees: UGX ${report.next_term_fees == null ? dash : Number(report.next_term_fees).toLocaleString()}`, { x: MARGIN, y, size: 7.3, font, color: INK });
  y -= 17;
  page.drawText("Class teacher's remarks:", { x: MARGIN, y, size: 7.5, font: bold, color: accent });
  page.drawText(fitText(data.comments.class_teacher_comment || dash, font, 7.2, TABLE_WIDTH - 120), { x: MARGIN + 115, y, size: 7.2, font, color: INK });
  y -= 15;
  page.drawText("Headteacher's remarks:", { x: MARGIN, y, size: 7.5, font: bold, color: accent });
  page.drawText(fitText(data.comments.headteacher_comment || data.comments.principal_comment || dash, font, 7.2, TABLE_WIDTH - 120), { x: MARGIN + 115, y, size: 7.2, font, color: INK });
  y -= 22;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.6, color: accent });
  y -= 13;
  page.drawText(fitText(`Outstanding school fees balance is UGX ${report.fees_balance == null ? dash : Number(report.fees_balance).toLocaleString()} as at ${text(report.report_date) || dash}`, font, 7, TABLE_WIDTH), { x: MARGIN, y, size: 7, font, color: INK });
  y -= 12;
  page.drawText("GRADES: A: 100-80; B: 79-70; C: 69-60; D: 59-40; E: <40", { x: MARGIN, y, size: 6.7, font: bold, color: MUTED });
  page.drawText("T = Topic; EOTi = end of term i", { x: MARGIN + 360, y, size: 6.7, font, color: MUTED });
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
  const studentPhoto = await embedImage(document, data.studentPhoto);

  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  if (data.report.template_level === "o_level") {
    drawOLevelTemplate(page, font, bold, data, logo, studentPhoto);
    return document.save();
  }
  if(data.report.template_level==="nursery"){
    drawHeader(page,font,bold,data.report,logo,false);
    drawNurseryActivities(page,font,bold,data);
    drawFooter(page,font,bold,data.report,data.comments,signature);
    return document.save();
  }
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
  if(data.report.template_level==="a_level"){
    if(y<215){page=document.addPage([PAGE_WIDTH,PAGE_HEIGHT]);drawHeader(page,font,bold,data.report,logo,false);y=PAGE_HEIGHT-150;}
    y=drawProjects(page,font,bold,data.report,data.projects||[],y-4);
    y=drawGradeScale(page,font,bold,data.report,data.gradeScale||[],y-4);
  }
  drawFooter(page, font, bold, data.report, data.comments, signature);
  return document.save();
}