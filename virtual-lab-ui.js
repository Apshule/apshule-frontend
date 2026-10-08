import { createLabSimulator } from "./lab-simulators.js";

const LEVELS = [
  ["primary", "Primary (P4–P7)"],
  ["o_level", "O-Level (S1–S4)"],
  ["a_level", "A-Level (S5–S6)"],
];
const SUBJECTS = ["Science", "Physics", "Chemistry", "Biology"];
const ICONS = {
  flask: "fa-flask",
  class: "fa-chalkboard-user",
  chart: "fa-chart-column",
  play: "fa-play",
  reset: "fa-rotate-left",
  close: "fa-xmark",
  arrow: "fa-arrow-left",
  video: "fa-video",
  download: "fa-download",
  pen: "fa-pen",
  highlighter: "fa-highlighter",
  eraser: "fa-eraser",
  text: "fa-font",
  shape: "fa-shapes",
  trash: "fa-trash-can",
  save: "fa-floppy-disk",
  people: "fa-users",
  record: "fa-circle",
  pause: "fa-stop",
  retry: "fa-rotate",
};

export function initVirtualLabUI({ api, getCurrentUser, notify = () => {}, escapeHtml = (value) => String(value ?? ""), t = (key) => key } = {}) {
  if (typeof api !== "function") throw new TypeError("Virtual Lab requires the existing api callback.");
  const doc = document;
  const rootId = "apshuleVirtualLab";
  let currentUser = null;
  let active = false;
  let view = "catalog";
  let currentExperiment = null;
  let currentSession = null;
  let currentSim = null;
  let currentTab = "experiments";
  let catalog = [];
  let progressRows = [];
  let classProgressRows = [];
  let classProgressLevel = "";
  let classProgressLoading = false;
  let pollTimer = 0;
  let elapsedTimer = 0;
  let identityCheckTimer = 0;
  let pollBusy = false;
  let boardCanvas = null;
  let boardContext = null;
  let boardEvents = [];
  let seenEvents = new Set();
  let lastBoardTs = 0;
  let boardTool = "pen";
  let boardColor = "#287d76";
  let boardWidth = 4;
  let boardDrawing = false;
  let boardStart = null;
  let boardPoints = [];
  let recorder = null;
  let recorderStream = null;
  let recordingStopPromise = null;
  let resolveRecordingStop = null;
  let recordingStarting = false;
  let recordingGeneration = 0;
  let recorderChunks = [];
  let recorderStartedAt = 0;
  let recordingBlob = null;
  let lastLocalRecordingUrl = null;
  let identityKey = "";
  let uiRoot = null;
  let lastFocusedElement = null;
  let addedLaunchers = [];
  let stylesheetLink = null;
  let attendanceTimer = 0;
  let captureSourceStreams = [];
  let destroyed = false;
  let currentLanguage = "en";
  const translations = new Map();
  const translationLoads = new Map();
  let catalogLoaded = false;
  let sessionsLoading = false;
  let launcherUiReady = false;
  const cleanupFns = [];
  const translate = (key, fallback, vars) => {
    let template = translations.get(currentLanguage)?.[key] || translations.get("en")?.[key];
    try {
      if (!template && typeof t === "function") {
        const value = t(key, vars);
        if (value && value !== key) template = value;
      }
    } catch {
      template = "";
    }
    template ||= fallback;
    return Object.entries(vars || {}).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), template);
  };
  const tr = (key, fallback) => translate(`lab_${key}`, fallback);

  function normalizeStrings(response, language) {
    let source = response?.strings ?? response?.translations ?? response?.data?.strings ?? response?.data?.translations ?? response?.data ?? response;
    if (source && !Array.isArray(source) && typeof source === "object" && source[language] && typeof source[language] === "object") {
      source = source[language];
    }
    if (Array.isArray(source)) {
      return Object.fromEntries(source
        .filter((item) => item && typeof item.key === "string")
        .map((item) => [item.key, item.value ?? item.translation ?? ""])
        .filter(([, value]) => typeof value === "string"));
    }
    if (!source || typeof source !== "object") return {};
    return Object.fromEntries(Object.entries(source).flatMap(([key, value]) => {
      if (typeof value === "string") return [[key, value]];
      if (value && typeof value === "object") {
        const localized = value[language] ?? value.translation ?? value.value ?? value.text;
        if (typeof localized === "string") return [[key, localized]];
      }
      return [];
    }));
  }

  function normalizedLanguage(user) {
    const parts = String(user?.language || "en").trim().replace("_", "-").split("-");
    const language = parts[0]?.toLowerCase() || "en";
    const region = parts[1]?.toUpperCase();
    if (!/^[a-z]{2,3}$/.test(language) || (region && !/^[A-Z]{2}$/.test(region))) return "en";
    return region ? `${language}-${region}` : language;
  }

  function loadLanguage(language) {
    if (translationLoads.has(language)) return translationLoads.get(language);
    const request = Promise.resolve()
      .then(() => api(`/api/settings/i18n/strings?lang=${encodeURIComponent(language)}`))
      .then((response) => {
        translations.set(language, normalizeStrings(response, language));
      })
      .catch((error) => {
        translations.set(language, {});
        if (language === "en") console.warn("Virtual Lab English translations unavailable; using bundled fallbacks.", error);
      });
    translationLoads.set(language, request);
    return request;
  }

  async function ensureTranslations(user = currentUser) {
    const language = normalizedLanguage(user);
    await Promise.all([loadLanguage("en"), language !== "en" ? loadLanguage(language) : Promise.resolve()]);
    currentLanguage = language;
    launcherUiReady = true;
  }

  function node(tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function icon(name) {
    const i = node("i", `fas ${ICONS[name] || "fa-circle"}`);
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  function button(text, action, iconName, className = "vl-button", title = "") {
    const element = node("button", className);
    element.type = "button";
    if (iconName) element.append(icon(iconName));
    const caption = node("span", "", text);
    element.append(caption);
    if (title) element.title = title;
    element.dataset.labAction = action || "";
    return element;
  }

  function safeText(value) {
    return String(value ?? "");
  }

  function addStylesheet() {
    if (doc.querySelector('link[data-apshule-virtual-lab-styles]')) return;
    const link = node("link");
    link.rel = "stylesheet";
    link.href = new URL("./virtual-lab-ui.css", import.meta.url).href;
    link.dataset.apshuleVirtualLabStyles = "true";
    doc.head.append(link);
    stylesheetLink = link;
  }

  function isTeacher() {
    const role = String(currentUser?.role || currentUser?.user_type || "").toLowerCase();
    return role === "teacher";
  }

  function isLearner() {
    return String(currentUser?.role || currentUser?.user_type || "").toLowerCase() === "individual";
  }

  function canViewClassProgress() {
    const role = String(currentUser?.role || currentUser?.user_type || "").toLowerCase();
    return role === "teacher" || role === "school";
  }

  function classProgressLevels() {
    const all = ["P4", "P5", "P6", "P7", "S1", "S2", "S3", "S4", "S5", "S6"];
    const role = String(currentUser?.role || currentUser?.user_type || "").toLowerCase();
    if (role !== "teacher") return all;
    const assigned = currentUser?.assigned_classes || currentUser?.assignedClasses || [];
    if (!Array.isArray(assigned)) return [];
    return [...new Set(assigned.map((value) => String(value).trim().toUpperCase()).filter((value) => all.includes(value)))];
  }

  function userLevel() {
    const raw = String(currentUser?.class_level || currentUser?.level || "").toLowerCase().replaceAll("-", "_");
    if (raw.includes("primary") || /^p[4-7]$/.test(raw)) return "primary";
    if (raw.includes("a_level") || raw.includes("alevel") || /^s[56]$/.test(raw)) return "a_level";
    if (raw.includes("o_level") || raw.includes("olevel") || /^s[1-4]$/.test(raw)) return "o_level";
    return "";
  }

  function labLevelForClass(classLevel) {
    const level = String(classLevel || "").toUpperCase();
    if (/^P[4-7]$/.test(level)) return "primary";
    if (/^S[1-4]$/.test(level)) return "o_level";
    if (/^S[56]$/.test(level)) return "a_level";
    return "";
  }

  function appendLaunchers() {
    if (!launcherUiReady || destroyed) return;
    const home = doc.querySelector("#homePage");
    if (home && !home.querySelector("[data-apshule-lab-launcher='student']")) {
      const section = node("section", "vl-launcher vl-launcher-student");
      section.dataset.apshuleLabLauncher = "student";
      section.setAttribute("aria-label", tr("title", "Virtual Lab"));
      const ornament = node("span", "vl-launcher-mark");
      ornament.append(icon("flask"));
      const copy = node("span", "vl-launcher-copy");
      copy.append(node("strong", "", tr("title", "Virtual Lab")));
      copy.append(node("small", "", tr("launcher_student_desc", "Explore interactive science experiments for your class.")));
      const open = button(tr("open_lab", "Open the lab"), "open", "arrow", "vl-button vl-button-accent");
      section.append(ornament, copy, open);
      home.append(section);
      addedLaunchers.push(section);
      open.addEventListener("click", openLab);
    }
    const grid = doc.querySelector("#teacherDashboard .teacher-dashboard-grid");
    if (grid && !grid.querySelector("[data-apshule-lab-launcher='teacher']")) {
      const card = button("", "open", null, "teacher-tool-card vl-teacher-launcher");
      card.dataset.apshuleLabLauncher = "teacher";
      const mark = node("span", "teacher-tool-icon");
      mark.append(icon("flask"));
      const title = node("strong", "", tr("title", "Virtual Lab"));
      const description = node("small", "", tr("launcher_teacher_desc", "Teach live, share a board and explore experiments."));
      const count = node("span", "teacher-tool-count", tr("live_lab", "Open lab"));
      const detail = node("small", "", tr("experiments_and_sessions", "Experiments and sessions"));
      card.append(mark, title, description, count, detail);
      grid.append(card);
      addedLaunchers.push(card);
      card.addEventListener("click", openLab);
    }
  }

  function showNotice(message, type = "error", parent = uiRoot?.querySelector(".vl-notice")) {
    if (!parent) return;
    parent.textContent = message;
    parent.className = `vl-notice is-${type}`;
    parent.hidden = false;
  }

  function clearNotice() {
    const notice = uiRoot?.querySelector(".vl-notice");
    if (notice) {
      notice.textContent = "";
      notice.hidden = true;
    }
  }

  function makeRoot() {
    if (uiRoot) return uiRoot;
    uiRoot = node("div", "vl-overlay");
    uiRoot.id = rootId;
    uiRoot.hidden = true;
    uiRoot.setAttribute("aria-label", tr("title", "Virtual Lab"));
    uiRoot.addEventListener("click", onRootClick);
    uiRoot.addEventListener("keydown", onRootKeydown);
    doc.body.append(uiRoot);
    return uiRoot;
  }

  async function openLab() {
    if (destroyed) return;
    if (!active) lastFocusedElement = doc.activeElement;
    try {
      const latestUser = await getCurrentUser?.();
      await setUser(latestUser || null);
    } catch {
      await ensureTranslations(currentUser);
    }
    if (!currentUser) {
      appendLaunchers();
      notify(tr("sign_in_required", "Sign in to open the Virtual Lab."), "error");
      return;
    }
    if (!isTeacher() && !isLearner()) {
      notify(tr("access_denied", "This account cannot open the Virtual Lab."), "error");
      return;
    }
    await ensureTranslations(currentUser);
    appendLaunchers();
    showLab();
  }

  function showLab() {
    if (!launcherUiReady || destroyed) return;
    active = true;
    if (!identityCheckTimer) {
      identityCheckTimer = window.setInterval(() => {
        if (!active || typeof getCurrentUser !== "function") return;
        Promise.resolve().then(() => getCurrentUser()).then((user) => {
          const nextKey = user ? `${user.id || user.user_id || user.email || ""}:${user.role || user.user_type || ""}:${normalizedLanguage(user)}` : "";
          if (nextKey !== identityKey) setUser(user || null);
        }).catch(() => {});
      }, 3000);
    }
    makeRoot();
    uiRoot.hidden = false;
    doc.body.classList.add("vl-open");
    renderLoading();
    uiRoot.querySelector('[data-lab-action="close"]')?.focus();
    loadCatalog();
    loadProgress();
    loadSessions();
  }

  function onRootClick(event) {
    const target = event.target.closest("[data-lab-action]");
    if (!target || !uiRoot.contains(target)) return;
    const action = target.dataset.labAction;
    if (action === "close") closeLab();
    if (action === "leave-session") goBack();
    if (action === "back") goBack();
    if (action === "retry") retryView();
    if (action === "filter") applyFilters();
    if (action === "experiment") openExperiment(target.dataset.id);
    if (action === "tab") selectTab(target.dataset.tab);
    if (action === "run-sim") currentSim?.run();
    if (action === "reset-sim") resetSimulator();
    if (action === "create-session") showCreateSession();
    if (action === "join-session") joinSession(target.dataset.id);
    if (action === "start-session") startSession();
    if (action === "end-session") endSession();
    if (action === "tool") setBoardTool(target.dataset.tool);
    if (action === "clear-board") clearBoard();
    if (action === "save-board") saveBoardPng();
    if (action === "record") startRecording();
    if (action === "stop-record") stopRecording(true);
    if (action === "download-record") downloadRecording();
    if (action === "session-recording") downloadServerRecording();
    if (action === "dismiss-dialog") target.closest(".vl-dialog-backdrop")?.remove();
  }

  function onRootKeydown(event) {
    if (event.key === "Escape" && active && !event.target.closest(".vl-dialog")) closeLab();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && view === "session") {
      event.preventDefault();
      saveBoardPng();
    }
    if (event.key === "Tab") {
      const focusScope = uiRoot.querySelector(".vl-dialog") || uiRoot.querySelector(".vl-shell");
      const focusable = [...(focusScope?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex="0"]') || [])]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!focusScope?.contains(doc.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function renderShell(title = tr("title", "Virtual Lab")) {
    uiRoot.replaceChildren();
    const shell = node("section", "vl-shell");
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-labelledby", "vl-page-title");
    const top = node("header", "vl-topbar");
    const brand = node("div", "vl-brand");
    const brandMark = node("span", "vl-brand-mark");
    brandMark.append(icon("flask"));
    brand.append(brandMark);
    const brandText = node("span", "vl-brand-text");
    brandText.append(node("strong", "", tr("title", "Virtual Lab")), node("small", "", tr("brand_line", "APSHULE science studio")));
    brand.append(brandText);
    const topActions = node("div", "vl-top-actions");
    const close = button(tr("close", "Close"), "close", "close", "vl-icon-button");
    close.setAttribute("aria-label", tr("close_lab", "Close Virtual Lab"));
    topActions.append(close);
    top.append(brand, topActions);
    const main = node("main", "vl-main");
    const heading = node("div", "vl-page-heading");
    const back = button(tr("back", "Back"), "back", "arrow", "vl-back-button");
    back.hidden = view === "catalog" && !currentExperiment && !currentSession;
    const titleEl = node("h1", "", title);
    titleEl.id = "vl-page-title";
    heading.append(back, titleEl);
    const notice = node("div", "vl-notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.hidden = true;
    main.append(heading, notice);
    const content = node("div", "vl-content");
    main.append(content);
    shell.append(top, main);
    uiRoot.append(shell);
    return { shell, main, content, notice, back, title: titleEl };
  }

  function renderLoading(message = tr("loading", "Loading your lab…"), targetView = "catalog") {
    view = targetView;
    const { content } = renderShell();
    const loading = node("div", "vl-loading");
    loading.setAttribute("role", "status");
    for (let i = 0; i < 3; i += 1) loading.append(node("span", "vl-skeleton"));
    loading.append(node("span", "vl-loading-copy", message));
    content.append(loading);
  }

  async function loadCatalog(level = isTeacher() ? "" : userLevel(), subject = "") {
    if (!active) return;
    view = "catalog";
    catalogLoaded = false;
    renderLoading(tr("loading_experiments", "Loading experiments…"));
    const params = new URLSearchParams();
    if (level) params.set("level", level);
    if (subject) params.set("subject", subject);
    try {
      const response = await api(`/api/lab/experiments${params.size ? `?${params}` : ""}`);
      if (!active) return;
      catalog = Array.isArray(response?.experiments) ? response.experiments : [];
      catalogLoaded = true;
      renderCatalog();
    } catch (error) {
      if (!active) return;
      renderError(tr("load_experiments_error", "Experiments could not be loaded."), () => loadCatalog(level, subject), error);
    }
  }

  async function loadProgress() {
    try {
      if (isTeacher()) return;
      const response = await api("/api/lab/progress/me");
      progressRows = Array.isArray(response?.progress) ? response.progress : [];
      if (active && view === "catalog" && catalogLoaded) renderCatalog();
    } catch {
      progressRows = [];
    }
  }

  function progressFor(experimentId) {
    return progressRows.find((row) => String(row.experiment_id) === String(experimentId));
  }

  function renderCatalog() {
    if (!active || view !== "catalog") return;
    const { content } = renderShell();
    const intro = node("div", "vl-intro");
    const eyebrow = node("p", "vl-eyebrow", isTeacher() ? tr("teacher_workspace", "Teacher workspace") : tr("student_workspace", "Your science workspace"));
    intro.append(eyebrow, node("p", "vl-intro-copy", tr("catalog_intro", "Choose an experiment, change one variable and see what happens.")));
    {
      const tabs = node("div", "vl-tabs");
      tabs.setAttribute("role", "tablist");
      const expTab = button(tr("experiments", "Experiments"), "tab", "flask", `vl-tab ${currentTab === "experiments" ? "is-active" : ""}`);
      expTab.dataset.tab = "experiments";
      expTab.setAttribute("role", "tab");
      expTab.setAttribute("aria-selected", String(currentTab === "experiments"));
      const sessionTab = button(tr("live_sessions", "Live sessions"), "tab", "class", `vl-tab ${currentTab === "sessions" ? "is-active" : ""}`);
      sessionTab.dataset.tab = "sessions";
      sessionTab.setAttribute("role", "tab");
      sessionTab.setAttribute("aria-selected", String(currentTab === "sessions"));
      tabs.append(expTab, sessionTab);
      if (canViewClassProgress()) {
        const progressTab = button(tr("class_progress", "Class progress"), "tab", "chart", `vl-tab ${currentTab === "progress" ? "is-active" : ""}`);
        progressTab.dataset.tab = "progress";
        progressTab.setAttribute("role", "tab");
        progressTab.setAttribute("aria-selected", String(currentTab === "progress"));
        tabs.append(progressTab);
      }
      intro.append(tabs);
    }
    content.append(intro);
    if (currentTab === "sessions") {
      renderSessions(content);
      return;
    }
    if (currentTab === "progress" && canViewClassProgress()) {
      renderClassProgress(content);
      return;
    }
    const filters = node("div", "vl-filters");
    const levelLabel = node("label", "vl-filter");
    levelLabel.append(node("span", "", tr("level_filter", "Class level")));
    const levelSelect = node("select");
    levelSelect.dataset.labFilter = "level";
    levelSelect.setAttribute("aria-label", tr("level_filter", "Class level"));
    const allLevel = node("option", "", tr("all_levels", "All levels"));
    allLevel.value = "";
    levelSelect.append(allLevel);
    LEVELS.forEach(([value, name]) => {
      const option = node("option", "", translate(`lab_level_${value}`, name));
      option.value = value;
      levelSelect.append(option);
    });
    levelSelect.value = isTeacher() ? "" : userLevel();
    if (!isTeacher()) levelSelect.disabled = true;
    levelLabel.append(levelSelect);
    const subjectLabel = node("label", "vl-filter");
    subjectLabel.append(node("span", "", tr("subject_filter", "Subject")));
    const subjectSelect = node("select");
    subjectSelect.dataset.labFilter = "subject";
    subjectSelect.setAttribute("aria-label", tr("subject_filter", "Subject"));
    const anySubject = node("option", "", tr("all_subjects", "All subjects"));
    anySubject.value = "";
    subjectSelect.append(anySubject);
    SUBJECTS.forEach((subject) => {
      const option = node("option", "", translate(`lab_subject_${subject.toLowerCase()}`, subject));
      option.value = subject;
      subjectSelect.append(option);
    });
    subjectLabel.append(subjectSelect);
    const filterButton = button(tr("apply_filters", "Apply filters"), "filter", null, "vl-button vl-button-soft");
    filters.append(levelLabel, subjectLabel, filterButton);
    content.append(filters);
    const catalogHeader = node("div", "vl-section-heading");
    catalogHeader.append(node("h2", "", tr("experiment_catalog", "Experiment catalogue")));
    catalogHeader.append(node("span", "vl-count", `${catalog.length} ${tr("available", "available")}`));
    content.append(catalogHeader);
    if (!catalog.length) {
      const empty = node("div", "vl-empty");
      const mark = node("span", "vl-empty-icon");
      mark.append(icon("flask"));
      empty.append(mark);
      empty.append(node("h3", "", tr("no_experiments", "No experiments found")));
      empty.append(node("p", "", tr("no_experiments_detail", "Try another class level or subject filter.")));
      content.append(empty);
      return;
    }
    const grid = node("div", "vl-experiment-grid");
    catalog.forEach((experiment, index) => grid.append(renderExperimentCard(experiment, index)));
    content.append(grid);
  }

  function renderClassProgress(content) {
    const header = node("div", "vl-section-heading vl-session-heading");
    header.append(node("h2", "", tr("class_progress", "Class progress")));
    content.append(header);
    const levels = classProgressLevels();
    if (!levels.length) {
      const empty = node("div", "vl-empty");
      empty.append(node("h3", "", tr("no_assigned_classes", "No assigned classes")));
      empty.append(node("p", "", tr("no_assigned_classes_detail", "Ask your school administrator to assign classes before viewing learner progress.")));
      content.append(empty);
      return;
    }
    const controls = node("div", "vl-progress-toolbar");
    const label = node("label", "vl-filter");
    label.append(node("span", "", tr("class_level", "Class level")));
    const select = node("select");
    select.setAttribute("aria-label", tr("class_level", "Class level"));
    if (!levels.includes(classProgressLevel)) classProgressLevel = levels[0];
    levels.forEach((level) => {
      const option = node("option", "", level);
      option.value = level;
      select.append(option);
    });
    select.value = classProgressLevel;
    select.addEventListener("change", () => loadClassProgress(select.value));
    label.append(select);
    controls.append(label);
    content.append(controls);
    if (classProgressLoading) {
      content.append(node("p", "vl-loading-copy", tr("loading_class_progress", "Loading class progress…")));
      return;
    }
    if (!classProgressRows.length) {
      const empty = node("div", "vl-empty");
      empty.append(node("h3", "", tr("no_class_progress", "No learner progress yet")));
      empty.append(node("p", "", tr("no_class_progress_detail", "Progress will appear here when learners complete an experiment.")));
      content.append(empty);
      return;
    }
    const learners = new Map();
    classProgressRows.forEach((row) => {
      if (!row?.student_id) return;
      let learner = learners.get(row.student_id);
      if (!learner) {
        learner = {
          name: row.student_name || tr("learner", "Learner"),
          completed: new Set(),
          attempts: 0,
          bestScore: null,
        };
        learners.set(row.student_id, learner);
      }
      if (row.experiment_id && row.completed) learner.completed.add(row.experiment_id);
      learner.attempts += Number(row.attempts || 0);
      if (row.best_score !== null && row.best_score !== undefined) {
        learner.bestScore = Math.max(learner.bestScore ?? 0, Number(row.best_score));
      }
    });
    const wrap = node("div", "vl-progress-table-wrap");
    const table = node("table", "vl-progress-table");
    const head = node("thead");
    const headerRow = node("tr");
    [
      tr("learner", "Learner"),
      tr("experiments_completed", "Experiments completed"),
      tr("attempts", "Attempts"),
      tr("best_score", "Best score"),
    ].forEach((caption) => headerRow.append(node("th", "", caption)));
    head.append(headerRow);
    table.append(head);
    const body = node("tbody");
    [...learners.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((learner) => {
      const row = node("tr");
      row.append(node("th", "vl-progress-student", learner.name));
      row.append(node("td", "", String(learner.completed.size)));
      row.append(node("td", "", String(learner.attempts)));
      row.append(node("td", "", learner.bestScore === null ? "—" : `${learner.bestScore}%`));
      body.append(row);
    });
    table.append(body);
    wrap.append(table);
    content.append(wrap);
  }

  async function loadClassProgress(level = classProgressLevel) {
    const levels = classProgressLevels();
    const selected = levels.includes(level) ? level : levels[0];
    if (!selected) return;
    classProgressLevel = selected;
    classProgressLoading = true;
    if (active && view === "catalog" && currentTab === "progress") renderCatalog();
    try {
      const response = await api(`/api/lab/progress/class?level=${encodeURIComponent(selected)}`);
      classProgressRows = Array.isArray(response?.progress) ? response.progress : [];
    } catch (error) {
      classProgressRows = [];
      showNotice(tr("class_progress_error", "Class progress could not be loaded."), "error");
      console.error("Virtual Lab class progress load failed", error);
    } finally {
      classProgressLoading = false;
      if (active && view === "catalog" && currentTab === "progress") renderCatalog();
    }
  }

  function renderExperimentCard(experiment, index) {
    const card = node("article", "vl-experiment-card");
    card.style.setProperty("--card-order", String(index));
    const top = node("div", "vl-card-meta");
    const subject = node("span", "vl-chip", safeText(experiment.subject || tr("science", "Science")));
    const level = LEVELS.find(([value]) => value === experiment.level)?.[1] || safeText(experiment.level);
    top.append(subject, node("span", "vl-level", translate(`lab_level_${experiment.level}`, level)));
    const mark = node("div", "vl-card-mark");
    mark.append(icon("flask"));
    const title = node("h3", "", safeText(experiment.title));
    const description = node("p", "vl-card-description", safeText(experiment.description || ""));
    const outcomes = Array.isArray(experiment.learning_outcomes) ? experiment.learning_outcomes : [];
    const progress = progressFor(experiment.id);
    const foot = node("div", "vl-card-foot");
    const progressText = progress?.completed ? tr("completed", "Completed") : progress?.attempts ? translate("lab_attempt_count", "Attempts: {count}", { count: progress.attempts }) : tr("not_started", "Not started");
    foot.append(node("span", "vl-progress-label", progressText));
    const open = button(tr("open_experiment", "Open experiment"), "experiment", "arrow", "vl-button vl-button-accent");
    open.dataset.id = experiment.id;
    foot.append(open);
    card.append(top, mark, title, description);
    if (outcomes.length) {
      const outcome = node("p", "vl-card-outcome", safeText(outcomes[0]));
      card.append(outcome);
    }
    card.append(foot);
    return card;
  }

  async function openExperiment(id) {
    view = "experiment";
    renderLoading(tr("loading_simulator", "Preparing the simulator…"), "experiment");
    try {
      const response = await api(`/api/lab/experiments/${encodeURIComponent(id)}`);
      currentExperiment = response?.experiment || null;
      if (!currentExperiment) throw new Error("Experiment response was empty");
      renderExperiment();
    } catch (error) {
      renderError(tr("load_experiment_error", "This experiment could not be opened."), () => openExperiment(id), error);
    }
  }

  function renderExperiment() {
    if (!currentExperiment) return;
    view = "experiment";
    const { content } = renderShell(safeText(currentExperiment.title || tr("experiment", "Experiment")));
    const intro = node("div", "vl-sim-intro");
    intro.append(node("p", "vl-eyebrow", `${safeText(currentExperiment.subject)} · ${safeText(currentExperiment.level)}`));
    intro.append(node("p", "", safeText(currentExperiment.description || "")));
    const outcomes = Array.isArray(currentExperiment.learning_outcomes) ? currentExperiment.learning_outcomes : [];
    if (outcomes.length) {
      const list = node("ul", "vl-outcomes");
      outcomes.forEach((outcome) => list.append(node("li", "", safeText(outcome))));
      intro.append(list);
    }
    content.append(intro);
    const labLayout = node("div", "vl-sim-layout");
    const canvasWrap = node("div", "vl-sim-canvas-wrap");
    const canvas = node("canvas", "vl-simulator-canvas");
    canvas.width = 800;
    canvas.height = 500;
    canvas.setAttribute("aria-label", tr("simulator_canvas", "Interactive science simulation canvas"));
    canvas.setAttribute("role", "img");
    canvas.tabIndex = 0;
    canvasWrap.append(canvas);
    const panel = node("aside", "vl-sim-panel");
    panel.append(node("h2", "", tr("adjust_variables", "Adjust variables")));
    const controls = node("div", "vl-controls");
    panel.append(controls);
    const actions = node("div", "vl-sim-actions");
    actions.append(button(tr("run", "Run"), "run-sim", "play", "vl-button vl-button-accent"));
    actions.append(button(tr("reset", "Reset"), "reset-sim", "reset", "vl-button vl-button-soft"));
    panel.append(actions);
    const completion = node("p", "vl-completion-note", tr("complete_hint", "Run the experiment to record your completed attempt."));
    completion.setAttribute("aria-live", "polite");
    completion.dataset.labCompletion = "true";
    panel.append(completion);
    labLayout.append(canvasWrap, panel);
    content.append(labLayout);
    const simulatorType = safeText(currentExperiment.simulator_type || "plant_growth");
    currentSim?.destroy();
    currentSim = createLabSimulator(canvas, controls, simulatorType, {
      config: currentExperiment.config || {},
      t: (key, fallback, vars) => translate(`lab_sim_${key}`, fallback, vars),
      onComplete: (score) => {
        if (isTeacher()) completion.textContent = tr("preview_complete", "Preview complete. Student progress is not changed.");
        else saveProgress(score, completion);
      },
    });
  }

  async function saveProgress(score, completion) {
    if (!currentExperiment) return;
    completion.textContent = tr("saving_progress", "Experiment complete. Saving your result…");
    try {
      const response = await api("/api/lab/progress", {
        method: "POST",
        body: { experiment_id: currentExperiment.id, score },
      });
      const row = response?.progress;
      if (!row) throw new Error("Progress response was empty");
      const found = progressRows.findIndex((item) => item.experiment_id === row.experiment_id);
      if (found >= 0) progressRows[found] = row;
      else progressRows.push(row);
      completion.textContent = translate("lab_completion_saved", "Attempt recorded · score {score}", { score: row.last_score ?? score });
      notify(tr("progress_saved", "Your lab result has been saved."), "success");
    } catch (error) {
      completion.textContent = tr("progress_save_error", "The experiment ran, but your result could not be saved. Retry by running it again.");
      showNotice(tr("progress_save_error", "Your progress could not be saved."), "error");
      console.error("Virtual Lab progress save failed", error);
    }
  }

  function resetSimulator() {
    if (!currentExperiment) return;
    renderExperiment();
  }

  function renderError(message, retry, error) {
    if (!active) return;
    const { content } = renderShell(tr("title", "Virtual Lab"));
    const state = node("div", "vl-error");
    state.append(node("div", "vl-error-mark", "!"));
    state.append(node("h2", "", tr("something_went_wrong", "Something went wrong")));
    state.append(node("p", "", message));
    state.append(button(tr("retry", "Try again"), "retry", "retry", "vl-button vl-button-accent"));
    content.append(state);
    if (error) console.error("Virtual Lab request failed", error);
    retryAction = retry;
  }

  let retryAction = null;
  function retryView() {
    retryAction?.();
  }

  function applyFilters() {
    const level = uiRoot.querySelector('[data-lab-filter="level"]')?.value || "";
    const subject = uiRoot.querySelector('[data-lab-filter="subject"]')?.value || "";
    loadCatalog(level, subject);
  }

  function selectTab(tab) {
    currentTab = tab;
    if (tab === "sessions") {
      renderCatalog();
      loadSessions();
    } else if (tab === "progress" && canViewClassProgress()) {
      loadClassProgress();
    } else {
      currentTab = "experiments";
      renderCatalog();
    }
  }

  let sessions = [];
  async function loadSessions() {
    if (!active) return;
    sessionsLoading = true;
    if (view === "catalog" && currentTab === "sessions") renderCatalog();
    const status = currentTab === "sessions" && isTeacher() ? "" : "started";
    const query = new URLSearchParams();
    if (isTeacher()) query.set("mine", "true");
    if (status) query.set("status", status);
    try {
      const response = await api(`/api/lab/sessions?${query.toString()}`);
      sessions = Array.isArray(response?.sessions) ? response.sessions : [];
      sessionsLoading = false;
      if (active && view === "catalog" && currentTab === "sessions") renderCatalog();
    } catch (error) {
      sessionsLoading = false;
      if (active && currentTab === "sessions") {
        renderError(tr("load_sessions_error", "Live sessions could not be loaded."), loadSessions, error);
      }
    }
  }

  function renderSessions(content) {
    const header = node("div", "vl-section-heading vl-session-heading");
    header.append(node("h2", "", tr("live_sessions", "Live sessions")));
    if (isTeacher()) header.append(button(tr("create_live_session", "Create a live session"), "create-session", "play", "vl-button vl-button-accent"));
    content.append(header);
    if (sessionsLoading) {
      const loading = node("div", "vl-loading");
      loading.setAttribute("role", "status");
      loading.append(node("span", "vl-skeleton"), node("span", "vl-loading-copy", tr("loading_sessions", "Loading live sessions…")));
      content.append(loading);
      return;
    }
    if (!sessions.length) {
      const empty = node("div", "vl-empty");
      const mark = node("span", "vl-empty-icon");
      mark.append(icon("class"));
      empty.append(mark, node("h3", "", tr("no_sessions", "No sessions yet")), node("p", "", isTeacher() ? tr("no_sessions_detail", "Create a live lesson for one of your classes.") : tr("no_live_sessions", "There are no live classes available right now.")));
      content.append(empty);
      return;
    }
    if (!isTeacher()) {
      const refresh = button(tr("refresh_sessions", "Refresh live sessions"), "retry", "retry", "vl-button vl-button-soft");
      retryAction = loadSessions;
      content.append(refresh);
    }
    const list = node("div", "vl-session-list");
    sessions.forEach((session) => {
      const row = node("article", "vl-session-row");
      const statusClass = `vl-status vl-status-${safeText(session.status)}`;
      const info = node("div", "vl-session-info");
      info.append(node("span", statusClass, translate(`lab_status_${session.status}`, safeText(session.status))));
      info.append(node("h3", "", safeText(session.title || tr("live_session", "Live session"))));
      info.append(node("p", "", `${safeText(session.subject)} · ${safeText(session.class_level)}`));
      const date = session.scheduled_for ? new Date(session.scheduled_for) : null;
      if (date && !Number.isNaN(date.getTime())) info.append(node("small", "", date.toLocaleString()));
      const join = button(session.status === "started" ? tr("join_session", "Join session") : tr("open_session", "Open session"), "join-session", "arrow", "vl-button vl-button-soft");
      join.dataset.id = session.id;
      row.append(info, join);
      list.append(row);
    });
    content.append(list);
  }

  function showCreateSession() {
    const dialog = node("div", "vl-dialog-backdrop");
    const form = node("form", "vl-dialog");
    form.setAttribute("aria-labelledby", "vl-session-form-title");
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    const heading = node("div", "vl-dialog-head");
    heading.append(node("h2", "", tr("create_live_session", "Create a live session")));
    const dismiss = button(tr("close", "Close"), "dismiss-dialog", "close", "vl-icon-button");
    heading.append(dismiss);
    form.append(heading);
    form.append(field("session-title", tr("session_title", "Session title"), "text", "", true));
    const availableClasses = isTeacher() ? classProgressLevels() : [];
    const profileClass = String(currentUser?.class_level || "").toUpperCase();
    const defaultClass = availableClasses.includes(profileClass) ? profileClass : availableClasses[0] || "";
    const levelField = selectField("session-level", tr("class_level", "Class level"), availableClasses.map((value) => [value, value]), defaultClass);
    const levelSelect = levelField.querySelector("select");
    if (!availableClasses.length) {
      form.append(node("p", "vl-notice is-error", tr("no_assigned_classes", "No assigned classes")));
    }
    form.append(levelField);
    const subjectSelect = selectField("session-subject", tr("subject", "Subject"), SUBJECTS.map((value) => [value, translate(`lab_subject_${value.toLowerCase()}`, value)]), "Science");
    form.append(subjectSelect);
    const expField = selectField("session-experiment", tr("choose_experiment_optional", "Related experiment (optional)"), [], "");
    const expSelect = expField.querySelector("select");
    const updateExperimentOptions = () => {
      const previous = expSelect.value;
      const level = labLevelForClass(levelSelect.value);
      const experiments = catalog.filter((experiment) => experiment.level === level);
      expSelect.replaceChildren();
      const noExperiment = node("option", "", tr("no_experiment", "No experiment"));
      noExperiment.value = "";
      expSelect.append(noExperiment);
      experiments.forEach((experiment) => {
        const option = node("option", "", safeText(experiment.title));
        option.value = experiment.id;
        expSelect.append(option);
      });
      expSelect.value = experiments.some((experiment) => experiment.id === previous) ? previous : "";
    };
    levelSelect.addEventListener("change", updateExperimentOptions);
    updateExperimentOptions();
    form.append(expField);
    form.append(field("session-scheduled", tr("scheduled_for_optional", "Schedule for (optional)"), "datetime-local", "", false));
    const footer = node("div", "vl-dialog-actions");
    footer.append(button(tr("cancel", "Cancel"), "dismiss-dialog", null, "vl-button vl-button-soft"));
    const submit = button(tr("create_session", "Create session"), "create-session-submit", "play", "vl-button vl-button-accent");
    submit.type = "submit";
    submit.disabled = !availableClasses.length;
    footer.append(submit);
    form.append(footer);
    dialog.append(form);
    uiRoot.append(dialog);
    form.querySelector("#session-title")?.focus();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSession(form);
    });
    dismiss.addEventListener("click", () => dialog.remove());
    footer.querySelector('[data-lab-action="dismiss-dialog"]')?.addEventListener("click", () => dialog.remove());
  }

  function field(id, labelText, type, value, required) {
    const wrap = node("label", "vl-form-field");
    wrap.append(node("span", "", labelText));
    const input = node("input");
    input.id = id;
    input.name = id;
    input.type = type;
    input.value = value;
    input.required = required;
    wrap.append(input);
    return wrap;
  }

  function selectField(id, labelText, options, value) {
    const wrap = node("label", "vl-form-field");
    wrap.append(node("span", "", labelText));
    const select = node("select");
    select.id = id;
    select.name = id;
    options.forEach(([optionValue, caption]) => {
      const option = node("option", "", caption);
      option.value = optionValue;
      select.append(option);
    });
    select.value = value;
    wrap.append(select);
    return wrap;
  }

  async function submitSession(form = uiRoot.querySelector(".vl-dialog")) {
    if (!form) return;
    const title = form.querySelector("#session-title")?.value.trim();
    if (!title) {
      form.querySelector("#session-title")?.focus();
      return;
    }
    const submit = form.querySelector('[data-lab-action="create-session-submit"]');
    submit.disabled = true;
    submit.querySelector("span").textContent = tr("creating", "Creating…");
    const scheduledValue = form.querySelector("#session-scheduled")?.value;
    const body = {
      title,
      class_level: form.querySelector("#session-level")?.value || "",
      subject: form.querySelector("#session-subject")?.value || "",
    };
    const experimentId = form.querySelector("#session-experiment")?.value;
    if (experimentId) body.experiment_id = experimentId;
    if (scheduledValue) body.scheduled_for = new Date(scheduledValue).toISOString();
    try {
      const response = await api("/api/lab/sessions", { method: "POST", body });
      if (!response?.session) throw new Error("Session response was empty");
      currentSession = response.session;
      form.closest(".vl-dialog-backdrop")?.remove();
      await loadSessions();
      openSession(currentSession.id);
    } catch (error) {
      submit.disabled = false;
      submit.querySelector("span").textContent = tr("create_session", "Create session");
      showNotice(tr("create_session_error", "The session could not be created. Please try again."), "error");
      console.error("Virtual Lab session creation failed", error);
    }
  }

  async function joinSession(id) {
    view = "session";
    renderLoading(tr("opening_session", "Opening live session…"), "session");
    try {
      const response = await api(`/api/lab/sessions/${encodeURIComponent(id)}`);
      currentSession = response?.session || null;
      if (!currentSession) throw new Error("Session was not returned");
      renderSession(response);
    } catch (error) {
      renderError(tr("open_session_error", "This session could not be opened."), () => joinSession(id), error);
    }
  }

  async function openSession(id) {
    view = "session";
    renderLoading(tr("opening_session", "Opening live session…"), "session");
    try {
      const response = await api(`/api/lab/sessions/${encodeURIComponent(id)}`);
      currentSession = response?.session || null;
      if (!currentSession) throw new Error("Session was not returned");
      renderSession(response);
    } catch (error) {
      renderError(tr("open_session_error", "This session could not be opened."), () => openSession(id), error);
    }
  }

  async function startSession() {
    if (!currentSession?.id) return;
    try {
      const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/start`, { method: "POST" });
      currentSession = response?.session || currentSession;
      renderSession({ session: currentSession, participant_count: 0, attendance: [] }, response?.jitsi_url);
    } catch (error) {
      showNotice(tr("start_session_error", "The live session could not be started."), "error");
      console.error("Virtual Lab start failed", error);
    }
  }

  async function endSession() {
    if (!currentSession?.id) return;
    await stopRecording(true);
    try {
      const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/end`, { method: "POST" });
      currentSession = response?.session || currentSession;
      stopSessionResources(true);
      await loadSessions();
      renderSession({ session: currentSession, participant_count: currentSession.participant_count || 0, attendance: [] });
      showNotice(tr("session_ended", "This session has ended."), "success");
    } catch (error) {
      showNotice(tr("end_session_error", "The session could not be ended."), "error");
      console.error("Virtual Lab end failed", error);
    }
  }

  let initialJitsiUrl = "";
  function renderSession(response, jitsiUrl = "") {
    view = "session";
    initialJitsiUrl = jitsiUrl || "";
    stopBoardPolling();
    const session = response?.session || currentSession;
    currentSession = session;
    const count = Number(response?.participant_count ?? session?.participant_count ?? (response?.attendance || []).length ?? 0);
    const { content } = renderShell(safeText(session?.title || tr("live_session", "Live session")));
    const statusLine = node("div", "vl-session-status-line");
    statusLine.append(node("span", `vl-status vl-status-${safeText(session?.status)}`, translate(`lab_status_${session?.status}`, safeText(session?.status))));
    statusLine.append(node("span", "", `${safeText(session?.subject)} · ${safeText(session?.class_level)}`));
    content.append(statusLine);
    const liveGrid = node("div", "vl-live-grid");
    const mediaPanel = node("section", "vl-media-panel");
    const mediaHeading = node("div", "vl-panel-heading");
    mediaHeading.append(node("h2", "", tr("live_classroom", "Live classroom")));
    mediaPanel.append(mediaHeading);
    const jitsiFrame = node("iframe", "vl-jitsi-frame");
    jitsiFrame.title = tr("jitsi_title", "Live video classroom");
    jitsiFrame.allow = "camera; microphone; display-capture; autoplay; fullscreen";
    jitsiFrame.referrerPolicy = "no-referrer";
    const roomName = safeText(session?.jitsi_room || "");
    const requestedFrameUrl = session?.status === "started"
      ? initialJitsiUrl || (roomName ? `https://meet.jit.si/${encodeURIComponent(roomName)}` : "")
      : "";
    let frameUrl = "";
    try {
      const parsedFrameUrl = new URL(requestedFrameUrl, window.location.href);
      if (parsedFrameUrl.protocol === "https:" && parsedFrameUrl.hostname === "meet.jit.si") frameUrl = parsedFrameUrl.href;
    } catch {
      frameUrl = "";
    }
    if (frameUrl) jitsiFrame.src = frameUrl;
    else {
      jitsiFrame.hidden = true;
      const unavailable = node("div", "vl-jitsi-empty");
      unavailable.append(node("p", "", tr("jitsi_not_ready", "The video room will appear when the teacher starts this session.")));
      mediaPanel.append(unavailable);
    }
    mediaPanel.append(jitsiFrame);
    const mediaActions = node("div", "vl-media-actions");
    if (isTeacher() && session?.status === "scheduled") mediaActions.append(button(tr("start_session", "Start session"), "start-session", "play", "vl-button vl-button-accent"));
    if (isTeacher() && session?.status === "started") mediaActions.append(button(tr("end_session", "End session"), "end-session", "pause", "vl-button vl-button-danger"));
    if (isLearner() && session?.status === "started") mediaActions.append(button(tr("leave_session", "Leave session"), "leave-session", "arrow", "vl-button vl-button-soft"));
    mediaPanel.append(mediaActions);
    const participants = node("span", "vl-participant-count");
    participants.dataset.labParticipantCount = "true";
    participants.append(icon("people"), node("span", "", translate("lab_participants_count", "Participants · {count}", { count })));
    mediaPanel.append(participants);
    liveGrid.append(mediaPanel);
    const boardPanel = node("section", "vl-board-panel");
    const boardHead = node("div", "vl-panel-heading");
    boardHead.append(node("h2", "", tr("shared_whiteboard", "Shared whiteboard")));
    boardHead.append(node("span", "vl-sync-indicator", tr("live_sync", "Live sync · 1 sec")));
    boardPanel.append(boardHead);
    const toolbar = buildBoardToolbar();
    boardPanel.append(toolbar);
    const boardWrap = node("div", "vl-board-canvas-wrap");
    boardCanvas = node("canvas", "vl-board-canvas");
    boardCanvas.width = 800;
    boardCanvas.height = 500;
    boardCanvas.setAttribute("aria-label", tr("whiteboard_canvas", "Shared whiteboard. Draw with pointer or touch."));
    boardCanvas.setAttribute("role", "application");
    boardCanvas.tabIndex = 0;
    boardContext = boardCanvas.getContext("2d");
    boardContext.fillStyle = "#fffefa";
    boardContext.fillRect(0, 0, 800, 500);
    boardWrap.append(boardCanvas);
    boardPanel.append(boardWrap);
    const recordControls = node("div", "vl-record-controls");
    if (isTeacher() && session?.status === "started") recordControls.append(button(tr("start_recording", "Start recording"), "record", "record", "vl-button vl-button-accent"));
    recordControls.append(button(tr("download_recording", "Download recording"), "session-recording", "download", "vl-button vl-button-soft"));
    const localDownload = button(tr("download_local", "Download local capture"), "download-record", "download", "vl-button vl-button-soft");
    localDownload.hidden = !recordingBlob;
    localDownload.dataset.labLocalDownload = "true";
    recordControls.append(localDownload);
    boardPanel.append(recordControls);
    liveGrid.append(boardPanel);
    content.append(liveGrid);
    setupBoard();
    const activateBoardSync = async () => {
      await loadBoardEvents(true);
      if (active && view === "session" && currentSession?.id === session?.id && session?.status === "started") {
        startBoardPolling();
        startAttendancePolling();
      }
    };
    if (isLearner() && session?.status === "started") {
      api(`/api/lab/sessions/${encodeURIComponent(session.id)}/attendance/join`, { method: "POST" })
        .then(activateBoardSync)
        .catch((error) => {
        showNotice(tr("attendance_join_error", "Your attendance could not be recorded."), "error");
        console.error("Virtual Lab attendance join failed", error);
      });
    } else activateBoardSync();
  }

  function buildBoardToolbar() {
    const toolbar = node("div", "vl-board-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", tr("whiteboard_tools", "Whiteboard tools"));
    const tools = [
      ["pen", "pen", tr("pen", "Pen")],
      ["highlighter", "highlighter", tr("highlighter", "Highlighter")],
      ["eraser", "eraser", tr("eraser", "Eraser")],
      ["text", "text", tr("text_tool", "Text")],
      ["shape", "shape", tr("shape_tool", "Shape")],
    ];
    tools.forEach(([tool, iconName, caption]) => {
      const action = button(caption, "tool", iconName, `vl-tool-button ${boardTool === tool ? "is-active" : ""}`);
      action.dataset.tool = tool;
      action.setAttribute("aria-pressed", String(boardTool === tool));
      action.setAttribute("aria-label", caption);
      toolbar.append(action);
    });
    const colorLabel = node("label", "vl-color-control");
    colorLabel.append(node("span", "", tr("color", "Color")));
    const color = node("input");
    color.type = "color";
    color.value = boardColor;
    color.setAttribute("aria-label", tr("board_color", "Whiteboard ink color"));
    color.addEventListener("input", () => { boardColor = color.value; });
    colorLabel.append(color);
    toolbar.append(colorLabel);
    const widthLabel = node("label", "vl-width-control");
    widthLabel.append(node("span", "", tr("stroke_width", "Width")));
    const width = node("select");
    width.setAttribute("aria-label", tr("stroke_width", "Stroke width"));
    [[3, tr("fine", "Fine")], [6, tr("medium", "Medium")], [12, tr("thick", "Thick")]].forEach(([value, caption]) => {
      const option = node("option", "", caption);
      option.value = value;
      width.append(option);
    });
    width.value = String(boardWidth);
    width.addEventListener("change", () => { boardWidth = Number(width.value); });
    widthLabel.append(width);
    toolbar.append(widthLabel);
    const clear = button(tr("clear_board", "Clear"), "clear-board", "trash", "vl-tool-button");
    const save = button(tr("save_png", "Save PNG"), "save-board", "save", "vl-tool-button");
    const shapePicker = node("select");
    shapePicker.dataset.boardShape = "true";
    shapePicker.setAttribute("aria-label", tr("shape_kind", "Shape type"));
    [["line", tr("line", "Line")], ["rect", tr("rectangle", "Rectangle")], ["circle", tr("ellipse", "Ellipse")]].forEach(([value, caption]) => {
      const option = node("option", "", caption);
      option.value = value;
      shapePicker.append(option);
    });
    shapePicker.hidden = boardTool !== "shape";
    toolbar.append(shapePicker, clear, save);
    return toolbar;
  }

  function setBoardTool(tool) {
    boardTool = tool;
    const toolbar = uiRoot.querySelector(".vl-board-toolbar");
    if (!toolbar) return;
    toolbar.querySelectorAll('[data-lab-action="tool"]').forEach((buttonEl) => {
      const selected = buttonEl.dataset.tool === tool;
      buttonEl.classList.toggle("is-active", selected);
      buttonEl.setAttribute("aria-pressed", String(selected));
    });
    const shapePicker = toolbar.querySelector("[data-board-shape]");
    if (shapePicker) shapePicker.hidden = tool !== "shape";
  }

  function boardPoint(event) {
    const rect = boardCanvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 800,
      y: ((event.clientY - rect.top) / rect.height) * 500,
    };
  }

  function setupBoard() {
    if (!boardCanvas) return;
    const down = (event) => {
      if (currentSession?.status !== "started" || (!isTeacher() && !isLearner())) return;
      const point = boardPoint(event);
      boardCanvas.setPointerCapture?.(event.pointerId);
      if (boardTool === "text") {
        const value = window.prompt(tr("enter_board_text", "Enter text for the whiteboard"));
        if (value?.trim()) saveBoardEvent("text", { x: point.x, y: point.y, text: value.trim(), color: boardColor, size: Math.max(18, boardWidth * 4) });
        return;
      }
      boardDrawing = true;
      boardStart = point;
      boardPoints = [point];
    };
    const move = (event) => {
      if (!boardDrawing) return;
      const point = boardPoint(event);
      boardPoints.push(point);
      renderBoardPreview();
    };
    const up = () => {
      if (!boardDrawing) return;
      boardDrawing = false;
      const points = boardPoints;
      const type = boardTool === "shape" ? "shape" : boardTool === "eraser" ? "erase" : "draw";
      const data = {
        points,
        color: boardColor,
        width: boardTool === "highlighter" ? Math.max(boardWidth * 4, 14) : boardWidth,
        alpha: boardTool === "highlighter" ? 0.26 : 1,
        shape: "line",
      };
      if (type === "shape") data.shape = uiRoot.querySelector("[data-board-shape]")?.value || "line";
      if (type === "shape" && points.length > 1) {
        data.start = points[0];
        data.end = points[points.length - 1];
        delete data.points;
      }
      boardPoints = [];
      saveBoardEvent(type, data);
    };
    boardCanvas.addEventListener("pointerdown", down);
    boardCanvas.addEventListener("pointermove", move);
    boardCanvas.addEventListener("pointerup", up);
    boardCanvas.addEventListener("pointercancel", up);
    boardCanvas._labListeners = { down, move, up };
  }

  function renderBoardPreview() {
    drawBoardEvents(boardEvents);
    if (boardPoints.length < 2) return;
    drawBoardEvent({
      type: boardTool === "eraser" ? "erase" : "draw",
      data: {
        points: boardPoints,
        color: boardColor,
        width: boardTool === "highlighter" ? boardWidth * 4 : boardTool === "eraser" ? boardWidth * 4 : boardWidth,
        alpha: boardTool === "highlighter" ? 0.26 : 1,
      },
    });
  }

  async function saveBoardEvent(type, data) {
    if (!currentSession?.id) return;
    const event = { type, data, ts: Math.max(Date.now(), lastBoardTs + 1) };
    applyBoardEvent(event);
    lastBoardTs = Math.max(lastBoardTs, event.ts);
    try {
      await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/board-event`, {
        method: "POST",
        body: { event },
      });
    } catch (error) {
      showNotice(tr("board_save_error", "This mark could not be shared. Check your connection before continuing."), "error");
      console.error("Virtual Lab board event failed", error);
      await loadBoardEvents(true);
    }
  }

  function eventKey(event) {
    const normalized = normalizeBoardEvent(event);
    return `${normalized?.ts || ""}:${normalized?.type || ""}:${JSON.stringify(normalized?.data || {})}`;
  }

  function normalizeBoardEvent(item) {
    if (item?.event && typeof item.event === "object" && item.event.type) return { ...item.event, id: item.id || item.event.id };
    return item;
  }

  function drawBoardEvent(item) {
    if (!boardContext) return;
    const event = normalizeBoardEvent(item);
    const data = event?.data || {};
    if (event?.type === "clear" || (event?.type === "erase" && data.all)) {
      boardContext.clearRect(0, 0, 800, 500);
      boardContext.fillStyle = "#fffefa";
      boardContext.fillRect(0, 0, 800, 500);
      return;
    }
    if (event?.type === "text") {
      boardContext.save();
      boardContext.fillStyle = data.color || "#243b43";
      boardContext.font = `500 ${Number(data.size) || 20}px "DM Sans", sans-serif`;
      boardContext.fillText(String(data.text || ""), Number(data.x) || 0, Number(data.y) || 0);
      boardContext.restore();
      return;
    }
    if (event?.type === "shape") {
      const start = data.start || data.points?.[0];
      const end = data.end || data.points?.[data.points.length - 1];
      if (!start || !end) return;
      boardContext.save();
      boardContext.globalAlpha = Number(data.alpha) || 1;
      boardContext.strokeStyle = data.color || "#287d76";
      boardContext.lineWidth = Number(data.width) || 3;
      if (data.shape === "rect") boardContext.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      else if (data.shape === "circle") {
        boardContext.beginPath();
        boardContext.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2);
        boardContext.stroke();
      } else {
        boardContext.beginPath();
        boardContext.moveTo(start.x, start.y);
        boardContext.lineTo(end.x, end.y);
        boardContext.stroke();
      }
      boardContext.restore();
      return;
    }
    const points = data.points || [];
    if (!points.length) return;
    boardContext.save();
    if (event.type === "erase") {
      boardContext.globalCompositeOperation = "source-over";
      boardContext.strokeStyle = "#fffefa";
    } else {
      boardContext.globalAlpha = Number(data.alpha) || 1;
      boardContext.strokeStyle = data.color || "#287d76";
    }
    boardContext.lineWidth = Number(data.width) || 4;
    boardContext.lineCap = "round";
    boardContext.lineJoin = "round";
    boardContext.beginPath();
    boardContext.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => boardContext.lineTo(point.x, point.y));
    if (points.length === 1) boardContext.lineTo(points[0].x + 0.1, points[0].y + 0.1);
    boardContext.stroke();
    boardContext.restore();
  }

  function applyBoardEvent(event) {
    const normalized = normalizeBoardEvent(event);
    const key = eventKey(normalized);
    if (seenEvents.has(key)) return;
    seenEvents.add(key);
    boardEvents.push(normalized);
    lastBoardTs = Math.max(lastBoardTs, Number(normalized?.ts) || 0);
    drawBoardEvent(normalized);
  }

  function drawBoardEvents(events) {
    if (!boardContext) return;
    boardContext.clearRect(0, 0, 800, 500);
    boardContext.fillStyle = "#fffefa";
    boardContext.fillRect(0, 0, 800, 500);
    events.forEach(drawBoardEvent);
  }

  async function loadBoardEvents(reload = false) {
    if (!currentSession?.id || !boardCanvas) return;
    try {
      const since = reload ? 0 : Math.max(0, lastBoardTs - 1);
      const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/board-events?since=${since}`);
      const events = Array.isArray(response?.events) ? response.events : [];
      if (reload) {
        boardEvents = [];
        seenEvents = new Set();
        lastBoardTs = 0;
        drawBoardEvents([]);
      }
      events.forEach((item) => applyBoardEvent(normalizeBoardEvent(item)));
      if (reload) drawBoardEvents(boardEvents);
    } catch (error) {
      if (!reload) {
        try {
          await loadBoardEvents(true);
        } catch {
          showNotice(tr("board_recovery_error", "The whiteboard could not reconnect. It will try again shortly."), "error");
        }
      } else {
        showNotice(tr("board_recovery_error", "The whiteboard could not reconnect. It will try again shortly."), "error");
        console.error("Virtual Lab whiteboard replay failed", error);
      }
    }
  }

  function startBoardPolling() {
    stopBoardPolling();
    pollTimer = window.setInterval(async () => {
      if (pollBusy || !active || view !== "session") return;
      pollBusy = true;
      try {
        const since = Math.max(0, lastBoardTs - 1);
        const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/board-events?since=${since}`);
        (Array.isArray(response?.events) ? response.events : []).forEach((item) => applyBoardEvent(normalizeBoardEvent(item)));
      } catch (error) {
        await loadBoardEvents(true);
      } finally {
        pollBusy = false;
      }
    }, 1000);
  }

  function stopBoardPolling() {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    window.clearInterval(attendanceTimer);
    attendanceTimer = 0;
    if (boardCanvas?._labListeners) {
      const { down, move, up } = boardCanvas._labListeners;
      boardCanvas.removeEventListener("pointerdown", down);
      boardCanvas.removeEventListener("pointermove", move);
      boardCanvas.removeEventListener("pointerup", up);
      boardCanvas.removeEventListener("pointercancel", up);
      boardCanvas = null;
      boardContext = null;
    }
  }

  function startAttendancePolling() {
    window.clearInterval(attendanceTimer);
    attendanceTimer = window.setInterval(async () => {
      if (!active || view !== "session" || !currentSession?.id) return;
      try {
        const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}`);
        currentSession = response?.session || currentSession;
        const counter = uiRoot.querySelector("[data-lab-participant-count] span");
        if (counter) counter.textContent = translate("lab_participants_count", "Participants · {count}", {
          count: Number(response?.participant_count ?? (response?.attendance || []).length),
        });
      } catch {
        // Retain the last known count while the network is unavailable.
      }
    }, 5000);
  }

  async function clearBoard() {
    await saveBoardEvent("erase", { all: true });
  }

  function saveBoardPng() {
    if (!boardCanvas) return;
    const link = node("a");
    link.download = `apshule-whiteboard-${currentSession?.id || "session"}.png`;
    link.href = boardCanvas.toDataURL("image/png");
    link.click();
  }

  async function startRecording() {
    if (!currentSession?.id || !isTeacher() || recorder || recordingStarting) return;
    const generation = ++recordingGeneration;
    const sessionId = currentSession.id;
    let sourceStreams = [];
    recordingStarting = true;
    const startButton = uiRoot.querySelector('[data-lab-action="record"]');
    if (startButton) {
      startButton.dataset.labAction = "stop-record";
      startButton.querySelector("span").textContent = tr("stop_recording", "Stop recording");
      startButton.querySelector("i").className = `fas ${ICONS.pause}`;
    }
    try {
      const canvasStream = boardCanvas?.captureStream?.(12);
      if (!canvasStream) throw new Error("Canvas recording is unavailable in this browser.");
      sourceStreams = [canvasStream];
      captureSourceStreams = sourceStreams;
      let audioStream = null;
      try {
        audioStream = await navigator.mediaDevices?.getDisplayMedia?.({ video: true, audio: true });
      } catch {}
      if (!audioStream?.getAudioTracks?.().length) {
        notify(tr("tab_audio_unavailable", "Tab audio was not shared; the whiteboard video will still be recorded."), "warning");
      }
      if (audioStream) sourceStreams.push(audioStream);
      if (generation !== recordingGeneration || !active || view !== "session" || currentSession?.id !== sessionId) {
        sourceStreams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop());
        if (captureSourceStreams === sourceStreams) captureSourceStreams = [];
        return;
      }
      const tracks = [
        ...canvasStream.getVideoTracks(),
        ...(audioStream?.getAudioTracks() || []),
      ];
      recorderStream = new MediaStream(tracks);
      recorderChunks = [];
      recordingBlob = null;
      recorderStartedAt = Date.now();
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
      recorder = new MediaRecorder(recorderStream, { mimeType });
      recordingStarting = false;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) recorderChunks.push(event.data);
      };
    recorder.onstop = async () => {
      try {
        await finishRecording();
      } finally {
        const resolve = resolveRecordingStop;
        recordingStopPromise = null;
        resolveRecordingStop = null;
        resolve?.();
      }
    };
      recorder.start(1000);
      if (startButton) {
        startButton.dataset.labAction = "stop-record";
        startButton.classList.add("vl-button-danger");
        startButton.querySelector("span").textContent = tr("stop_recording", "Stop recording");
        startButton.querySelector("i").className = `fas ${ICONS.pause}`;
      }
      let seconds = 0;
      elapsedTimer = window.setInterval(() => {
        seconds += 1;
        const buttonEl = uiRoot.querySelector('[data-lab-action="stop-record"]');
        if (buttonEl) buttonEl.querySelector("span").textContent = translate("lab_recording_timer", "Stop recording · {seconds}s", { seconds });
        if (seconds >= 180) stopRecording(true);
      }, 1000);
      notify(tr("recording_started", "Recording started. It will stop automatically after 180 seconds."), "success");
    } catch (error) {
      if (generation === recordingGeneration) stopRecording(false);
      else sourceStreams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop());
      showNotice(tr("recording_unavailable", "Recording could not start in this browser. Check media permissions."), "error");
      console.error("Virtual Lab recording start failed", error);
    }
  }

  function stopRecording(shouldUpload) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = 0;
    if (!recorder) recordingGeneration += 1;
    if (!recorder) {
      recordingStarting = false;
      const buttonEl = uiRoot?.querySelector('[data-lab-action="stop-record"]');
      if (buttonEl) {
        buttonEl.dataset.labAction = "record";
        buttonEl.querySelector("span").textContent = tr("start_recording", "Start recording");
        buttonEl.querySelector("i").className = `fas ${ICONS.record}`;
      }
    }
    if (recorder && recorder.state !== "inactive") {
      recorder._uploadAfterStop = Boolean(recorder._uploadAfterStop || shouldUpload);
      if (!recordingStopPromise) {
        recordingStopPromise = new Promise((resolve) => {
          resolveRecordingStop = resolve;
        });
      }
      recorder.stop();
      return recordingStopPromise;
    }
    if (recorder && recordingStopPromise) {
      return recordingStopPromise;
    } else {
      releaseRecordingTracks();
      recorder = null;
    }
    return Promise.resolve();
  }

  async function finishRecording() {
    const finishedRecorder = recorder;
    const shouldUpload = Boolean(finishedRecorder?._uploadAfterStop);
    const recordingSessionId = currentSession?.id;
    const duration = Math.max(1, Math.round((Date.now() - recorderStartedAt) / 1000));
    recordingBlob = new Blob(recorderChunks, { type: finishedRecorder?.mimeType || "video/webm" });
    recorderChunks = [];
    releaseRecordingTracks();
    recorder = null;
    if (!active) {
      recordingBlob = null;
      return;
    }
    if (!recordingBlob.size) {
      recordingBlob = null;
      const emptyRecordButton = uiRoot?.querySelector('[data-lab-action="stop-record"]');
      if (emptyRecordButton) {
        emptyRecordButton.dataset.labAction = "record";
        emptyRecordButton.classList.remove("vl-button-danger");
        emptyRecordButton.querySelector("span").textContent = tr("start_recording", "Start recording");
        emptyRecordButton.querySelector("i").className = `fas ${ICONS.record}`;
      }
      showNotice(tr("recording_empty", "No recording data was captured. Check browser media permissions and try again."), "error");
      return;
    }
    if (lastLocalRecordingUrl) URL.revokeObjectURL(lastLocalRecordingUrl);
    lastLocalRecordingUrl = URL.createObjectURL(recordingBlob);
    const local = uiRoot?.querySelector("[data-lab-local-download]");
    if (local) local.hidden = false;
    const recordButton = uiRoot?.querySelector('[data-lab-action="stop-record"]');
    if (recordButton) {
      recordButton.dataset.labAction = "record";
      recordButton.classList.remove("vl-button-danger");
      recordButton.querySelector("span").textContent = tr("start_recording", "Start recording");
      recordButton.querySelector("i").className = `fas ${ICONS.record}`;
    }
    if (!shouldUpload) return;
    try {
      const base64 = await blobToBase64(recordingBlob);
      if (!active || currentSession?.id !== recordingSessionId) return;
      if (base64.length > 6_000_000 || duration > 180) {
        showNotice(duration > 180
          ? tr("recording_too_long", "This recording exceeded 180 seconds, so it was not uploaded. Download the local WebM instead.")
          : tr("recording_too_large", "This recording exceeds the upload size limit, so it was not uploaded. Download the local WebM instead."), "warning");
        return;
      }
      await api(`/api/lab/sessions/${encodeURIComponent(recordingSessionId)}/recording`, {
        method: "POST",
        body: { recording_base64: base64, duration_seconds: duration },
      });
      notify(tr("recording_uploaded", "Recording saved to this session."), "success");
    } catch (error) {
      showNotice(tr("recording_upload_error", "The recording stayed on this device because it could not be uploaded. Use Download local capture."), "error");
      console.error("Virtual Lab recording upload failed", error);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Recording conversion failed"));
      reader.readAsDataURL(blob);
    });
  }

  function releaseRecordingTracks() {
    const tracks = new Set([
      ...(recorderStream?.getTracks() || []),
      ...captureSourceStreams.flatMap((stream) => stream.getTracks()),
    ]);
    tracks.forEach((track) => track.stop());
    recorderStream = null;
    captureSourceStreams = [];
  }

  function clearLocalRecording() {
    if (lastLocalRecordingUrl) URL.revokeObjectURL(lastLocalRecordingUrl);
    lastLocalRecordingUrl = null;
    recordingBlob = null;
    recorderChunks = [];
  }

  function downloadRecording() {
    if (!recordingBlob || !lastLocalRecordingUrl) {
      notify(tr("no_local_recording", "There is no local recording to download yet."), "info");
      return;
    }
    downloadUrl(lastLocalRecordingUrl, `apshule-lab-${currentSession?.id || "recording"}.webm`);
  }

  async function downloadServerRecording() {
    if (!currentSession?.id) return;
    try {
      const response = await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/recording`);
      const base64 = response?.recording_base64;
      if (!base64) throw new Error("No recording was returned");
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: response.mime_type || "video/webm" });
      downloadUrl(URL.createObjectURL(blob), `apshule-lab-${currentSession.id}.webm`, true);
    } catch (error) {
      showNotice(tr("recording_download_unavailable", "No saved recording is available for this session."), "error");
      console.error("Virtual Lab recording download failed", error);
    }
  }

  function downloadUrl(url, filename, revoke = false) {
    const link = node("a");
    link.href = url;
    link.download = filename;
    link.click();
    if (revoke) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function leaveSession() {
    if (!isLearner() || !currentSession?.id) return;
    try {
      await api(`/api/lab/sessions/${encodeURIComponent(currentSession.id)}/attendance/leave`, { method: "POST" });
    } catch (error) {
      console.error("Virtual Lab attendance leave failed", error);
    }
  }

  async function goBack() {
    if (view === "session" && isLearner()) await leaveSession();
    if (recorder || recordingStarting) await stopRecording(true);
    currentSim?.destroy();
    currentSim = null;
    currentSession = null;
    currentExperiment = null;
    stopSessionResources(true);
    clearLocalRecording();
    if (isTeacher() && currentTab === "sessions") {
      view = "catalog";
      loadSessions();
      renderCatalog();
    } else {
      view = "catalog";
      loadCatalog();
    }
  }

  function stopSessionResources(clearBoardState = false) {
    stopBoardPolling();
    window.clearInterval(pollTimer);
    pollTimer = 0;
    if (recorder || recordingStarting) stopRecording(false);
    releaseRecordingTracks();
    if (clearBoardState) {
      boardEvents = [];
      seenEvents = new Set();
      lastBoardTs = 0;
    }
  }

  async function closeLab() {
    window.clearInterval(identityCheckTimer);
    identityCheckTimer = 0;
    if (recorder || recordingStarting) await stopRecording(true);
    if (view === "session" && isLearner()) await leaveSession();
    active = false;
    stopSessionResources(true);
    currentSim?.destroy();
    currentSim = null;
    uiRoot.hidden = true;
    doc.body.classList.remove("vl-open");
    uiRoot.replaceChildren();
    currentExperiment = null;
    currentSession = null;
    clearLocalRecording();
    lastFocusedElement?.focus?.();
  }

  async function setUser(user) {
    const nextKey = user ? `${user.id || user.user_id || user.email || ""}:${user.role || user.user_type || ""}:${normalizedLanguage(user)}` : "";
    const changed = identityKey !== nextKey;
    const languageChanged = normalizedLanguage(user) !== currentLanguage;
    if ((changed || languageChanged) && active) await closeLab();
    if (destroyed) return;
    currentUser = user || null;
    if (changed) {
      identityKey = nextKey;
      stopSessionResources(true);
      currentSim?.destroy();
      currentSim = null;
      catalog = [];
      progressRows = [];
      classProgressRows = [];
      classProgressLevel = "";
      classProgressLoading = false;
      sessions = [];
      currentExperiment = null;
      currentSession = null;
      currentTab = "experiments";
    }
    await ensureTranslations(currentUser);
    if (destroyed) return;
    addStylesheet();
    appendLaunchers();
    const studentLauncher = doc.querySelector("[data-apshule-lab-launcher='student']");
    if (studentLauncher) studentLauncher.hidden = !isLearner();
    const teacherLauncher = doc.querySelector("[data-apshule-lab-launcher='teacher']");
    if (teacherLauncher) teacherLauncher.hidden = !isTeacher();
  }

  function destroy() {
    destroyed = true;
    active = false;
    stopSessionResources(true);
    currentSim?.destroy();
    currentSim = null;
    if (uiRoot) {
      uiRoot.removeEventListener("click", onRootClick);
      uiRoot.removeEventListener("keydown", onRootKeydown);
      uiRoot.remove();
      uiRoot = null;
    }
    doc.body.classList.remove("vl-open");
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns.length = 0;
    clearLocalRecording();
    addedLaunchers.forEach((launcher) => launcher.remove());
    addedLaunchers = [];
    stylesheetLink?.remove();
    stylesheetLink = null;
    if (identityCheckTimer) window.clearInterval(identityCheckTimer);
  }

  Promise.resolve().then(() => getCurrentUser?.()).then((user) => setUser(user || null)).catch(() => setUser(null));

  return { setUser, destroy };
}
