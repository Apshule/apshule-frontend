const $ = (id) => document.getElementById(id);

const REPORT_CLASS_NAMES = {
  baby: "Nursery",
  babyclass: "Nursery",
  middle: "Nursery",
  middleclass: "Nursery",
  top: "Nursery",
  topclass: "Nursery",
};

function templateForClass(className) {
  const normalized = String(className || "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
  if (Object.hasOwn(REPORT_CLASS_NAMES, normalized)) return "nursery";
  if (/^(?:p|primary)[1-7]$/u.test(normalized)) return "primary";
  if (/^(?:s|senior|secondary)[1-6]$/u.test(normalized)) {
    return Number(normalized.match(/\d+$/u)?.[0]) >= 5 ? "a_level" : "o_level";
  }
  return null;
}

function templateLabel(level) {
  return ({
    nursery: "Nursery",
    primary: "Primary",
    o_level: "O-Level CBC",
    a_level: "A-Level CBC",
  })[level] || "Unsupported";
}

function currentAcademicTerm() {
  const month = new Date().getUTCMonth() + 1;
  return month <= 4 ? "Term One" : month <= 8 ? "Term Two" : "Term Three";
}

function currentAcademicYear() {
  return new Date().getUTCFullYear();
}

function setSelectOptions(select, values, placeholder, selectedValue = "") {
  if (!select) return;
  select.replaceChildren();
  if (placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }
  for (const item of values) {
    const option = document.createElement("option");
    option.value = typeof item === "string" ? item : item.value;
    option.textContent = typeof item === "string" ? item : item.label;
    select.append(option);
  }
  if (selectedValue && [...select.options].some((option) => option.value === selectedValue)) {
    select.value = selectedValue;
  }
}

function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function safeFilename(value) {
  return String(value || "report-card")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120) || "report-card";
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = (checksum >>> 8) ^ CRC32_TABLE[(checksum ^ byte) & 0xff];
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export async function createReportArchive(entries) {
  if (entries.length > 0xffff) throw new Error("A ZIP archive cannot contain more than 65,535 files.");

  const encoder = new TextEncoder();
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const fileBytes = entry.blob instanceof Blob
      ? new Uint8Array(await entry.blob.arrayBuffer())
      : entry.blob instanceof Uint8Array
        ? entry.blob
        : new Uint8Array(entry.blob);
    if (nameBytes.length > 0xffff || fileBytes.length > 0xffffffff || localOffset > 0xffffffff) {
      throw new Error("A report file is too large to add to the ZIP archive.");
    }
    const checksum = crc32(fileBytes);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, fileBytes.length, true);
    localView.setUint32(22, fileBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localRecords.push(localHeader, nameBytes, fileBytes);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, fileBytes.length, true);
    centralView.setUint32(24, fileBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralRecords.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + fileBytes.length;
  }

  const centralSize = centralRecords.reduce((size, part) => size + part.length, 0);
  if (localOffset > 0xffffffff || centralSize > 0xffffffff) {
    throw new Error("The report-card ZIP archive is too large to create.");
  }
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...localRecords, ...centralRecords, endRecord], { type: "application/zip" });
}

