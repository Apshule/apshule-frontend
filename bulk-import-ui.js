const MAX_IMPORT_ROWS = 100;
const IMPORT_PATHS = {
  students: "/api/school/bulk-import/students",
  teachers: "/api/school/bulk-import/teachers",
};

export function initBulkImportUI({
  api,
  apiBase,
  getToken,
  getCurrentUser,
  notify,
  escapeHtml,
  onImportComplete,
}) {
  const parsedRows = { students: null, teachers: null };
  const lastResults = { students: null, teachers: null };
  const importing = { students: false, teachers: false };
  let activeUserKey = null;
  let lastSelectedSchool = "";

  const section = document.getElementById("bulkImportSection");
  const schoolPicker = document.getElementById("bulkImportSchoolPicker");
  const schoolSelect = document.getElementById("bulkImportSchoolSelect");
  const schoolMessage = document.getElementById("bulkImportSchoolMessage");
  const historyContainer = document.getElementById("bulkImportHistory");

  function safe(value) {
    return escapeHtml ? escapeHtml(String(value ?? "")) : String(value ?? "");
  }

  function setStatus(type, message, isError = false) {
    const element = document.getElementById(`bulkImport${type}Status`);
    if (!element) return;
    element.textContent = message;
    element.style.color = isError ? "#a61b1b" : "";
  }

  function selectedSchoolId() {
    const user = getCurrentUser();
    if (user?.role === "school") return user.schoolId || user.school_id || "";
    if (user?.role === "superadmin") return schoolSelect?.value || "";
    return "";
  }

  function hasOneTimeCredentials() {
    return Object.values(lastResults).some((result) =>
      Array.isArray(result?.credentials) && result.credentials.length > 0
    );
  }

  function clearImportStates() {
    for (const type of ["students", "teachers"]) {
      parsedRows[type] = null;
      lastResults[type] = null;
      importing[type] = false;
      const fileInput = document.getElementById(
        type === "students" ? "bulkImportStudentsFile" : "bulkImportTeachersFile",
      );
      const preview = document.getElementById(
        type === "students" ? "bulkImportStudentsPreview" : "bulkImportTeachersPreview",
      );
      const result = document.getElementById(
        type === "students" ? "bulkImportStudentsResult" : "bulkImportTeachersResult",
      );
      if (fileInput) fileInput.value = "";
      if (preview) preview.innerHTML = "";
      if (result) result.innerHTML = "";
      setStatus(type, "");
    }
    updateSubmitButtons();
  }

  function updateSubmitButtons() {
    const busy = Object.values(importing).some(Boolean);
    for (const type of ["students", "teachers"]) {
      const button = document.getElementById(
        type === "students" ? "bulkImportStudentsSubmit" : "bulkImportTeachersSubmit",
      );
      const fileInput = document.getElementById(
        type === "students" ? "bulkImportStudentsFile" : "bulkImportTeachersFile",
      );
      if (fileInput) fileInput.disabled = busy;
      if (!button) continue;
      const rows = parsedRows[type];
      button.disabled = Boolean(
        busy ||
        !rows?.length ||
        rows.length > MAX_IMPORT_ROWS ||
        !selectedSchoolId()
      );
    }
    if (schoolSelect) schoolSelect.disabled = busy;
  }

  function normalizeHeader(value) {
    const normalized = String(value ?? "")
      .replace(/^\uFEFF/u, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "");
    const aliases = {
      full_name: "name",
      student_name: "name",
      teacher_name: "name",
      email_address: "email",
      phone_number: "phone",
      student_class: "class_level",
      class: "class_level",
      classlevel: "class_level",
      lin_number: "lin",
      subjects: "subjects_taught",
      subject_taught: "subjects_taught",
      assigned_class: "assigned_classes",
      classes: "assigned_classes",
    };
    return aliases[normalized] || normalized;
  }

  function normalizeParsedRecord(record) {
    const normalized = {};
    for (const [key, value] of Object.entries(record || {})) {
      normalized[normalizeHeader(key)] = value == null ? "" : String(value).trim();
    }
    return normalized;
  }

  async function parseFile(file) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("The file must be 5 MB or smaller.");
    }

    if (extension === "csv") {
      if (!window.Papa?.parse) throw new Error("The CSV parser could not be loaded.");
      const parsed = await new Promise((resolve, reject) => {
        window.Papa.parse(file, {
          header: true,
          skipEmptyLines: "greedy",
          dynamicTyping: false,
          transformHeader: normalizeHeader,
          complete: resolve,
          error: reject,
        });
      });
      if (parsed.errors?.some((item) => item.code === "Quotes")) {
        throw new Error("The CSV has invalid quotation marks. Fix it and try again.");
      }
      const headers = (parsed.meta?.fields || []).map(normalizeHeader);
      const records = (parsed.data || []).map(normalizeParsedRecord);
      return { headers, records };
    }

    if (extension === "xlsx" || extension === "xls") {
      if (!window.XLSX?.read) throw new Error("The Excel parser could not be loaded.");
      const workbook = window.XLSX.read(await file.arrayBuffer(), {
        type: "array",
        cellDates: false,
      });
      const sheetName = workbook.SheetNames?.[0];
      if (!sheetName) throw new Error("The workbook does not contain a worksheet.");
      const worksheet = workbook.Sheets[sheetName];
      const rows = window.XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: false,
      });
      if (!rows.length) return { headers: [], records: [] };
      const headers = rows[0].map(normalizeHeader);
      const records = rows.slice(1)
        .filter((row) => row.some((value) => String(value ?? "").trim() !== ""))
        .map((row) => normalizeParsedRecord(
          Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])),
        ));
      return { headers, records };
    }

    throw new Error("Choose a .csv, .xlsx, or .xls file.");
  }

  function listFromCell(value) {
    return String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function toImportRows(type, records) {
    return records.map((row) => {
      const common = {
        name: String(row.name ?? "").trim(),
        email: String(row.email ?? "").trim(),
        phone: String(row.phone ?? "").trim(),
        gender: String(row.gender ?? "").trim(),
      };
      if (type === "students") {
        return {
          ...common,
          class_level: String(row.class_level ?? "").trim(),
          lin: String(row.lin ?? "").trim(),
        };
      }
      return {
        ...common,
        subjects_taught: listFromCell(row.subjects_taught),
        assigned_classes: listFromCell(row.assigned_classes),
      };
    });
  }

  function renderPreview(type, rows) {
    const container = document.getElementById(
      type === "students" ? "bulkImportStudentsPreview" : "bulkImportTeachersPreview",
    );
    if (!container) return;
    const columns = type === "students"
      ? [
          ["Name", (row) => row.name],
          ["Email", (row) => row.email],
          ["Class", (row) => row.class_level],
          ["Phone", (row) => row.phone],
          ["Gender", (row) => row.gender],
          ["LIN", (row) => row.lin],
        ]
      : [
          ["Name", (row) => row.name],
          ["Email", (row) => row.email],
          ["Phone", (row) => row.phone],
          ["Subjects", (row) => row.subjects_taught.join(", ")],
          ["Classes", (row) => row.assigned_classes.join(", ")],
        ];
    const firstEmailRows = new Set();
    const tableRows = rows.slice(0, 5).map((row) => {
      const normalizedEmail = row.email.toLowerCase();
      const duplicate = normalizedEmail && firstEmailRows.has(normalizedEmail);
      if (normalizedEmail) firstEmailRows.add(normalizedEmail);
      const cells = columns.map(([, value]) => `<td>${safe(value(row)) || "—"}</td>`).join("");
      return `<tr>${cells}<td>${duplicate ? "Duplicate in file" : "—"}</td></tr>`;
    }).join("");
    container.innerHTML = `
      <p style="margin:8px 0;"><strong>Preview:</strong> first ${Math.min(5, rows.length)} of ${rows.length} rows</p>
      <div style="overflow:auto; max-width:100%;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead><tr>${columns.map(([label]) => `<th scope="col" style="text-align:left; padding:6px; border-bottom:1px solid #ccc;">${safe(label)}</th>`).join("")}<th scope="col" style="text-align:left; padding:6px; border-bottom:1px solid #ccc;">File check</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;
  }

  async function handleFile(type, file) {
    parsedRows[type] = null;
    updateSubmitButtons();
    if (!file) {
      setStatus(type, "");
      const preview = document.getElementById(
        type === "students" ? "bulkImportStudentsPreview" : "bulkImportTeachersPreview",
      );
      if (preview) preview.innerHTML = "";
      return;
    }

    setStatus(type, "Reading file…");
    try {
      const { headers, records } = await parseFile(file);
      const required = type === "students" ? ["name", "email", "class_level"] : ["name", "email"];
      const missing = required.filter((key) => !headers.includes(key));
      if (missing.length) {
        throw new Error(`Missing required columns: ${missing.join(", ")}.`);
      }
      if (!records.length) throw new Error("No data rows were found in this file.");
      if (records.length > MAX_IMPORT_ROWS) {
        throw new Error(`This file has ${records.length} rows; split it into files of ${MAX_IMPORT_ROWS} rows or fewer.`);
      }
      const rows = toImportRows(type, records);
      parsedRows[type] = rows;
      renderPreview(type, rows);
      setStatus(type, `Found ${rows.length} ${type}. Review the first five rows before importing.`);
    } catch (error) {
      const preview = document.getElementById(
        type === "students" ? "bulkImportStudentsPreview" : "bulkImportTeachersPreview",
      );
      if (preview) preview.innerHTML = "";
      setStatus(type, error?.message || "Could not read this file.", true);
    }
    updateSubmitButtons();
  }

  async function downloadTemplate(type) {
    try {
      const token = getToken();
      const response = await fetch(
        `${apiBase}/api/school/bulk-import/template?type=${encodeURIComponent(type)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not download the CSV template.");
      }
      const blob = await response.blob();
      downloadBlob(blob, `${type}-template.csv`);
    } catch (error) {
      notify(error?.message || "Could not download the CSV template.", "error");
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function renderHistory(imports) {
    if (!historyContainer) return;
    if (!imports.length) {
      historyContainer.textContent = "No imports have been recorded for this school.";
      return;
    }
    historyContainer.innerHTML = `
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr>
            <th scope="col" style="text-align:left; padding:7px; border-bottom:1px solid #ccc;">Date</th>
            <th scope="col" style="text-align:left; padding:7px; border-bottom:1px solid #ccc;">Type</th>
            <th scope="col" style="text-align:right; padding:7px; border-bottom:1px solid #ccc;">Created</th>
            <th scope="col" style="text-align:right; padding:7px; border-bottom:1px solid #ccc;">Skipped</th>
            <th scope="col" style="text-align:right; padding:7px; border-bottom:1px solid #ccc;">Errors</th>
          </tr></thead>
          <tbody>${imports.map((item) => `<tr>
            <td style="padding:7px; border-bottom:1px solid #eee;">${safe(item.created_at ? new Date(item.created_at).toLocaleString() : "—")}</td>
            <td style="padding:7px; border-bottom:1px solid #eee;">${safe(item.import_type)}</td>
            <td style="padding:7px; text-align:right; border-bottom:1px solid #eee;">${safe(item.created_count)}</td>
            <td style="padding:7px; text-align:right; border-bottom:1px solid #eee;">${safe(item.skipped_count)}</td>
            <td style="padding:7px; text-align:right; border-bottom:1px solid #eee;">${safe(item.error_count)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`;
  }

  async function refreshHistory() {
    const user = getCurrentUser();
    const schoolId = selectedSchoolId();
    if (!user || !["school", "superadmin"].includes(user.role)) {
      if (historyContainer) historyContainer.textContent = "";
      return;
    }
    if (!schoolId) {
      if (historyContainer) historyContainer.textContent = "Select a school to view imports.";
      return;
    }
    if (historyContainer) historyContainer.textContent = "Loading import history…";
    try {
      const query = user.role === "superadmin"
        ? `?school_id=${encodeURIComponent(schoolId)}`
        : "";
      const result = await api(`/api/school/bulk-import/history${query}`);
      renderHistory(Array.isArray(result?.imports) ? result.imports : []);
    } catch (error) {
      if (historyContainer) {
        historyContainer.textContent = error?.message || "Could not load import history.";
      }
    }
  }

  async function loadSchools() {
    const user = getCurrentUser();
    if (!schoolSelect || user?.role !== "superadmin") return;
    const currentValue = schoolSelect.value;
    schoolSelect.innerHTML = '<option value="">Select a school</option>';
    try {
      const response = await api("/api/schools");
      const schools = Array.isArray(response)
        ? response
        : Array.isArray(response?.schools) ? response.schools : [];
      for (const school of schools) {
        if (!school?.id) continue;
        const option = document.createElement("option");
        option.value = String(school.id);
        option.textContent = String(school.name || school.school_name || "Unnamed school");
        schoolSelect.appendChild(option);
      }
      if (schools.some((school) => String(school.id) === currentValue)) {
        schoolSelect.value = currentValue;
      }
      lastSelectedSchool = schoolSelect.value;
      schoolMessage.textContent = schoolSelect.value
        ? "Imports will be assigned to the selected school."
        : "Select a school before importing or viewing its history.";
    } catch (error) {
      schoolMessage.textContent = error?.message || "Could not load schools.";
    }
  }

  async function refresh() {
    const user = getCurrentUser();
    if (!section) return;
    const allowed = user && !user.impersonatedBy && ["school", "superadmin"].includes(user.role);
    section.style.display = allowed ? "block" : "none";
    if (!allowed) {
      updateSubmitButtons();
      return;
    }
    const isSuperAdmin = user.role === "superadmin";
    if (schoolPicker) schoolPicker.style.display = isSuperAdmin ? "block" : "none";
    if (isSuperAdmin) {
      await loadSchools();
    } else if (schoolMessage) {
      schoolMessage.textContent = user.schoolId || user.school_id
        ? "Imports will be assigned to your linked school."
        : "This account is not linked to a school and cannot import accounts.";
    }
    updateSubmitButtons();
    await refreshHistory();
  }

  function renderResult(type, result) {
    const container = document.getElementById(
      type === "students" ? "bulkImportStudentsResult" : "bulkImportTeachersResult",
    );
    if (!container) return;
    const credentials = Array.isArray(result.credentials) ? result.credentials : [];
    lastResults[type] = { ...result, credentials };
    const skippedRows = Array.isArray(result.skipped_rows) ? result.skipped_rows : [];
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const credentialTable = credentials.length
      ? `<p style="margin:10px 0;"><strong>Default passwords are shown once. Copy or download them now; they are not saved in import history.</strong></p>
         <div style="display:flex; flex-wrap:wrap; gap:8px; margin:8px 0;">
           <button type="button" data-bulk-import-copy="${type}" class="admin-toggle">Copy All</button>
           <button type="button" data-bulk-import-download="${type}" class="admin-toggle">Download credentials CSV</button>
         </div>
         <div style="overflow:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px;">
           <thead><tr><th scope="col" style="text-align:left; padding:6px; border-bottom:1px solid #ccc;">Name</th><th scope="col" style="text-align:left; padding:6px; border-bottom:1px solid #ccc;">Email</th><th scope="col" style="text-align:left; padding:6px; border-bottom:1px solid #ccc;">Default password</th></tr></thead>
           <tbody>${credentials.map((item) => `<tr><td style="padding:6px; border-bottom:1px solid #eee;">${safe(item.name)}</td><td style="padding:6px; border-bottom:1px solid #eee;">${safe(item.email)}</td><td style="padding:6px; border-bottom:1px solid #eee;"><code>${safe(item.default_password)}</code></td></tr>`).join("")}</tbody>
         </table></div>`
      : "<p>No new accounts were created.</p>";
    const skippedList = skippedRows.length
      ? `<details style="margin-top:10px;"><summary>${skippedRows.length} duplicate account(s) skipped</summary><ul>${skippedRows.map((item) => `<li>Row ${safe(item.row)} — ${safe(item.email)}: ${safe(item.reason)}</li>`).join("")}</ul></details>`
      : "";
    const errorList = errors.length
      ? `<details style="margin-top:10px;"><summary>${errors.length} row(s) need correction</summary><ul>${errors.map((item) => `<li>Row ${safe(item.row)} — ${safe(item.reason || (Array.isArray(item.errors) ? item.errors.join(" ") : item.errors))}</li>`).join("")}</ul></details>`
      : "";
    container.innerHTML = `
      <div style="padding:10px; border:1px solid #cfd8e3; border-radius:10px;">
        <strong>Import complete</strong>
        <p style="margin:5px 0;">Created: ${safe(result.created_count)} · Skipped: ${safe(result.skipped_count)} · Errors: ${safe(result.error_count)}</p>
        ${credentialTable}${skippedList}${errorList}
      </div>`;
    container.querySelector(`[data-bulk-import-copy="${type}"]`)?.addEventListener("click", () => copyCredentials(type));
    container.querySelector(`[data-bulk-import-download="${type}"]`)?.addEventListener("click", () => downloadCredentials(type));
  }

  async function copyCredentials(type) {
    const credentials = lastResults[type]?.credentials || [];
    const content = credentials
      .map((item) => `${item.name}\t${item.email}\t${item.default_password}`)
      .join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("Clipboard access is not available.");
      }
      notify("Credentials copied.");
    } catch (error) {
      notify(error?.message || "Could not copy credentials.", "error");
    }
  }

  function downloadCredentials(type) {
    const credentials = lastResults[type]?.credentials || [];
    if (!credentials.length) return;
    if (!window.Papa?.unparse) {
      notify("The CSV writer could not be loaded.", "error");
      return;
    }
    const spreadsheetSafe = (value) => {
      const text = String(value ?? "");
      return /^[\u0000-\u0020]*[=+\-@]/u.test(text) ? `'${text}` : text;
    };
    const csv = window.Papa.unparse(credentials.map((item) => ({
      name: spreadsheetSafe(item.name),
      email: spreadsheetSafe(item.email),
      default_password: spreadsheetSafe(item.default_password),
    })));
    downloadBlob(
      new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
      `${type}-credentials-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  async function submitImport(type) {
    const rows = parsedRows[type];
    if (!rows?.length || importing[type]) return;
    const schoolId = selectedSchoolId();
    if (!schoolId) {
      setStatus(type, "Select or link a school before importing.", true);
      return;
    }
    if (
      lastResults[type]?.credentials?.length &&
      !window.confirm("This will replace the previous one-time credential list on this page. Copy or download it before continuing. Continue?")
    ) {
      return;
    }
    const school = schoolSelect?.selectedOptions?.[0]?.textContent;
    if (!window.confirm(`Create accounts for ${rows.length} ${type} in ${school || "your linked school"}? Existing emails will be skipped.`)) {
      return;
    }

    importing[type] = true;
    updateSubmitButtons();
    const logoutButton = document.getElementById("logoutBtn");
    const logoutWasDisabled = logoutButton?.disabled ?? false;
    if (logoutButton) logoutButton.disabled = true;
    setStatus(type, `Importing ${rows.length} ${type}…`);
    try {
      const user = getCurrentUser();
      const payload = { rows };
      if (user?.role === "superadmin") payload.school_id = schoolId;
      const result = await api(IMPORT_PATHS[type], { method: "POST", body: payload });
      const input = document.getElementById(
        type === "students" ? "bulkImportStudentsFile" : "bulkImportTeachersFile",
      );
      const preview = document.getElementById(
        type === "students" ? "bulkImportStudentsPreview" : "bulkImportTeachersPreview",
      );
      parsedRows[type] = null;
      if (input) input.value = "";
      if (preview) preview.innerHTML = "";
      renderResult(type, result);
      setStatus(
        type,
        `Import complete. Share credentials with ${type}. Created: ${result.created_count} · Skipped: ${result.skipped_count} · Errors: ${result.error_count}.`,
      );
      try {
        await onImportComplete?.();
      } catch (refreshError) {
        notify(`Import succeeded, but the account list could not be refreshed: ${refreshError?.message || "refresh failed"}`, "error");
      }
      await refreshHistory();
    } catch (error) {
      setStatus(type, error?.message || "The import could not be completed.", true);
    } finally {
      importing[type] = false;
      if (logoutButton) logoutButton.disabled = logoutWasDisabled;
      updateSubmitButtons();
    }
  }

  document.getElementById("bulkImportStudentsTemplate")?.addEventListener(
    "click",
    () => downloadTemplate("students"),
  );
  document.getElementById("bulkImportTeachersTemplate")?.addEventListener(
    "click",
    () => downloadTemplate("teachers"),
  );
  document.getElementById("bulkImportStudentsFile")?.addEventListener("change", (event) => {
    handleFile("students", event.currentTarget.files?.[0]);
  });
  document.getElementById("bulkImportTeachersFile")?.addEventListener("change", (event) => {
    handleFile("teachers", event.currentTarget.files?.[0]);
  });
  document.getElementById("bulkImportStudentsSubmit")?.addEventListener(
    "click",
    () => submitImport("students"),
  );
  document.getElementById("bulkImportTeachersSubmit")?.addEventListener(
    "click",
    () => submitImport("teachers"),
  );
  schoolSelect?.addEventListener("change", async () => {
    const nextSchool = schoolSelect.value;
    if (nextSchool === lastSelectedSchool) return;
    if (
      hasOneTimeCredentials() &&
      !window.confirm("Changing schools will clear one-time credentials from this page. Continue?")
    ) {
      schoolSelect.value = lastSelectedSchool;
      return;
    }
    clearImportStates();
    lastSelectedSchool = nextSchool;
    schoolMessage.textContent = nextSchool
      ? "Imports will be assigned to the selected school."
      : "Select a school before importing or viewing its history.";
    updateSubmitButtons();
    await refreshHistory();
  });

  return {
    async setUser(user) {
      const nextUserKey = user
        ? `${user.id || ""}|${user.role || ""}|${user.impersonatedBy || ""}`
        : null;
      if (nextUserKey !== activeUserKey) {
        clearImportStates();
        activeUserKey = nextUserKey;
      }
      await refresh();
    },
    refresh,
    refreshHistory,
    clearSensitiveResults: clearImportStates,
  };
}