export function initReportCardUI({ api, getCurrentUser, getToken, apiBase, notify, escapeHtml }) {
  const safe = (value) => escapeHtml
    ? escapeHtml(String(value ?? ""))
    : String(value ?? "").replace(/[&<>"']/gu, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);

  const state = {
    user: null,
    mode: null,
    activeCardId: null,
    activeDetail: null,
    schoolLearners: [],
    workspaceLearners: [],
    studentCards: [],
    loadedUserId: null,
    uploadedSignature: null,
    hasSignatureInk: false,
  };

  const root = $("reportCardsWorkspace");
  const listView = $("rcListView");
  const editorView = $("rcEditorView");
  const previewView = $("rcPreviewView");
  const workspaceStatus = $("rcWorkspaceStatus");
  const schoolStatus = $("schoolReportStatus");
  const canvas = $("rcSignatureCanvas");
  const canvasContext = canvas?.getContext("2d");

  function setStatus(element, message = "", kind = "") {
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("is-error", kind === "error");
    element.classList.toggle("is-success", kind === "success");
  }

  function tell(message, kind = "success") {
    if (typeof notify === "function") notify(message, kind);
  }

  function apiList(response, key) {
    if (Array.isArray(response)) return response;
    return Array.isArray(response?.[key]) ? response[key] : [];
  }

  function queryString(entries) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }

  async function downloadResponse(path) {
    const headers = {};
    const token = getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${apiBase}${path}`, { headers, cache: "no-store" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = typeof payload.error === "string"
        ? payload.error
        : payload.message || response.statusText || "The PDF could not be downloaded.";
      throw new Error(message);
    }
    return response.blob();
  }

  function showWorkspace(mode) {
    state.mode = mode;
    state.activeCardId = null;
    state.activeDetail = null;
    root.hidden = false;
    document.body.classList.add("report-workspace-open");
    listView.hidden = false;
    editorView.hidden = true;
    previewView.hidden = true;
    $("rcWorkspaceTitle").textContent = mode === "student" ? "My Report Cards" : "Report Cards";
    $("rcWorkspaceEyebrow").textContent = mode === "teacher"
      ? "Teacher workspace"
      : mode === "school"
        ? "School administration"
        : "Learner workspace";
    $("rcListHeading").textContent = mode === "student" ? "Published report cards" : "Assigned report cards";
    $("rcListHint").textContent = mode === "teacher"
      ? "Open a card to enter marks, save comments, and add your signature."
      : mode === "student"
        ? "Preview reports as often as you like. Each published PDF can be downloaded once."
        : "Choose a class and term to load report cards.";
    $("rcStatusFilter").closest(".rc-field").hidden = mode === "student";
    $("rcClassFilter").closest(".rc-field").hidden = mode === "student";
    $("rcTermFilter").closest(".rc-field").hidden = mode === "student";
    $("rcYearFilter").closest(".rc-field").hidden = mode === "student";
    $("rcLoadCards").hidden = mode === "student";
    $("rcWorkspaceRefresh").hidden = false;
    setStatus(workspaceStatus, "");
    $("rcWorkspaceClose").focus();
  }

  function closeWorkspace() {
    root.hidden = true;
    document.body.classList.remove("report-workspace-open");
    state.mode = null;
    state.activeCardId = null;
    state.activeDetail = null;
    setStatus(workspaceStatus, "");
  }

  function fillDefaultFilters() {
    $("rcTermFilter").value = currentAcademicTerm();
    $("rcYearFilter").value = String(currentAcademicYear());
    $("schoolReportTerm").value = currentAcademicTerm();
    $("schoolReportYear").value = String(currentAcademicYear());
  }

  async function loadSchoolLearners() {
    setStatus(schoolStatus, "Loading school learners…");
    const response = await api("/api/report-cards/learners");
    state.schoolLearners = apiList(response, "learners")
      .filter((learner) => learner.class_level && templateForClass(learner.class_level));
    const classes = [...new Set(state.schoolLearners.map((learner) => learner.class_level))]
      .sort((left, right) => left.localeCompare(right));
    const priorClass = $("schoolReportClass").value;
    setSelectOptions(
      $("schoolReportClass"),
      classes.map((className) => ({ value: className, label: `${className} · ${templateLabel(templateForClass(className))}` })),
      "Select class",
      priorClass,
    );
    await updateSchoolLearnersForClass();
    setStatus(schoolStatus, classes.length ? "" : "No supported report-card classes or learners were found.");
  }

  async function updateSchoolLearnersForClass() {
    const className = $("schoolReportClass").value;
    const learners = state.schoolLearners.filter((learner) => learner.class_level === className);
    setSelectOptions(
      $("schoolReportLearner"),
      learners.map((learner) => ({
        value: learner.id,
        label: `${learner.name}${learner.lin ? ` · ${learner.lin}` : ""}`,
      })),
      learners.length ? "Select learner" : "No learners in this class",
    );
    $("schoolReportTemplate").textContent = `Template: ${className ? templateLabel(templateForClass(className)) : "select a learner's class"}.`;
  }

  function schoolFilters() {
    return {
      class_name: $("schoolReportClass").value,
      term: $("schoolReportTerm").value,
      year: $("schoolReportYear").value,
    };
  }

  async function loadSchoolCards() {
    const filters = schoolFilters();
    if (!filters.class_name) {
      $("schoolReportCardsList").replaceChildren();
      setStatus(schoolStatus, "Select a class to load report cards.", "error");
      return [];
    }
    setStatus(schoolStatus, "Loading report cards…");
    const query = queryString({ ...filters, status: "all" });
    try {
      const response = await api(`/api/report-cards?${query}`);
      const cards = apiList(response, "report_cards");
      renderCards(cards, $("schoolReportCardsList"), "school");
      setStatus(schoolStatus, `${cards.length} report card${cards.length === 1 ? "" : "s"} found.`);
      return cards;
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not load report cards.", "error");
      throw error;
    }
  }

  async function loadSchoolSettings() {
    try {
      const response = await api("/api/school/report-settings");
      $("schoolReportTermDates").value = response?.settings?.term_dates || "";
      $("schoolReportFees").value = response?.settings?.fees || "";
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not load school report settings.", "error");
    }
  }

  async function saveSchoolSettings() {
    setStatus(schoolStatus, "Saving school report settings…");
    try {
      await api("/api/school/report-settings", {
        method: "PUT",
        body: {
          term_dates: $("schoolReportTermDates").value.trim() || null,
          fees: $("schoolReportFees").value.trim() || null,
        },
      });
      setStatus(schoolStatus, "School report settings saved.", "success");
      tell("Report settings saved.");
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not save report settings.", "error");
    }
  }

  async function createSchoolCard() {
    const className = $("schoolReportClass").value;
    const learnerId = $("schoolReportLearner").value;
    if (!className || !learnerId) {
      setStatus(schoolStatus, "Select a class and learner before creating a card.", "error");
      return;
    }
    const year = Number($("schoolReportYear").value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      setStatus(schoolStatus, "Enter a year from 2000 to 2100.", "error");
      return;
    }
    setStatus(schoolStatus, "Creating report card…");
    try {
      const result = await api("/api/report-cards", {
        method: "POST",
        body: {
          learner_id: learnerId,
          class_name: className,
          template_level: templateForClass(className),
          term: $("schoolReportTerm").value,
          year,
        },
      });
      await loadSchoolCards();
      tell("Report card created.");
      await openEditor(result?.report_card?.id, "school");
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not create report card.", "error");
    }
  }

  async function bulkGenerate() {
    const filters = schoolFilters();
    const year = Number(filters.year);
    if (!filters.class_name || !Number.isInteger(year) || year < 2000 || year > 2100) {
      setStatus(schoolStatus, "Select a class and enter a valid year before bulk generation.", "error");
      return;
    }
    setStatus(schoolStatus, "Generating report cards for this class…");
    try {
      const result = await api("/api/report-cards/bulk", {
        method: "POST",
        body: { class_name: filters.class_name, term: filters.term, year },
      });
      setStatus(
        schoolStatus,
        `Created ${Number(result?.created ?? 0)} card${Number(result?.created ?? 0) === 1 ? "" : "s"}; skipped ${Number(result?.skipped ?? 0)} existing card${Number(result?.skipped ?? 0) === 1 ? "" : "s"}.`,
        "success",
      );
      await loadSchoolCards();
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not bulk-generate report cards.", "error");
    }
  }

  async function downloadClassZip() {
    const filters = schoolFilters();
    if (!filters.class_name) {
      setStatus(schoolStatus, "Select a class before downloading a ZIP.", "error");
      return;
    }
    setStatus(schoolStatus, "Preparing published report cards…");
    try {
      const query = queryString({ ...filters, status: "published" });
      const response = await api(`/api/report-cards?${query}`);
      const cards = apiList(response, "report_cards");
      if (!cards.length) {
        setStatus(schoolStatus, "No published report cards are available for this class and term.", "error");
        return;
      }
      const entries = [];
      for (const card of cards) {
        const blob = await downloadResponse(`/api/report-cards/${encodeURIComponent(card.id)}/pdf`);
        const base = `${safeFilename(card.learner_name)}-${safeFilename(card.class_name)}-${safeFilename(card.term)}-${card.year}-${String(card.learner_id || card.id).slice(0, 8)}`;
        entries.push({ name: `${base}.pdf`, blob });
      }
      const archive = await createReportArchive(entries);
      saveBlob(archive, `${safeFilename(filters.class_name)}-${safeFilename(filters.term)}-${filters.year}-report-cards.zip`);
      setStatus(schoolStatus, `${cards.length} published report card${cards.length === 1 ? "" : "s"} added to the ZIP.`, "success");
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not create the class ZIP.", "error");
    }
  }

  function badge(status) {
    const normalized = String(status || "draft").toLowerCase();
    return `<span class="rc-badge ${normalized === "published" ? "rc-badge--published" : "rc-badge--draft"}">${safe(normalized)}</span>`;
  }

  function renderCards(cards, target, audience) {
    if (!target) return;
    if (!cards.length) {
      target.innerHTML = '<div class="teacher-empty">No report cards match these filters.</div>';
      return;
    }
    target.innerHTML = cards.map((card) => {
      const downloaded = Number(card.download_count || 0);
      const countText = downloaded > 0 ? `Student PDF downloaded ${downloaded} time${downloaded === 1 ? "" : "s"}` : "Student PDF not downloaded";
      const actions = audience === "school"
        ? `<button type="button" class="rc-button" data-rc-action="edit" data-card-id="${safe(card.id)}">Open / edit</button>
           ${card.status === "published" ? `<button type="button" class="rc-button" data-rc-action="pdf" data-card-id="${safe(card.id)}">Staff PDF</button>` : ""}
           ${downloaded > 0 ? `<button type="button" class="rc-button rc-button--danger" data-rc-action="reset" data-card-id="${safe(card.id)}" data-student-id="${safe(card.learner_id)}">Reset student download</button>` : ""}`
        : audience === "student"
          ? `<button type="button" class="rc-button" data-rc-action="edit" data-card-id="${safe(card.id)}">Preview</button>
             <button type="button" class="rc-button ${downloaded ? "" : "rc-button--primary"}" data-rc-action="download" data-card-id="${safe(card.id)}" ${downloaded ? "disabled" : ""}>${downloaded ? "Downloaded" : "Download PDF"}</button>`
        : `<button type="button" class="rc-button rc-button--primary" data-rc-action="edit" data-card-id="${safe(card.id)}">${card.status === "published" ? "View / edit" : "Enter marks"}</button>
           ${card.status === "published" ? `<button type="button" class="rc-button" data-rc-action="pdf" data-card-id="${safe(card.id)}">Staff PDF</button>` : ""}`;
      return `<article class="rc-list-row">
        <div class="rc-list-copy">
          <strong>${safe(card.learner_name || "Learner")} · ${safe(card.class_name)}</strong>
          <small>${safe(card.term)} ${safe(card.year)} · ${safe(templateLabel(card.template_level))} · ${Number(card.mark_count || 0)} subject marks · ${safe(countText)}</small>
          <span>${badge(card.status)}</span>
        </div>
        <div class="rc-list-actions">${actions}</div>
      </article>`;
    }).join("");
  }

  async function loadWorkspaceLearners() {
    const response = await api("/api/report-cards/learners");
    state.workspaceLearners = apiList(response, "learners")
      .filter((learner) => learner.class_level && templateForClass(learner.class_level));
    const classes = [...new Set(state.workspaceLearners.map((learner) => learner.class_level))]
      .sort((left, right) => left.localeCompare(right));
    setSelectOptions(
      $("rcClassFilter"),
      classes.map((className) => ({ value: className, label: `${className} · ${templateLabel(templateForClass(className))}` })),
      "All assigned classes",
    );
  }

  async function loadWorkspaceCards() {
    if (state.mode === "student") {
      setStatus(workspaceStatus, "Loading published report cards…");
      const response = await api("/api/my/report-cards");
      const cards = apiList(response, "report_cards");
      state.studentCards = cards;
      $("studentReportCount").textContent = String(cards.length);
      renderCards(cards, $("rcCardsList"), "student");
      setStatus(workspaceStatus, cards.length ? `${cards.length} published report card${cards.length === 1 ? "" : "s"} available.` : "No published report cards yet.");
      return;
    }
    const query = queryString({
      class_name: $("rcClassFilter").value,
      term: $("rcTermFilter").value,
      year: $("rcYearFilter").value,
      status: $("rcStatusFilter").value,
    });
    setStatus(workspaceStatus, "Loading report cards…");
    const response = await api(`/api/report-cards?${query}`);
    const cards = apiList(response, "report_cards");
    renderCards(cards, $("rcCardsList"), "staff");
    setStatus(workspaceStatus, `${cards.length} report card${cards.length === 1 ? "" : "s"} found.`);
  }

  async function openWorkspaceFor(role) {
    const user = getCurrentUser?.();
    if (!user || user.role !== role || user.sector !== "education") return;
    showWorkspace(role === "teacher" ? "teacher" : "student");
    fillDefaultFilters();
    $("rcCardsList").replaceChildren();
    try {
      if (role === "teacher") await loadWorkspaceLearners();
      await loadWorkspaceCards();
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not load report cards.", "error");
    }
  }

  async function loadStudentCount() {
    try {
      const response = await api("/api/my/report-cards");
      const cards = apiList(response, "report_cards");
      $("studentReportCount").textContent = String(cards.length);
    } catch {
      $("studentReportCount").textContent = "—";
    }
  }

  async function resetStudentDownload(cardId, studentId) {
    if (!window.confirm("Reset this learner's one-time PDF download?")) return;
    setStatus(schoolStatus, "Resetting learner download…");
    try {
      await api("/api/report-cards/reset-download", {
        method: "POST",
        body: { report_card_id: cardId, student_id: studentId },
      });
      tell("Student download access reset.");
      await loadSchoolCards();
    } catch (error) {
      setStatus(schoolStatus, error.message || "Could not reset student download access.", "error");
    }
  }

  async function openEditor(cardId, mode = state.mode) {
    if (!cardId) {
      tell("The report-card response did not include an ID.", "error");
      return;
    }
    state.mode = mode;
    state.activeCardId = cardId;
    setStatus(workspaceStatus, "Loading report card…");
    root.hidden = false;
    document.body.classList.add("report-workspace-open");
    listView.hidden = true;
    previewView.hidden = true;
    editorView.hidden = false;
    try {
      const response = await api(`/api/report-cards/${encodeURIComponent(cardId)}`);
      state.activeDetail = response;
      renderEditor(response);
      setStatus(workspaceStatus, "");
      $("rcEditorBack").focus();
      if (state.user?.role === "teacher") await loadTeacherSignature();
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not open this report card.", "error");
    }
  }

  function fieldMarkup(label, id, attributes = "") {
    return `<div class="rc-field"><label for="${id}">${label}</label><input id="${id}" ${attributes}></div>`;
  }

  function renderEditor(detail) {
    const report = detail.report_card;
    const level = report.template_level;
    const marks = apiList(detail, "marks");
    const comments = detail.comments || {};
    const isNursery = level === "nursery";
    const isPublished = report.status === "published";
    $("rcWorkspaceTitle").textContent = `${templateLabel(level)} report card`;
    $("rcWorkspaceEyebrow").textContent = `${safe(report.term)} ${safe(report.year)} · ${safe(report.class_name)}`;
    $("rcEditorLearner").textContent = report.learner_name || "Learner";
    $("rcEditorMeta").textContent = `${report.class_name} · ${report.term} ${report.year} · ${report.learner_lin ? `LIN ${report.learner_lin} · ` : ""}${report.status}`;
    const fields = [
      fieldMarkup("Subject or learning area", "rcSubjectName", 'type="text" maxlength="120" required autocomplete="off"'),
      fieldMarkup(isNursery ? "Area code (optional)" : "Subject / paper code", "rcSubjectCode", 'type="text" maxlength="30" autocomplete="off"'),
    ];
    if (isNursery) {
      fields.push(fieldMarkup("Score (0–100)", "rcScore", 'type="number" min="0" max="100" step="0.01" required inputmode="decimal"'));
    } else {
      fields.push(fieldMarkup("Assessment 1", "rcA1", 'type="number" min="0" max="100" step="0.01" required inputmode="decimal"'));
      fields.push(fieldMarkup("Assessment 2", "rcA2", 'type="number" min="0" max="100" step="0.01" required inputmode="decimal"'));
      fields.push(fieldMarkup("Assessment 3", "rcA3", 'type="number" min="0" max="100" step="0.01" required inputmode="decimal"'));
      fields.push(fieldMarkup("End-of-term exam", "rcEot", 'type="number" min="0" max="100" step="0.01" required inputmode="decimal"'));
    }
    fields.push(fieldMarkup("Teacher initials", "rcTeacherInitials", 'type="text" maxlength="12" autocomplete="off"'));
    $("rcMarkFields").innerHTML = fields.join("");
    const initials = String(state.user?.name || "").trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    $("rcTeacherInitials").value = initials;
    $("rcMarksList").innerHTML = renderMarksTable(level, marks);
    $("rcClassTeacherComment").value = comments.class_teacher_comment || "";
    $("rcHeadteacherComment").value = comments.headteacher_comment || "";
    $("rcPrincipalComment").value = comments.principal_comment || "";
    $("rcMarkForm").hidden = isPublished;
    $("rcCommentsForm").querySelectorAll("textarea").forEach((input) => { input.disabled = isPublished; });
    $("rcSaveDraft").hidden = isPublished;
    $("rcPublish").hidden = isPublished;
    $("rcStaffPdf").hidden = !isPublished;
    $("rcTeacherSignaturePanel").hidden = state.user?.role !== "teacher";
    document.querySelectorAll(".rc-published-note").forEach((note) => note.remove());
    if (isPublished) {
      $("rcMarksList").insertAdjacentHTML("beforebegin", '<p class="rc-muted rc-published-note">This card is published. Marks and comments are read-only.</p>');
    }
    if (state.user?.role !== "teacher") $("rcSignaturePreview").hidden = true;
  }

  function renderMarksTable(level, marks) {
    if (!marks.length) return '<div class="teacher-empty">No subject marks entered yet.</div>';
    const headings = level === "nursery"
      ? ["Learning area", "Score", "Grade", "Remarks"]
      : ["Code", "Subject", "A1", "A2", "A3", "Average", "20%", "EOT", "80%", "Total", "Identifier", "Grade", "Remarks", "Initials"];
    const rows = marks.map((mark) => {
      const values = level === "nursery"
        ? [mark.subject_name, mark.pct_100, mark.grade, mark.remarks]
        : [mark.subject_code, mark.subject_name, mark.a1, mark.a2, mark.a3, mark.avg, mark.pct_20, mark.eot, mark.pct_80, mark.pct_100, mark.identifier, mark.grade, mark.remarks, mark.teacher_initials];
      return `<tr>${values.map((value) => `<td>${safe(value ?? "—")}</td>`).join("")}</tr>`;
    }).join("");
    return `<table class="rc-table"><thead><tr>${headings.map((heading) => `<th>${safe(heading)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function saveMark(event) {
    event.preventDefault();
    const report = state.activeDetail?.report_card;
    if (!report || report.status === "published") return;
    const body = {
      subject_name: $("rcSubjectName").value.trim(),
      subject_code: $("rcSubjectCode").value.trim() || null,
      teacher_initials: $("rcTeacherInitials").value.trim() || null,
    };
    if (!body.subject_name) {
      setStatus(workspaceStatus, "Enter a subject or learning-area name.", "error");
      return;
    }
    if (report.template_level === "nursery") {
      body.score = Number($("rcScore").value);
    } else {
      body.a1 = Number($("rcA1").value);
      body.a2 = Number($("rcA2").value);
      body.a3 = Number($("rcA3").value);
      body.eot = Number($("rcEot").value);
    }
    setStatus(workspaceStatus, "Saving marks…");
    try {
      const response = await api(`/api/report-cards/${encodeURIComponent(state.activeCardId)}/marks`, { method: "POST", body });
      if (response?.queued) {
        setStatus(workspaceStatus, "Mark saved on this device. It will sync after your account is verified online.", "success");
        tell("Report-card mark saved on this device and waiting to sync.", "info");
        return;
      }
      tell("Subject mark saved.");
      await openEditor(state.activeCardId, state.mode);
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not save marks.", "error");
    }
  }

  async function saveComments() {
    const cardId = state.activeCardId;
    if (!cardId) return false;
    setStatus(workspaceStatus, "Saving comments…");
    try {
      await api(`/api/report-cards/${encodeURIComponent(cardId)}/comment`, {
        method: "POST",
        body: {
          class_teacher_comment: $("rcClassTeacherComment").value.trim(),
          headteacher_comment: $("rcHeadteacherComment").value.trim() || null,
          principal_comment: $("rcPrincipalComment").value.trim() || null,
        },
      });
      setStatus(workspaceStatus, "Comments saved.", "success");
      return true;
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not save comments.", "error");
      return false;
    }
  }

  async function publishCard() {
    if (!(await saveComments())) return;
    setStatus(workspaceStatus, "Publishing report card…");
    try {
      await api(`/api/report-cards/${encodeURIComponent(state.activeCardId)}/publish`, { method: "PATCH" });
      tell("Report card published.");
      await openEditor(state.activeCardId, state.mode);
      if (state.mode === "school") await loadSchoolCards();
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not publish report card.", "error");
    }
  }

  async function downloadStaffPdf() {
    if (!state.activeCardId) return;
    try {
      await saveComments();
      const blob = await downloadResponse(`/api/report-cards/${encodeURIComponent(state.activeCardId)}/pdf`);
      const report = state.activeDetail?.report_card || {};
      saveBlob(blob, `${safeFilename(report.learner_name)}-${safeFilename(report.term)}-${report.year}.pdf`);
      setStatus(workspaceStatus, "PDF downloaded.", "success");
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not download PDF.", "error");
    }
  }

  async function openStudentPreview(cardId) {
    setStatus(workspaceStatus, "Loading report preview…");
    try {
      const detail = await api(`/api/report-cards/${encodeURIComponent(cardId)}`);
      state.activeCardId = cardId;
      state.activeDetail = detail;
      renderStudentPreview(detail);
      listView.hidden = true;
      editorView.hidden = true;
      previewView.hidden = false;
      setStatus(workspaceStatus, "");
      const listedCard = state.studentCards.find((card) => card.id === cardId);
      $("rcStudentDownload").disabled = Number(listedCard?.download_count || 0) >= 1;
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not open report preview.", "error");
    }
  }

  function renderStudentPreview(detail) {
    const report = detail.report_card || {};
    const level = report.template_level;
    const marks = apiList(detail, "marks");
    const comments = detail.comments || {};
    $("rcWorkspaceTitle").textContent = "Report Preview";
    $("rcWorkspaceEyebrow").textContent = "Published report card";
    $("rcPreviewMeta").textContent = `${report.term} ${report.year} · ${report.class_name} · ${templateLabel(level)}`;
    const headings = level === "nursery"
      ? ["Learning area", "Score", "Grade", "Remarks"]
      : ["Code", "Subject", "A1", "A2", "A3", "Average", "20%", "EOT", "80%", "Total", "Identifier", "Grade", "Remarks"];
    const rows = marks.map((mark) => {
      const values = level === "nursery"
        ? [mark.subject_name, mark.pct_100, mark.grade, mark.remarks]
        : [mark.subject_code, mark.subject_name, mark.a1, mark.a2, mark.a3, mark.avg, mark.pct_20, mark.eot, mark.pct_80, mark.pct_100, mark.identifier, mark.grade, mark.remarks];
      return `<tr>${values.map((value) => `<td>${safe(value ?? "—")}</td>`).join("")}</tr>`;
    }).join("");
    const commentEntries = [
      ["Class teacher", comments.class_teacher_comment],
      ["Headteacher", comments.headteacher_comment],
      ["Principal", comments.principal_comment],
    ].filter(([, value]) => value);
    const commentHtml = commentEntries.length
      ? commentEntries.map(([label, value]) => `<div><strong>${safe(label)}:</strong> ${safe(value)}</div>`).join("")
      : '<div>No comments are available.</div>';
    $("rcPreviewContent").innerHTML = `
      <h2>${safe(report.school_name || "APSHULE")}</h2>
      <p><strong>Learner:</strong> ${safe(report.learner_name)}${report.learner_lin ? ` · <strong>LIN:</strong> ${safe(report.learner_lin)}` : ""}</p>
      <p><strong>Class:</strong> ${safe(report.class_name)} · <strong>Term:</strong> ${safe(report.term)} ${safe(report.year)}</p>
      <p><strong>Gender:</strong> ${safe(report.learner_gender || "Not set")}${report.class_position ? ` · <strong>Class position:</strong> ${safe(report.class_position)}` : ""}</p>
      <div class="rc-table-wrap" style="margin-top:14px;"><table class="rc-table"><thead><tr>${headings.map((heading) => `<th>${safe(heading)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headings.length}">No marks are available.</td></tr>`}</tbody></table></div>
      <div class="rc-comment-preview">${commentHtml}</div>
      <p style="margin-top:14px;"><strong>Term dates:</strong> ${safe(report.term_dates || "Not set")} · <strong>Fees:</strong> ${safe(report.fees || "Not set")}</p>
    `;
  }

  async function downloadStudentPdf() {
    if (!state.activeCardId) return;
    setStatus(workspaceStatus, "Downloading your report card…");
    try {
      const blob = await downloadResponse(`/api/report-cards/${encodeURIComponent(state.activeCardId)}/pdf`);
      const report = state.activeDetail?.report_card || {};
      saveBlob(blob, `${safeFilename(report.learner_name)}-${safeFilename(report.term)}-${report.year}.pdf`);
      $("rcStudentDownload").disabled = true;
      setStatus(workspaceStatus, "PDF downloaded. This report's download is now used.", "success");
      await loadWorkspaceCards();
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not download this report card.", "error");
      if ((error.message || "").toLowerCase().includes("already downloaded")) {
        $("rcStudentDownload").disabled = true;
      }
    }
  }

  async function loadTeacherSignature() {
    const panel = $("rcTeacherSignaturePanel");
    if (!panel || panel.hidden || state.user?.role !== "teacher") return;
    try {
      const response = await api("/api/teacher/signature");
      const signature = response?.signature;
      if (signature?.signature_draw_base64) {
        $("rcSignaturePreview").src = signature.signature_draw_base64;
        $("rcSignaturePreview").hidden = false;
      } else if (signature?.signature_image_url) {
        $("rcSignaturePreview").src = signature.signature_image_url;
        $("rcSignaturePreview").hidden = false;
      } else {
        $("rcSignaturePreview").hidden = true;
      }
      state.uploadedSignature = null;
      state.hasSignatureInk = false;
      if (canvasContext) canvasContext.clearRect(0, 0, canvas.width, canvas.height);
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not load saved signature.", "error");
    }
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function startSignatureStroke(event) {
    if (!canvasContext) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const point = canvasPoint(event);
    canvasContext.beginPath();
    canvasContext.moveTo(point.x, point.y);
    canvasContext.lineWidth = 4;
    canvasContext.lineCap = "round";
    canvasContext.lineJoin = "round";
    canvasContext.strokeStyle = "#17151f";
    state.hasSignatureInk = true;
  }

  function continueSignatureStroke(event) {
    if (!canvasContext || !state.hasSignatureInk || !canvas.hasPointerCapture?.(event.pointerId)) return;
    event.preventDefault();
    const point = canvasPoint(event);
    canvasContext.lineTo(point.x, point.y);
    canvasContext.stroke();
  }

  function stopSignatureStroke(event) {
    if (canvas?.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  async function saveTeacherSignature() {
    let signatureData = state.uploadedSignature;
    if (!signatureData && state.hasSignatureInk && canvas) signatureData = canvas.toDataURL("image/png");
    if (!signatureData) {
      setStatus(workspaceStatus, "Draw or upload a signature first.", "error");
      return;
    }
    setStatus(workspaceStatus, "Saving teacher signature…");
    try {
      const response = await api("/api/teacher/signature", {
        method: "POST",
        body: { signature_draw_base64: signatureData },
      });
      const saved = response?.signature?.signature_draw_base64 || signatureData;
      $("rcSignaturePreview").src = saved;
      $("rcSignaturePreview").hidden = false;
      tell("Teacher signature saved.");
      setStatus(workspaceStatus, "Signature saved.", "success");
    } catch (error) {
      setStatus(workspaceStatus, error.message || "Could not save signature.", "error");
    }
  }

  async function handleCardListAction(event, audience) {
    const button = event.target.closest("[data-rc-action]");
    if (!button) return;
    const cardId = button.dataset.cardId;
    if (button.dataset.rcAction === "reset") {
      await resetStudentDownload(cardId, button.dataset.studentId);
    } else if (button.dataset.rcAction === "download" && audience === "student") {
      state.activeCardId = cardId;
      const card = state.studentCards.find((item) => item.id === cardId);
      state.activeDetail = card ? { report_card: card } : null;
      await downloadStudentPdf();
    } else if (button.dataset.rcAction === "pdf") {
      try {
        const blob = await downloadResponse(`/api/report-cards/${encodeURIComponent(cardId)}/pdf`);
        const card = button.closest(".rc-list-row");
        const name = card?.querySelector("strong")?.textContent || "report-card";
        saveBlob(blob, `${safeFilename(name)}.pdf`);
      } catch (error) {
        setStatus(audience === "school" ? schoolStatus : workspaceStatus, error.message || "Could not download PDF.", "error");
      }
    } else if (button.dataset.rcAction === "edit") {
      if (audience === "student") {
        await openStudentPreview(cardId);
      } else {
        await openEditor(cardId, audience === "school" ? "school" : "teacher");
      }
    }
  }

  function bindEvents() {
    document.querySelectorAll("[data-report-cards-open]").forEach((button) => {
      button.addEventListener("click", () => {
        const audience = button.dataset.reportCardsOpen;
        if (audience === "student") openWorkspaceFor("individual");
        if (audience === "teacher") openWorkspaceFor("teacher");
      });
    });
    $("rcWorkspaceClose").addEventListener("click", closeWorkspace);
    $("rcWorkspaceRefresh").addEventListener("click", async () => {
      try {
        if (state.mode === "teacher" && editorView.hidden === false) {
          await openEditor(state.activeCardId, state.mode);
        } else if (state.mode === "school") {
          await loadSchoolCards();
          closeWorkspace();
        } else {
          await loadWorkspaceCards();
        }
      } catch (error) {
        setStatus(workspaceStatus, error.message || "Could not refresh report cards.", "error");
      }
    });
    $("rcLoadCards").addEventListener("click", () => loadWorkspaceCards().catch((error) => setStatus(workspaceStatus, error.message, "error")));
    $("rcEditorBack").addEventListener("click", async () => {
      if (state.mode === "school") {
        closeWorkspace();
        await loadSchoolCards();
      } else {
        editorView.hidden = true;
        previewView.hidden = true;
        listView.hidden = false;
        setStatus(workspaceStatus, "");
        await loadWorkspaceCards();
      }
    });
    $("rcPreviewBack").addEventListener("click", async () => {
      previewView.hidden = true;
      listView.hidden = false;
      await loadWorkspaceCards();
    });
    $("rcMarkForm").addEventListener("submit", saveMark);
    window.addEventListener("apshule:offline-queue-item-synced", (event) => {
      const detail = event.detail;
      if (
        !state.activeCardId ||
        String(detail?.userId) !== String(state.user?.id || "") ||
        detail.path !== `/api/report-cards/${encodeURIComponent(state.activeCardId)}/marks` ||
        editorView.hidden
      ) return;
      void openEditor(state.activeCardId, state.mode);
    });
    $("rcCommentsForm").addEventListener("submit", (event) => event.preventDefault());
    $("rcSaveDraft").addEventListener("click", async () => {
      if (await saveComments()) tell("Draft comments saved.");
    });
    $("rcPublish").addEventListener("click", publishCard);
    $("rcStaffPdf").addEventListener("click", downloadStaffPdf);
    $("rcStudentDownload").addEventListener("click", downloadStudentPdf);
    $("rcCardsList").addEventListener("click", (event) => handleCardListAction(event, "teacher"));
    $("schoolReportCardsList").addEventListener("click", (event) => handleCardListAction(event, "school"));
    $("rcClassFilter").addEventListener("change", () => loadWorkspaceCards().catch((error) => setStatus(workspaceStatus, error.message, "error")));
    $("schoolReportClass").addEventListener("change", async () => {
      await updateSchoolLearnersForClass();
      await loadSchoolCards().catch(() => {});
    });
    $("schoolReportTerm").addEventListener("change", () => loadSchoolCards().catch(() => {}));
    $("schoolReportYear").addEventListener("change", () => loadSchoolCards().catch(() => {}));
    $("schoolReportLearner").addEventListener("change", () => {
      const learner = state.schoolLearners.find((item) => item.id === $("schoolReportLearner").value);
      $("schoolReportTemplate").textContent = `Template: ${learner ? templateLabel(templateForClass(learner.class_level)) : "select a learner's class"}.`;
    });
    $("schoolReportCreate").addEventListener("click", createSchoolCard);
    $("schoolReportBulk").addEventListener("click", bulkGenerate);
    $("schoolReportZip").addEventListener("click", downloadClassZip);
    $("schoolReportLoad").addEventListener("click", () => loadSchoolCards().catch(() => {}));
    $("schoolReportSettingsSave").addEventListener("click", saveSchoolSettings);
    $("rcSignatureClear").addEventListener("click", () => {
      if (canvasContext && canvas) canvasContext.clearRect(0, 0, canvas.width, canvas.height);
      state.hasSignatureInk = false;
      state.uploadedSignature = null;
      $("rcSignatureUpload").value = "";
    });
    $("rcSignatureUpload").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 800_000) {
        event.target.value = "";
        setStatus(workspaceStatus, "Choose a PNG or JPEG signature image no larger than 800 KB.", "error");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        state.uploadedSignature = String(reader.result || "");
        $("rcSignaturePreview").src = state.uploadedSignature;
        $("rcSignaturePreview").hidden = false;
        setStatus(workspaceStatus, "Signature image ready to save.");
      };
      reader.onerror = () => setStatus(workspaceStatus, "Could not read that signature image.", "error");
      reader.readAsDataURL(file);
    });
    $("rcSignatureSave").addEventListener("click", saveTeacherSignature);
    canvas?.addEventListener("pointerdown", startSignatureStroke);
    canvas?.addEventListener("pointermove", continueSignatureStroke);
    canvas?.addEventListener("pointerup", stopSignatureStroke);
    canvas?.addEventListener("pointercancel", stopSignatureStroke);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !root.hidden) closeWorkspace();
    });
  }

  async function setUser(user) {
    state.user = user || null;
    const educationStudent = user?.role === "individual" && user?.sector === "education";
    const schoolAdmin = user?.role === "school" && user?.sector === "education";
    const teacher = user?.role === "teacher" && user?.sector === "education";
    $("studentReportCardSection").hidden = !educationStudent;
    if (!educationStudent) $("studentReportCount").textContent = "—";
    $("schoolReportCardsSection").style.display = schoolAdmin ? "block" : "none";
    const currentId = user?.id || null;
    if (!user) {
      closeWorkspace();
      state.loadedUserId = null;
      $("studentReportCount").textContent = "—";
      return;
    }
    if (currentId === state.loadedUserId) return;
    state.loadedUserId = currentId;
    fillDefaultFilters();
    if (educationStudent) await loadStudentCount();
    if (schoolAdmin) {
      try {
        await Promise.all([loadSchoolLearners(), loadSchoolSettings()]);
      } catch (error) {
        setStatus(schoolStatus, error.message || "Could not load report-card administration.", "error");
      }
    }
    if (teacher) {
      $("studentReportCardSection").hidden = true;
    }
  }

  bindEvents();
  fillDefaultFilters();
  return { setUser, close: closeWorkspace };
}