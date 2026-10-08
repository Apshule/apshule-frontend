export function initSettingsUI({
    api,
    getCurrentUser = () => null,
    idb = globalThis.idb,
    offlineData,
    notify = () => {},
    apiBase = "",
} = {}) {
    if (typeof api !== "function") throw new TypeError("initSettingsUI requires the app api(path, options) function.");

    const LANGUAGES = [
        ["en", "English"], ["lg", "Luganda"], ["xog", "Lusoga"], ["nyn", "Runyankole"], ["nyo", "Runyoro"],
        ["ach", "Acholi"], ["sw", "Kiswahili"],
    ];
    const SAVER_OPTIONS = [["auto", "Auto"], ["always", "Always"], ["wifi_only", "WiFi-only"], ["off", "Off"]];
    const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
    const root = document.createElement("div");
    root.className = "apsh-settings-root";
    root.innerHTML = `
      <div class="apsh-settings-backdrop" data-settings-backdrop hidden>
        <section class="apsh-settings-app" role="dialog" aria-modal="true" aria-labelledby="apsh-settings-title" tabindex="-1" data-settings-panel>
          <header class="apsh-settings-topbar">
            <div class="apsh-settings-brand"><span class="apsh-settings-mark" aria-hidden="true">A</span><div><span class="apsh-settings-kicker">APSHULE · ACCOUNT</span><h1 id="apsh-settings-title" data-i18n="settings">Settings</h1></div></div>
            <div class="apsh-settings-top-actions"><span class="apsh-settings-user" data-user-name data-testid="text-settings-user"></span><button type="button" class="apsh-settings-close" aria-label="Close settings" data-action="close-settings" data-testid="button-close-settings">×</button></div>
          </header>
          <div class="apsh-settings-body">
            <nav class="apsh-settings-nav" aria-label="Settings sections" data-testid="nav-settings">
              <button type="button" data-section="preferences" aria-current="page" data-testid="nav-settings-preferences"><span class="fas fa-sliders-h" aria-hidden="true"></span> <span data-i18n="preferences">Preferences</span></button>
              <button type="button" data-section="offline" data-testid="nav-settings-offline"><span class="fas fa-cloud-download-alt" aria-hidden="true"></span> <span data-i18n="offline_sync">Offline &amp; sync</span></button>
              <button type="button" data-section="help" data-testid="nav-settings-help"><span class="fas fa-book-open" aria-hidden="true"></span> <span data-i18n="help">Help guide</span></button>
              <button type="button" data-section="reports" data-testid="nav-settings-reports"><span class="fas fa-flag" aria-hidden="true"></span> <span data-i18n="bug_reports">Bug reports</span></button>
              <button type="button" data-section="about" data-testid="nav-settings-about"><span class="fas fa-circle-info" aria-hidden="true"></span> <span data-i18n="about">About APSHULE</span></button>
            </nav>
            <main class="apsh-settings-content">
              <section class="apsh-settings-section" data-settings-section="preferences" aria-labelledby="apsh-preferences-heading">
                <div class="apsh-settings-heading"><div><p class="apsh-settings-eyebrow">YOUR WORKSPACE</p><h2 id="apsh-preferences-heading" data-i18n="preferences">Preferences</h2><p>Choose how APSHULE works for this account.</p></div><span class="apsh-settings-index">01 / 05</span></div>
                <div class="apsh-settings-card">
                  <div class="apsh-settings-field"><div><label for="apsh-language" data-i18n="language">Language</label><p>Only interface text marked for translation changes.</p></div><select id="apsh-language" data-pref="language" data-testid="select-settings-language"></select></div>
                  <div class="apsh-settings-field"><div><label for="apsh-data-saver" data-i18n="data_saver">Data saver</label><p id="apsh-saver-hint">Reduce video and chart data use on this device.</p></div><select id="apsh-data-saver" data-pref="data_saver" data-testid="select-settings-data-saver"></select></div>
                  <div class="apsh-settings-field"><div><label for="apsh-theme" data-i18n="appearance">Appearance</label><p>Use a light, dark, or device-matched theme.</p></div><select id="apsh-theme" data-pref="theme" data-testid="select-settings-theme"></select></div>
                  <div class="apsh-settings-field"><div><label for="apsh-timezone" data-i18n="time_zone">Time zone</label><p>Used when displaying dates and times.</p></div><select id="apsh-timezone" data-pref="timezone" data-testid="select-settings-timezone"></select></div>
                  <div class="apsh-settings-field"><div><label for="apsh-notifications" data-i18n="notifications">Notifications</label><p>Delivery is not enabled yet.</p></div><label class="apsh-switch"><input id="apsh-notifications" type="checkbox" data-pref="notifications_enabled" data-testid="toggle-settings-notifications"><span aria-hidden="true"></span><b data-i18n="enable_preference">Enable preference</b></label></div>
                  <p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-settings-preferences"></p>
                </div>
              </section>
              <section class="apsh-settings-section" data-settings-section="offline" aria-labelledby="apsh-offline-heading" hidden>
                <div class="apsh-settings-heading"><div><p class="apsh-settings-eyebrow">ON THIS DEVICE</p><h2 id="apsh-offline-heading">Offline &amp; sync</h2><p>Review saved information and changes waiting to sync.</p></div><span class="apsh-settings-index">02 / 05</span></div>
                <div class="apsh-settings-card apsh-offline-card">
                  <div class="apsh-offline-title"><span class="apsh-settings-icon"><i class="fas fa-database" aria-hidden="true"></i></span><div><h3 data-i18n="saved_app_data">Saved app data</h3><p>Cache entries stored for this account.</p></div><strong data-cache-count data-testid="text-cache-count">—</strong></div>
                  <button class="apsh-btn apsh-btn-quiet" type="button" data-action="clear-cache" data-testid="button-clear-cache" data-i18n="clear_cache">Clear cached data</button>
                  <p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-cache"></p>
                </div>
                <div class="apsh-settings-card apsh-offline-card">
                  <div class="apsh-offline-title"><span class="apsh-settings-icon apsh-warn-icon"><i class="fas fa-hourglass-half" aria-hidden="true"></i></span><div><h3 data-i18n="pending_changes">Pending changes</h3><p>Only changes saved by this account are shown. Request contents are never displayed.</p></div><strong data-queue-count data-testid="text-queue-count">—</strong></div>
                  <div class="apsh-queue-list" data-queue-list aria-live="polite" data-testid="list-pending-queue"></div>
                  <button class="apsh-btn apsh-btn-danger-quiet" type="button" data-action="clear-queue" data-testid="button-discard-queue" data-i18n="discard_queue">Discard this account’s queued changes</button>
                  <p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-queue"></p>
                </div>
                <div class="apsh-settings-card">
                  <div class="apsh-settings-subhead"><div><h3 data-i18n="sync_history">Recent sync history</h3><p>Latest 50 sync attempts for this account.</p></div><button type="button" class="apsh-btn apsh-btn-quiet apsh-btn-small" data-action="refresh-sync" data-testid="button-refresh-sync" data-i18n="refresh">Refresh</button></div>
                  <div data-sync-history aria-live="polite" data-testid="list-sync-history"></div>
                </div>
              </section>
              <section class="apsh-settings-section" data-settings-section="help" aria-labelledby="apsh-help-heading" hidden>
                <div class="apsh-settings-heading"><div><p class="apsh-settings-eyebrow">ROLE-AWARE SUPPORT</p><h2 id="apsh-help-heading">Help guide</h2><p>Practical steps for the tools available to your account.</p></div><span class="apsh-settings-index">03 / 05</span></div>
                <div data-help-content aria-live="polite" data-testid="content-help-guide"></div>
              </section>
              <section class="apsh-settings-section" data-settings-section="reports" aria-labelledby="apsh-reports-heading" hidden>
                  <div class="apsh-settings-heading"><div><p class="apsh-settings-eyebrow">TELL US WHAT HAPPENED</p><h2 id="apsh-reports-heading" data-i18n="bug_reports">Bug reports</h2><p>Send a report with device and page context to help us investigate.</p></div><span class="apsh-settings-index">04 / 05</span></div>
                <form class="apsh-settings-card apsh-bug-form" data-bug-form>
                  <div class="apsh-form-grid">
                    <div class="apsh-field apsh-span-2"><label for="apsh-report-title" data-i18n="title">Title</label><input id="apsh-report-title" name="title" minlength="5" maxlength="100" required data-testid="input-bug-title"></div>
                    <div class="apsh-field"><label for="apsh-report-category" data-i18n="category">Category</label><select id="apsh-report-category" name="category" required data-testid="select-bug-category"><option value="bug" data-i18n="bug">Bug</option><option value="suggestion" data-i18n="suggestion">Suggestion</option><option value="account" data-i18n="account">Account</option><option value="sync" data-i18n="sync">Sync</option><option value="other" data-i18n="other">Other</option></select></div>
                    <div class="apsh-field"><label for="apsh-report-severity" data-i18n="severity">Severity</label><select id="apsh-report-severity" name="severity" required data-testid="select-bug-severity"><option value="low" data-i18n="low">Low</option><option value="medium" selected data-i18n="medium">Medium</option><option value="high" data-i18n="high">High</option><option value="critical" data-i18n="critical">Critical</option></select></div>
                    <div class="apsh-field apsh-span-2"><label for="apsh-report-description" data-i18n="description">Description</label><textarea id="apsh-report-description" name="description" rows="5" minlength="10" maxlength="2000" required data-testid="input-bug-description"></textarea></div>
                    <div class="apsh-field apsh-span-2"><label for="apsh-report-screenshot"><span data-i18n="screenshot">Screenshot</span> <span class="apsh-optional">Optional · up to 500 KB</span></label><input id="apsh-report-screenshot" name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" data-testid="input-bug-screenshot"><small data-screenshot-note>Attach a screenshot only if it helps explain the issue.</small></div>
                  </div>
                  <div class="apsh-context-note"><i class="fas fa-shield-alt" aria-hidden="true"></i><span>We’ll include your account role, sector, current page and device details. Your report is visible only to you and authorized administrators.</span></div>
                  <div class="apsh-form-actions"><button class="apsh-btn apsh-btn-primary" type="submit" data-testid="button-submit-bug-report" data-i18n="send_report">Send report</button><p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-submit-bug"></p></div>
                </form>
                <div class="apsh-settings-subhead apsh-own-reports-head"><div><h3>Your reports</h3><p>Reports submitted by this account only.</p></div><button type="button" class="apsh-btn apsh-btn-quiet apsh-btn-small" data-action="refresh-reports" data-testid="button-refresh-own-reports">Refresh</button></div>
                <div data-own-reports aria-live="polite" data-testid="list-own-bug-reports"></div>
              </section>
              <section class="apsh-settings-section" data-settings-section="about" aria-labelledby="apsh-about-heading" hidden>
                <div class="apsh-settings-heading"><div><p class="apsh-settings-eyebrow">THE SHARED PLATFORM</p><h2 id="apsh-about-heading" data-i18n="about">About APSHULE</h2><p>A dependable workspace across learning and essential services.</p></div><span class="apsh-settings-index">05 / 05</span></div>
                <div class="apsh-settings-card apsh-about-card"><div class="apsh-about-version"><span class="apsh-settings-mark" aria-hidden="true">A</span><div><strong>APSHULE</strong><span>Version 6.0.0</span></div></div><p class="apsh-about-copy">One platform for learners, teachers, borrowers, staff, clinic teams and farm teams.</p><div class="apsh-about-links" data-about-links></div><p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-about"></p></div>
              </section>
            </main>
          </div>
        </section>
      </div>`;
    document.body.append(root);
    let stylesheet = document.getElementById("apsh-settings-stylesheet");
    const ownsStylesheet = !stylesheet;
    if (!stylesheet) {
        stylesheet = document.createElement("link");
        stylesheet.id = "apsh-settings-stylesheet";
        stylesheet.rel = "stylesheet";
        stylesheet.href = new URL("./settings-ui.css", import.meta.url).href;
        document.head.append(stylesheet);
    }

    const backdrop = root.querySelector("[data-settings-backdrop]");
    const panel = root.querySelector("[data-settings-panel]");
    const aborter = new AbortController();
    const listenOptions = { signal: aborter.signal };
    const langSelect = root.querySelector("#apsh-language");
    const saverSelect = root.querySelector("#apsh-data-saver");
    const themeSelect = root.querySelector("#apsh-theme");
    const tzSelect = root.querySelector("#apsh-timezone");
    const notificationsInput = root.querySelector("#apsh-notifications");
    const userName = root.querySelector("[data-user-name]");
    const gearButton = document.createElement("button");
    let currentUser = null;
    let preferences = {
        language: "en", data_saver: "auto", theme: "auto", notifications_enabled: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", settings: {},
    };
    let open = false;
    let previousFocus = null;
    let prefSaveTimer = null;
    let preferenceRevision = 0;
    let translations = {};
    let loadedLanguage = "";
    let translationEnglish = new WeakMap();
    let translationEnglishAria = new WeakMap();
    let activeAdminReportId = null;
    let videoObserver = null;
    let themeMedia = null;
    let connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    let aboutData = null;
    let adminTabsListenerInstalled = false;
    const originalTheme = document.documentElement.getAttribute("data-apshule-theme");
    const originalSaver = document.documentElement.getAttribute("data-apshule-data-saver");
    const originalColorScheme = document.documentElement.style.colorScheme;
    const originalLanguage = document.documentElement.getAttribute("lang");

    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
    const safeText = (value, fallback = "—") => value == null || value === "" ? fallback : String(value);
    const t = (key, fallback) => {
        const translated = translations?.[key];
        return translated == null || translated === "" ? fallback : String(translated);
    };
    const labelFor = (value) => {
        const key = String(value || "");
        return t(key, key.replaceAll("_", " "));
    };
    const isAdmin = (user) => user?.role === "superadmin" && !user?.impersonatedBy && !user?.impersonated_by;
    const notifyUser = (message, type = "info") => { try { notify(message, type); } catch {} };
    const status = (selector, message, error = false) => {
        const node = root.querySelector(selector);
        if (node) {
            node.textContent = message || "";
            node.dataset.kind = error ? "error" : "success";
        }
    };
    const request = (path, options = {}) => api(path, options);
    const getPrefsPayload = (payload) => payload?.preferences && typeof payload.preferences === "object" ? payload.preferences : payload || {};
    const dateLabel = (value) => {
        if (!value) return "—";
        const date = new Date(value);
        const requestedLocale = preferences.language || "en";
        const locale = Intl.DateTimeFormat.supportedLocalesOf([requestedLocale]).length ? requestedLocale : "en";
        try {
            return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: preferences.timezone || "Africa/Kampala",
            });
        } catch {
            return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Kampala" });
        }
    };
    const roleName = (user) => String(user?.role || "account");

    LANGUAGES.forEach(([value, label]) => langSelect.add(new Option(label, value)));
    SAVER_OPTIONS.forEach(([value, label]) => {
        const option = new Option(label, value);
        option.dataset.i18n = value;
        saverSelect.add(option);
    });
    THEMES.forEach(([value, label]) => {
        const option = new Option(label, value);
        option.dataset.i18n = value;
        themeSelect.add(option);
    });
    const zones = (() => {
        try { return Intl.supportedValuesOf("timeZone"); } catch { return ["Africa/Kampala", "UTC"]; }
    })();
    if (preferences.timezone && !zones.includes(preferences.timezone)) zones.unshift(preferences.timezone);
    [...new Set(zones)].forEach((zone) => tzSelect.add(new Option(zone.replaceAll("_", " "), zone)));

    function addGearEntry() {
        const dropdown = document.getElementById("moreDropdown");
        if (!dropdown || gearButton.isConnected) return;
        gearButton.type = "button";
        gearButton.className = "apsh-settings-header-button";
        gearButton.dataset.testid = "button-open-settings";
        gearButton.setAttribute("aria-haspopup", "dialog");
        gearButton.setAttribute("aria-label", "⚙️ Settings");
        gearButton.dataset.i18nAriaLabel = "settings";
        gearButton.textContent = "⚙️";
        const headerActions = document.querySelector(".header-right");
        const menu = document.getElementById("moreMenuBtn");
        if (headerActions && menu?.parentElement) headerActions.insertBefore(gearButton, menu.parentElement);
        else dropdown.insertBefore(gearButton, dropdown.querySelector("#logoutBtn") || null);
    }

    function setOpen(isOpen) {
        open = isOpen;
        backdrop.hidden = !isOpen;
        document.body.classList.toggle("apsh-settings-open", isOpen);
        if (isOpen) {
            previousFocus = document.activeElement;
            panel.focus();
            void loadPreferences();
            void refreshOffline();
            void loadHelp();
            void loadOwnReports();
            void loadAbout();
        } else {
            activeAdminReportId = null;
            if (previousFocus?.isConnected) previousFocus.focus();
        }
    }
    function openSettings() { if (!currentUser) return; setOpen(true); }
    function closeSettings() { if (open) setOpen(false); }

    function changeSection(section) {
        root.querySelectorAll("[data-settings-section]").forEach((view) => { view.hidden = view.dataset.settingsSection !== section; });
        root.querySelectorAll(".apsh-settings-nav [data-section]").forEach((button) => {
            if (button.dataset.section === section) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        });
        if (section === "offline") void refreshOffline();
        if (section === "help") void loadHelp();
        if (section === "reports") { void loadOwnReports(); }
    }

    function applyTranslation() {
        const lang = preferences.language || "en";
        document.documentElement.lang = lang;
        document.querySelectorAll("[data-i18n]").forEach((node) => {
            if (!translationEnglish.has(node)) translationEnglish.set(node, node.textContent);
            const original = translationEnglish.get(node) || "";
            const translated = translations?.[node.dataset.i18n];
            const value = translated == null || translated === "" ? original : String(translated);
            if (node.textContent !== value) node.textContent = value;
        });
        document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
            if (!translationEnglishAria.has(node)) translationEnglishAria.set(node, node.getAttribute("aria-label") || "");
            const translated = translations?.[node.dataset.i18nAriaLabel];
            node.setAttribute("aria-label", translated != null && translated !== "" ? String(translated) : translationEnglishAria.get(node));
        });
        if (lang === "en") {
            translations = {};
            loadedLanguage = "en";
            document.querySelectorAll("[data-i18n]").forEach((node) => { if (translationEnglish.has(node)) node.textContent = translationEnglish.get(node); });
        }
    }
    function translateAddedNodes(nodes) {
        if (preferences.language === "en") return;
        const marked = [];
        nodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches("[data-i18n]")) marked.push(node);
            node.querySelectorAll("[data-i18n]").forEach((child) => marked.push(child));
        });
        marked.forEach((node) => {
            if (!translationEnglish.has(node)) translationEnglish.set(node, node.textContent);
            const original = translationEnglish.get(node) || "";
            const translated = translations?.[node.dataset.i18n];
            const value = translated == null || translated === "" ? original : String(translated);
            if (node.textContent !== value) node.textContent = value;
        });
    }

    async function loadTranslations(language) {
        if (!language || language === "en") {
            translations = {};
            loadedLanguage = language;
            applyTranslation();
            return;
        }
        if (loadedLanguage === language) return;
        loadedLanguage = language;
        try {
            const result = await request(`/api/settings/i18n/strings?lang=${encodeURIComponent(language)}`, { auth: false });
            if (preferences.language !== language) return;
            translations = result && typeof result === "object" && !Array.isArray(result) ? result : {};
            loadedLanguage = language;
            applyTranslation();
        } catch {
            translations = {};
            loadedLanguage = language;
            applyTranslation();
        }
    }

    function saverIsActive() {
        if (!currentUser) return false;
        const mode = preferences.data_saver || "auto";
        if (mode === "always") return true;
        if (mode === "off") return false;
        if (mode === "wifi_only") {
            const netType = String(connection?.type || "").toLowerCase();
            return netType !== "wifi" && netType !== "ethernet";
        }
        const connectionType = String(connection?.type || "").toLowerCase();
        if (connectionType === "cellular") return true;
        if (connectionType === "wifi" || connectionType === "ethernet") return false;
        return Boolean(connection?.saveData || /^(slow-2g|2g|3g)$/u.test(connection?.effectiveType || ""));
    }

    function applyPreferences() {
        const rootEl = document.documentElement;
        const requestedTheme = preferences.theme || "auto";
        const dark = requestedTheme === "dark" || (requestedTheme === "auto" && Boolean(themeMedia?.matches));
        rootEl.dataset.apshuleTheme = dark ? "dark" : "light";
        rootEl.style.colorScheme = dark ? "dark" : "light";
        const saveDataActive = saverIsActive();
        rootEl.dataset.apshuleDataSaver = saveDataActive ? "active" : "inactive";
        globalThis.__APSHULE_SAVE_DATA_ACTIVE = saveDataActive;
        saverSelect?.setAttribute("aria-describedby", "apsh-saver-hint");
        applyDataSaver();
        const lang = preferences.language || "en";
        if (lang !== loadedLanguage) void loadTranslations(lang);
    }

    function embedSource(frame) {
        return frame.dataset.apshSavedSrc || frame.getAttribute("src") || "";
    }
    function activateVideoSaver() {
        if (!saverIsActive()) {
            document.querySelectorAll(".apsh-data-poster").forEach((poster) => {
                const frame = poster.parentElement?.querySelector("iframe[data-apsh-saved-src], video[data-apsh-saved-src]");
                if (frame) {
                    const src = frame.dataset.apshSavedSrc;
                    if (src) frame.setAttribute("src", src);
                    delete frame.dataset.apshSavedSrc;
                    frame.removeAttribute("data-apsh-saved-src");
                }
                poster.remove();
            });
            document.querySelectorAll("[data-apsh-user-played]").forEach((media) => media.removeAttribute("data-apsh-user-played"));
            document.querySelectorAll(".apsh-data-video-host").forEach((host) => host.classList.remove("apsh-data-video-host"));
            revealAllCharts();
            return;
        }
        document.querySelectorAll('iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],iframe[src*="youtu.be"],iframe[src*="vimeo.com"],video[src]').forEach((media) => {
            if (media.dataset.apshSavedSrc !== undefined || media.dataset.apshUserPlayed === "true") return;
            const src = embedSource(media);
            if (!src || !media.parentElement) return;
            const host = media.parentElement;
            host.classList.add("apsh-data-video-host");
            media.dataset.apshSavedSrc = src;
            media.removeAttribute("src");
            const poster = document.createElement("button");
            poster.type = "button";
            poster.className = "apsh-data-poster";
            poster.dataset.testid = `button-play-saver-video`;
            poster.setAttribute("aria-label", "Play video (uses data)");
            poster.innerHTML = `<span class="apsh-play-mark"><i class="fas fa-play" aria-hidden="true"></i></span><strong data-i18n="video_paused">Video paused to save data</strong><span data-i18n="tap_to_play">Tap to play</span>`;
            poster.addEventListener("click", () => {
                media.setAttribute("src", media.dataset.apshSavedSrc || src);
                delete media.dataset.apshSavedSrc;
                media.dataset.apshUserPlayed = "true";
                poster.remove();
                host.classList.remove("apsh-data-video-host");
            }, { once: true, signal: aborter.signal });
            host.append(poster);
        });
        hideCharts();
    }

    function chartCanvas(canvas) {
        return Boolean(canvas.closest("[class*='chart'],[id*='chart']") || globalThis.Chart?.getChart?.(canvas));
    }
    function hideCharts() {
        document.querySelectorAll("canvas").forEach((canvas) => {
            if (!chartCanvas(canvas) || canvas.dataset.apshChartHidden) return;
            const host = canvas.parentElement;
            if (!host) return;
            canvas.dataset.apshChartHidden = "true";
            host.classList.add("apsh-chart-host");
            const reveal = document.createElement("button");
            reveal.type = "button";
            reveal.className = "apsh-chart-reveal";
            reveal.dataset.testid = "button-reveal-chart";
            reveal.innerHTML = `<i class="fas fa-chart-bar" aria-hidden="true"></i><strong data-i18n="chart_hidden">Chart hidden to save data</strong><span data-i18n="tap_to_load_chart">Tap to load chart</span>`;
            reveal.addEventListener("click", () => {
                canvas.hidden = false;
                canvas.removeAttribute("data-apsh-chart-hidden");
                reveal.remove();
                host.classList.remove("apsh-chart-host");
            }, { once: true, signal: aborter.signal });
            canvas.hidden = true;
            host.append(reveal);
        });
    }
    function revealAllCharts() {
        document.querySelectorAll("canvas[data-apsh-chart-hidden]").forEach((canvas) => {
            canvas.hidden = false;
            canvas.removeAttribute("data-apsh-chart-hidden");
            canvas.parentElement?.querySelector(".apsh-chart-reveal")?.remove();
            canvas.parentElement?.classList.remove("apsh-chart-host");
        });
    }
    function applyDataSaver() { activateVideoSaver(); }

    async function loadPreferences() {
        const statusSelector = '[data-testid="status-settings-preferences"]';
        const requestedUserId = String(currentUser?.id || "");
        status(statusSelector, "Loading preferences…");
        try {
            const response = await request("/api/user/preferences");
            if (!requestedUserId || String(currentUser?.id || "") !== requestedUserId) return;
            const result = getPrefsPayload(response);
            preferences = { ...preferences, ...result, settings: result?.settings && typeof result.settings === "object" ? result.settings : preferences.settings };
            syncPreferenceControls();
            applyPreferences();
            status(statusSelector, "");
        } catch (error) {
            syncPreferenceControls();
            status(statusSelector, `Could not load preferences. ${error?.message || "Try again."}`, true);
        }
    }
    function syncPreferenceControls() {
        langSelect.value = LANGUAGES.some(([value]) => value === preferences.language) ? preferences.language : "en";
        saverSelect.value = SAVER_OPTIONS.some(([value]) => value === preferences.data_saver) ? preferences.data_saver : "auto";
        themeSelect.value = THEMES.some(([value]) => value === preferences.theme) ? preferences.theme : "auto";
        if (preferences.timezone && ![...tzSelect.options].some((option) => option.value === preferences.timezone)) {
            tzSelect.add(new Option(preferences.timezone, preferences.timezone));
        }
        tzSelect.value = preferences.timezone || "UTC";
        notificationsInput.checked = Boolean(preferences.notifications_enabled);
    }
    function queuePreferenceSave() {
        applyPreferences();
        status('[data-testid="status-settings-preferences"]', "Saving…");
        preferenceRevision += 1;
        const revision = preferenceRevision;
        const userId = String(currentUser?.id || "");
        const patch = {
            language: preferences.language,
            data_saver: preferences.data_saver,
            theme: preferences.theme,
            notifications_enabled: preferences.notifications_enabled,
            timezone: preferences.timezone,
        };
        clearTimeout(prefSaveTimer);
        prefSaveTimer = setTimeout(async () => {
            if (!userId || String(currentUser?.id || "") !== userId) return;
            try {
                await request("/api/user/preferences", { method: "PATCH", body: patch });
                if (revision === preferenceRevision && String(currentUser?.id || "") === userId) status('[data-testid="status-settings-preferences"]', "Preferences saved.");
            } catch (error) {
                if (revision === preferenceRevision && String(currentUser?.id || "") === userId) status('[data-testid="status-settings-preferences"]', `Could not save preferences. ${error?.message || "Try again."}`, true);
            }
        }, 260);
    }

    function userCachePrefix(userId = currentUser?.id) {
        return userId ? `apshule:offline:api:user:${encodeURIComponent(String(userId))}:` : "";
    }
    async function refreshOffline() {
        const cacheCountNode = root.querySelector("[data-cache-count]");
        const queueCountNode = root.querySelector("[data-queue-count]");
        const queueList = root.querySelector("[data-queue-list]");
        if (!currentUser?.id) return;
        const userId = String(currentUser.id);
        try {
            const keys = await idb?.keys?.() || [];
            if (String(currentUser?.id || "") !== userId) return;
            const prefix = userCachePrefix(userId);
            const cacheKeys = keys.filter((key) => typeof key === "string" && prefix && key.startsWith(prefix));
            if (cacheCountNode) cacheCountNode.textContent = String(cacheKeys.length);
        } catch (error) {
            if (String(currentUser?.id || "") !== userId) return;
            if (cacheCountNode) cacheCountNode.textContent = "Unavailable";
            status('[data-testid="status-cache"]', error?.message || "Saved data could not be counted.", true);
        }
        try {
            const all = await idb?.queueAll?.() || [];
            if (String(currentUser?.id || "") !== userId) return;
            const minePending = all.filter((item) => String(item.user_id) === userId)
                .sort((a, b) => Number(a.queued_at) - Number(b.queued_at));
            if (queueCountNode) queueCountNode.textContent = String(minePending.length);
            if (!queueList) return;
        if (!minePending.length) {
                queueList.innerHTML = `<div class="apsh-empty-state"><span class="apsh-empty-symbol"><i class="fas fa-check" aria-hidden="true"></i></span><strong>No changes waiting</strong><p>This account has no pending offline changes.</p></div>`;
            } else {
            queueList.innerHTML = minePending.map((item, index) => {
                    const route = String(item.path || "")
                        .split(/[?#]/u, 1)[0]
                        .replace(/^\/api\//u, "")
                        .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,36}(?=\/|$)/giu, "/:id")
                        .replaceAll("/", " · ");
                    const method = String(item.method || "POST").toUpperCase();
                    return `<article class="apsh-queue-row" data-testid="row-pending-queue-${esc(item.id ?? index)}"><span class="apsh-queue-number">${String(index + 1).padStart(2, "0")}</span><div><strong>${esc(method)} · ${esc(route || "Saved change")}</strong><span>${esc(dateLabel(Number(item.queued_at) || item.queued_at))}</span></div><span class="apsh-status-pill" data-testid="status-queue-item-${esc(item.id ?? index)}">${esc(labelFor(item.status || "pending"))}</span></article>`;
                }).join("");
            }
        } catch (error) {
            if (String(currentUser?.id || "") !== userId) return;
            if (queueList) queueList.innerHTML = `<div class="apsh-inline-error">Pending changes could not be read. ${esc(error?.message || "")}</div>`;
        }
        await loadSyncHistory();
    }
    async function clearCache() {
        if (!currentUser?.id) return;
        const userId = String(currentUser.id);
        const yes = window.confirm("Clear cached data saved for this account on this device? Your account and queued changes will not be deleted.");
        if (!yes) return;
        try {
            const keys = await idb?.keys?.() || [];
            if (String(currentUser?.id || "") !== userId) return;
            const prefix = userCachePrefix(userId);
            const ownKeys = keys.filter((key) => typeof key === "string" && key.startsWith(prefix));
            await Promise.all(ownKeys.map((key) => idb.del(key)));
            status('[data-testid="status-cache"]', "This account’s cached data was cleared.");
            await refreshOffline();
            notifyUser("Cached data cleared.", "success");
        } catch (error) {
            status('[data-testid="status-cache"]', error?.message || "Could not clear cached data.", true);
        }
    }
    async function clearQueue() {
        if (!currentUser?.id) return;
        const userId = String(currentUser.id);
        let count = 0;
        try {
            const all = await idb?.queueAll?.() || [];
            if (String(currentUser?.id || "") !== userId) return;
            count = all.filter((item) => String(item.user_id) === userId).length;
        } catch {}
        if (!count) {
            status('[data-testid="status-queue"]', "There are no queued changes to discard.");
            return;
        }
        const confirmation = `Discard ${count} queued change${count === 1 ? "" : "s"} for this account? This cannot be undone.`;
        if (!window.confirm(confirmation)) return;
        try {
            if (typeof idb?.queueClear !== "function") throw new Error("Queue clearing is unavailable in this browser.");
            if (String(currentUser?.id || "") !== userId) return;
            await idb.queueClear(userId);
            globalThis.dispatchEvent?.(new CustomEvent("apshule:offline-queue-state-change", { detail: { userId, pending: 0 } }));
            status('[data-testid="status-queue"]', "This account’s queued changes were discarded.");
            await refreshOffline();
        } catch (error) {
            status('[data-testid="status-queue"]', error?.message || "Could not clear the queue.", true);
        }
    }
    async function loadSyncHistory() {
        const container = root.querySelector("[data-sync-history]");
        if (!container || !currentUser?.id) return;
        const requestedUserId = String(currentUser.id);
        container.innerHTML = `<div class="apsh-loading-lines" aria-label="Loading sync history"><i></i><i></i><i></i></div>`;
        try {
            const entries = await request("/api/user/sync-history?limit=50");
            if (String(currentUser?.id || "") !== requestedUserId) return;
            const rows = Array.isArray(entries) ? entries : [];
            if (!rows.length) {
                container.innerHTML = `<div class="apsh-empty-state apsh-empty-compact"><strong>No sync history yet</strong><p>Completed sync attempts will appear here.</p></div>`;
                return;
            }
            container.innerHTML = `<div class="apsh-history-list">${rows.slice(0, 50).map((item, index) => {
                const failed = Number(item.items_failed) > 0;
                const synced = Number(item.items_synced) || 0;
                return `<article class="apsh-history-row" data-testid="row-sync-history-${esc(item.id ?? index)}"><span class="apsh-history-mark ${failed ? "is-warning" : ""}" aria-hidden="true"><i class="fas ${failed ? "fa-exclamation" : "fa-check"}"></i></span><div class="apsh-history-main"><strong>${esc(safeText(item.sync_type, "Sync"))} · ${synced} synced · ${Number(item.items_failed) || 0} failed</strong><span>${esc(dateLabel(item.created_at))}${item.triggered_by ? ` · ${esc(item.triggered_by)}` : ""}</span>${item.error_summary ? `<small>${esc(item.error_summary)}</small>` : ""}</div><span class="apsh-history-duration">${Number(item.duration_ms) ? `${Math.round(Number(item.duration_ms) / 100) / 10}s` : ""}<small>${failed ? "Failed" : "Complete"}</small></span></article>`;
            }).join("")}</div>`;
        } catch (error) {
            container.innerHTML = `<div class="apsh-inline-error" role="status">Sync history could not be loaded. <button type="button" data-action="retry-history" data-testid="button-retry-sync-history">Try again</button><span>${esc(error?.message || "")}</span></div>`;
        }
    }

    async function loadHelp() {
        const content = root.querySelector("[data-help-content]");
        if (!content || !currentUser?.id || content.dataset.loaded === "true") return;
        const requestedUserId = String(currentUser.id);
        content.innerHTML = `<div class="apsh-loading-lines" aria-label="Loading help"><i></i><i></i><i></i></div>`;
        try {
            const sections = await request("/api/user/guide");
            if (String(currentUser?.id || "") !== requestedUserId) return;
            const rows = Array.isArray(sections) ? sections : [];
            if (!rows.length) {
                content.innerHTML = `<div class="apsh-empty-state"><span class="apsh-empty-symbol"><i class="fas fa-book-open" aria-hidden="true"></i></span><strong>No guide sections available</strong><p>Help content for this account is not available right now.</p><button type="button" class="apsh-btn apsh-btn-quiet" data-action="retry-help" data-testid="button-retry-help">Try again</button></div>`;
                content.dataset.loaded = "false";
                return;
            }
            content.innerHTML = `<div class="apsh-guide-list">${rows.map((section, index) => {
                const steps = Array.isArray(section.steps) ? section.steps : [];
                return `<details class="apsh-guide-section"${index === 0 ? " open" : ""} data-testid="guide-section-${index}"><summary><span class="apsh-guide-icon">${esc(section.icon || "•")}</span><span>${esc(section.title || "Guide")}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></summary><ol>${steps.map((step) => `<li>${esc(typeof step === "object" && step ? step.text : step)}</li>`).join("")}</ol></details>`;
            }).join("")}</div>`;
            content.dataset.loaded = "true";
        } catch (error) {
            content.innerHTML = `<div class="apsh-inline-error" role="status">The guide could not be loaded. <button type="button" data-action="retry-help" data-testid="button-retry-help">Try again</button><span>${esc(error?.message || "")}</span></div>`;
        }
    }

    function normalizeImage(value) {
        const image = String(value || "");
        if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(image)) return image;
        if (/^[A-Za-z0-9+/]+=*$/u.test(image)) return `data:image/jpeg;base64,${image}`;
        return "";
    }
    async function loadOwnReports() {
        const container = root.querySelector("[data-own-reports]");
        if (!container || !currentUser?.id) return;
        const requestedUserId = String(currentUser.id);
        container.innerHTML = `<div class="apsh-loading-lines" aria-label="Loading your reports"><i></i><i></i><i></i></div>`;
        try {
            const result = await request("/api/user/bug-reports");
            if (String(currentUser?.id || "") !== requestedUserId) return;
            const reports = Array.isArray(result) ? result : [];
            if (!reports.length) {
                container.innerHTML = `<div class="apsh-empty-state"><span class="apsh-empty-symbol"><i class="fas fa-flag" aria-hidden="true"></i></span><strong>No reports submitted</strong><p>Reports you send will be listed here.</p></div>`;
                return;
            }
            container.innerHTML = `<div class="apsh-own-report-list">${reports.map((item, index) => `<article class="apsh-own-report" data-testid="row-own-bug-report-${esc(item.id ?? index)}"><div><strong>${esc(item.title || "Bug report")}</strong><span>${esc(dateLabel(item.created_at))} · <span data-i18n="${esc(item.category || "other")}">${esc(labelFor(item.category || "other"))}</span></span></div><span class="apsh-status-pill apsh-report-status apsh-report-status--${esc(item.status || "open")}" data-i18n="${esc(item.status || "open")}">${esc(labelFor(item.status || "open"))}</span><p>${esc(item.description || "")}</p>${item.admin_notes ? `<div class="apsh-admin-note"><strong>Update</strong><span>${esc(item.admin_notes)}</span></div>` : ""}</article>`).join("")}</div>`;
        } catch (error) {
            container.innerHTML = `<div class="apsh-inline-error" role="status">Your reports could not be loaded. <button type="button" data-action="retry-own-reports" data-testid="button-retry-own-reports">Try again</button><span>${esc(error?.message || "")}</span></div>`;
        }
    }
    async function submitBugReport(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const fileInput = form.querySelector('[name="screenshot"]');
        const file = fileInput.files?.[0];
        const formStatus = '[data-testid="status-submit-bug"]';
        if (file && file.size > 500 * 1024) {
            status(formStatus, "Screenshot must be 500 KB or smaller.", true);
            fileInput.focus();
            return;
        }
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        const submittingUserId = String(currentUser?.id || "");
        const submitUser = currentUser;
        status(formStatus, "Sending report…");
        try {
            let screenshotBase64 = null;
            if (file) {
            const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ""));
                    reader.onerror = () => reject(new Error("Screenshot could not be read."));
                    reader.readAsDataURL(file);
                });
                screenshotBase64 = dataUrl;
            }
            if (!submittingUserId || String(currentUser?.id || "") !== submittingUserId) {
                throw new Error("The signed-in account changed. Reopen the report form and try again.");
            }
            const formData = new FormData(form);
            const payload = {
                title: String(formData.get("title") || "").trim(),
                description: String(formData.get("description") || "").trim(),
                category: String(formData.get("category") || "").trim(),
                severity: String(formData.get("severity") || "medium"),
                screenshot_base64: screenshotBase64,
                user_role: roleName(submitUser),
                sector: submitUser?.sector || "",
                device_info: {
                    userAgent: navigator.userAgent || "",
                    platform: navigator.platform || "",
                    language: navigator.language || "",
                    screen: `${window.innerWidth}x${window.innerHeight}`,
                },
                url: window.location.href,
            };
            await request("/api/user/bug-report", { method: "POST", body: payload });
            form.reset();
            root.querySelector("[data-screenshot-note]").textContent = "Attach a screenshot only if it helps explain the issue.";
            status(formStatus, "Report sent. Thank you for the detail.");
            notifyUser("Bug report sent.", "success");
            await loadOwnReports();
        } catch (error) {
            status(formStatus, error?.message || "Could not send this report. Try again.", true);
        } finally {
            submit.disabled = false;
        }
    }

    function appendAboutLink(label, href, testid) {
        if (!href) return "";
        let url;
        try { url = new URL(href, window.location.origin); } catch { return ""; }
        if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) return "";
        return `<a href="${esc(url.href)}" data-testid="${testid}"${url.protocol === "http:" || url.protocol === "https:" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(label)} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
    }
    async function loadAbout() {
        const container = root.querySelector("[data-about-links]");
        if (!container || aboutData) return;
        try {
            aboutData = await request("/api/settings/about", { auth: false });
            const about = aboutData?.about || aboutData || {};
            const links = about.links && typeof about.links === "object" ? about.links : {};
            const terms = links.terms || links.terms_url || about.terms_url || about.termsUrl || "";
            const privacy = links.privacy || links.privacy_url || about.privacy_url || about.privacyUrl || "";
            let contact = links.contact || links.contact_url || about.contact_url || about.contactUrl || "";
            if (!contact && typeof about.contact === "string") contact = about.contact;
            if (contact && /^[^:/\s]+@[^:/\s]+$/u.test(String(contact))) contact = `mailto:${contact}`;
            const bits = [
                appendAboutLink("Terms", terms, "link-about-terms"),
                appendAboutLink("Privacy", privacy, "link-about-privacy"),
                appendAboutLink("Contact", contact, "link-about-contact"),
            ];
            const contactData = about.contact && typeof about.contact === "object" ? about.contact : {};
            const email = contactData.email || about.contact_email || about.contactEmail || about.email;
            const phone = contactData.phone || about.contact_phone || about.contactPhone || about.phone;
            if (email) bits.push(appendAboutLink("Email contact", `mailto:${email}`, "link-about-email"));
            if (phone) bits.push(appendAboutLink("Call contact", `tel:${phone}`, "link-about-phone"));
            if (contactData.whatsapp) {
                const number = String(contactData.whatsapp).replace(/[^\d]/gu, "");
                if (number) bits.push(appendAboutLink("WhatsApp contact", `https://wa.me/${number}`, "link-about-whatsapp"));
            }
            container.innerHTML = bits.filter(Boolean).join("") || `<p class="apsh-about-no-links">No policy or contact links are configured.</p>`;
        } catch {
            container.innerHTML = `<p class="apsh-about-no-links">Policy and contact links are unavailable right now.</p>`;
        }
    }

    function adminTabAvailable() {
        return isAdmin(currentUser) && Boolean(document.getElementById("commandCenter"));
    }
    let adminTab = null;
    let adminView = null;
    function installAdminSurface() {
        const tabs = document.querySelector(".cc-tabs");
        const cc = document.getElementById("commandCenter");
        if (!adminTabAvailable() || !tabs || !cc) {
            adminTab?.remove();
            adminView?.remove();
            adminTab = null;
            adminView = null;
            return;
        }
        if (adminTab?.isConnected) return;
        adminTab = document.createElement("button");
        adminTab.type = "button";
        adminTab.className = "cc-tab apsh-bug-admin-tab";
        adminTab.dataset.ccTab = "bugs";
        adminTab.dataset.testid = "tab-bug-reports";
        adminTab.setAttribute("role", "tab");
        adminTab.setAttribute("aria-selected", "false");
        adminTab.setAttribute("aria-controls", "apshAdminBugReportsView");
        adminTab.innerHTML = `🐛 <span data-i18n="bug_reports">Bug Reports</span>`;
        tabs.append(adminTab);
        adminView = document.createElement("section");
        adminView.id = "apshAdminBugReportsView";
        adminView.className = "cc-view apsh-admin-bugs-view";
        adminView.setAttribute("role", "tabpanel");
        adminView.setAttribute("aria-label", "Bug Reports");
        adminView.innerHTML = `
          <div class="apsh-admin-heading"><div><p class="apsh-settings-eyebrow">PLATFORM QUALITY</p><h2 data-i18n="bug_reports">Bug Reports</h2><p>Review reports submitted across APSHULE.</p></div><button class="apsh-btn apsh-btn-quiet" type="button" data-admin-action="refresh" data-testid="button-admin-refresh-reports"><i class="fas fa-rotate" aria-hidden="true"></i> <span data-i18n="refresh">Refresh</span></button></div>
          <div class="apsh-admin-filters">
            <div class="apsh-field"><label for="apsh-admin-status" data-i18n="status">Status</label><select id="apsh-admin-status" data-testid="filter-bug-status"><option value="" data-i18n="all">All statuses</option><option value="open" data-i18n="open">Open</option><option value="in_progress" data-i18n="in_progress">In progress</option><option value="resolved" data-i18n="resolved">Resolved</option><option value="wont_fix" data-i18n="wont_fix">Won’t fix</option></select></div>
            <div class="apsh-field"><label for="apsh-admin-severity" data-i18n="severity">Severity</label><select id="apsh-admin-severity" data-testid="filter-bug-severity"><option value="" data-i18n="all">All severities</option><option value="low" data-i18n="low">Low</option><option value="medium" data-i18n="medium">Medium</option><option value="high" data-i18n="high">High</option><option value="critical" data-i18n="critical">Critical</option></select></div>
            <div class="apsh-field"><label for="apsh-admin-sector">Sector</label><select id="apsh-admin-sector" data-testid="filter-bug-sector"><option value="" data-i18n="all">All sectors</option><option value="education">Education</option><option value="mfi">MFI</option><option value="clinic">Clinic</option><option value="farm">Farm</option></select></div>
            <button class="apsh-btn apsh-btn-primary" type="button" data-admin-action="apply-filters" data-testid="button-apply-bug-filters" data-i18n="apply_filters">Apply filters</button>
          </div>
          <div class="apsh-admin-bug-layout"><div class="apsh-admin-report-list" data-admin-report-list aria-live="polite" data-testid="list-admin-bug-reports"></div><div class="apsh-admin-report-detail" data-admin-report-detail aria-live="polite" data-testid="panel-admin-bug-detail"><div class="apsh-empty-state apsh-empty-compact"><span class="apsh-empty-symbol"><i class="fas fa-hand-pointer" aria-hidden="true"></i></span><strong>Select a report</strong><p>Choose a report from the inbox to review its details.</p></div></div></div>`;
        cc.append(adminView);
        adminTab.addEventListener("click", () => {
            if (!isAdmin(currentUser)) return;
            document.querySelectorAll(".cc-tab").forEach((tab) => {
                const active = tab === adminTab;
                tab.classList.toggle("active", active);
                tab.setAttribute("aria-selected", String(active));
            });
            document.querySelectorAll("#commandCenter .cc-view").forEach((view) => view.classList.toggle("active", view === adminView));
            void loadAdminReports();
        }, listenOptions);
        if (!adminTabsListenerInstalled) {
            tabs.addEventListener("click", (event) => {
                const clicked = event.target.closest(".cc-tab");
                if (!clicked || clicked === adminTab) return;
                adminView?.classList.remove("active");
            }, { ...listenOptions, capture: true });
            adminTabsListenerInstalled = true;
        }
        adminView.addEventListener("click", handleAdminClick, listenOptions);
        adminView.addEventListener("change", (event) => {
            if (event.target.matches("#apsh-admin-status,#apsh-admin-severity,#apsh-admin-sector")) void loadAdminReports();
        }, listenOptions);
    }
    function adminFilters() {
        return new URLSearchParams({
            status: adminView?.querySelector("#apsh-admin-status")?.value || "",
            severity: adminView?.querySelector("#apsh-admin-severity")?.value || "",
            sector: adminView?.querySelector("#apsh-admin-sector")?.value || "",
        });
    }
    async function loadAdminReports() {
        if (!isAdmin(currentUser) || !adminView?.isConnected) return;
        const list = adminView.querySelector("[data-admin-report-list]");
        list.innerHTML = `<div class="apsh-loading-lines"><i></i><i></i><i></i></div>`;
        try {
            const query = adminFilters();
            const result = await request(`/api/admin/bug-reports?${query.toString()}`);
            const reports = Array.isArray(result) ? result : [];
            if (!reports.length) {
                list.innerHTML = `<div class="apsh-empty-state apsh-empty-compact"><span class="apsh-empty-symbol"><i class="fas fa-inbox" aria-hidden="true"></i></span><strong>No reports match</strong><p>Try a different status, severity or sector filter.</p></div>`;
                return;
            }
            list.innerHTML = `<div class="apsh-admin-report-rows">${reports.map((item, index) => `<button type="button" class="apsh-admin-report-row${String(item.id) === String(activeAdminReportId) ? " is-selected" : ""}" data-admin-action="open-report" data-report-id="${esc(item.id)}" data-testid="button-open-admin-report-${esc(item.id ?? index)}"><span class="apsh-report-priority apsh-priority--${esc(item.severity || "medium")}"></span><span class="apsh-admin-report-copy"><strong>${esc(item.title || "Bug report")}</strong><small>${esc(item.sector || "—")} · <span data-i18n="${esc(item.category || "other")}">${esc(labelFor(item.category || "other"))}</span></small><small>${esc(dateLabel(item.created_at))}</small></span><span class="apsh-status-pill apsh-report-status--${esc(item.status || "open")}" data-i18n="${esc(item.status || "open")}">${esc(labelFor(item.status || "open"))}</span></button>`).join("")}</div>`;
        } catch (error) {
            list.innerHTML = `<div class="apsh-inline-error" role="status">Reports could not be loaded. <button type="button" data-admin-action="refresh" data-testid="button-retry-admin-reports">Retry</button><span>${esc(error?.message || "")}</span></div>`;
        }
    }
    async function loadAdminReport(id) {
        if (!isAdmin(currentUser) || !id || !adminView) return;
        activeAdminReportId = id;
        const detail = adminView.querySelector("[data-admin-report-detail]");
        detail.innerHTML = `<div class="apsh-loading-lines"><i></i><i></i><i></i></div>`;
        try {
            const report = await request(`/api/admin/bug-reports/${encodeURIComponent(id)}`);
            const item = report?.report || report;
            const image = normalizeImage(item.screenshot_base64);
            detail.innerHTML = `
              <article class="apsh-admin-detail">
                <div class="apsh-admin-detail-top"><div><span class="apsh-detail-kicker">REPORT ${esc(item.id || "")}</span><h3>${esc(item.title || "Bug report")}</h3></div><span class="apsh-status-pill apsh-report-status--${esc(item.status || "open")}" data-testid="status-admin-report" data-i18n="${esc(item.status || "open")}">${esc(labelFor(item.status || "open"))}</span></div>
                <p class="apsh-admin-description">${esc(item.description || "")}</p>
                ${image ? `<figure class="apsh-report-image"><a href="${esc(image)}" target="_blank" rel="noopener noreferrer" data-testid="link-admin-screenshot"><img src="${esc(image)}" alt="Screenshot attached to report"></a><figcaption>Submitted screenshot · select to open full size</figcaption></figure>` : ""}
                <dl class="apsh-report-meta"><div><dt>Role</dt><dd>${esc(item.user_role || "—")}</dd><dt>Sector</dt><dd>${esc(item.sector || "—")}</dd><dt>Category</dt><dd data-i18n="${esc(item.category || "other")}">${esc(labelFor(item.category || "other"))}</dd><dt>Severity</dt><dd data-i18n="${esc(item.severity || "medium")}">${esc(labelFor(item.severity || "medium"))}</dd><dt>Created</dt><dd>${esc(dateLabel(item.created_at))}</dd><dt>Page</dt><dd class="apsh-report-url">${esc(item.url || "—")}</dd></div></dl>
                <details class="apsh-context-details"><summary>Device context</summary><pre>${esc(typeof item.device_info === "object" ? JSON.stringify(item.device_info, null, 2) : item.device_info || "Not provided")}</pre></details>
                <form class="apsh-admin-notes-form" data-admin-notes-form><label for="apsh-admin-notes" data-i18n="admin_notes">Admin notes</label><textarea id="apsh-admin-notes" name="admin_notes" rows="4" maxlength="5000" data-testid="input-admin-notes">${esc(item.admin_notes || "")}</textarea><button type="submit" class="apsh-btn apsh-btn-primary" data-testid="button-save-admin-notes" data-i18n="save_notes">Save notes</button><p class="apsh-settings-status" role="status" aria-live="polite" data-testid="status-admin-notes"></p></form>
                <div class="apsh-admin-status-actions"><span data-i18n="update_status">Update status</span><button type="button" class="apsh-btn apsh-btn-quiet" data-admin-action="set-status" data-status="in_progress" data-testid="button-report-in-progress" data-i18n="in_progress">In progress</button><button type="button" class="apsh-btn apsh-btn-quiet" data-admin-action="set-status" data-status="resolved" data-testid="button-report-resolved" data-i18n="resolved">Resolved</button><button type="button" class="apsh-btn apsh-btn-danger-quiet" data-admin-action="set-status" data-status="wont_fix" data-testid="button-report-wont-fix" data-i18n="wont_fix">Won’t fix</button></div>
              </article>`;
            detail.querySelector("[data-admin-notes-form]").addEventListener("submit", async (event) => {
                event.preventDefault();
                await updateAdminReport(id, { admin_notes: detail.querySelector('[name="admin_notes"]').value.trim() }, detail.querySelector('[data-testid="status-admin-notes"]'));
            }, listenOptions);
        } catch (error) {
            detail.innerHTML = `<div class="apsh-inline-error" role="status">Report details could not be loaded. <button type="button" data-admin-action="open-report" data-report-id="${esc(id)}" data-testid="button-retry-admin-detail">Try again</button><span>${esc(error?.message || "")}</span></div>`;
        }
    }
    async function updateAdminReport(id, patch, statusNode) {
        if (!isAdmin(currentUser)) return;
        if (statusNode) statusNode.textContent = "Saving…";
        try {
            await request(`/api/admin/bug-reports/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
            if (statusNode) statusNode.textContent = "Saved.";
            await loadAdminReport(id);
            await loadAdminReports();
        } catch (error) {
            if (statusNode) { statusNode.textContent = error?.message || "Update failed."; statusNode.dataset.kind = "error"; }
        }
    }
    async function handleAdminClick(event) {
        const button = event.target.closest("[data-admin-action]");
        if (!button) return;
        const action = button.dataset.adminAction;
        if (action === "refresh" || action === "apply-filters") await loadAdminReports();
        if (action === "open-report") await loadAdminReport(button.dataset.reportId);
        if (action === "set-status") await updateAdminReport(activeAdminReportId, { status: button.dataset.status }, adminView.querySelector('[data-testid="status-admin-report"]'));
    }

    gearButton.addEventListener("click", openSettings, listenOptions);
    root.querySelector('[data-action="close-settings"]').addEventListener("click", closeSettings, listenOptions);
    root.querySelectorAll(".apsh-settings-nav [data-section]").forEach((button) => button.addEventListener("click", () => changeSection(button.dataset.section), listenOptions));
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeSettings(); }, listenOptions);
    panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeSettings(); return; }
        if (event.key !== "Tab") return;
        const focusable = [...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null);
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
    }, listenOptions);
    [langSelect, saverSelect, themeSelect, tzSelect].forEach((select) => select.addEventListener("change", () => {
        preferences[select.dataset.pref] = select.value;
        if (select === langSelect) loadedLanguage = "";
        applyPreferences();
        queuePreferenceSave();
    }, listenOptions));
    notificationsInput.addEventListener("change", () => {
        preferences.notifications_enabled = notificationsInput.checked;
        queuePreferenceSave();
    }, listenOptions);
    root.querySelector("[data-bug-form]").addEventListener("submit", submitBugReport, listenOptions);
    root.querySelector('[name="screenshot"]').addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        const note = root.querySelector("[data-screenshot-note]");
        if (file && file.size > 500 * 1024) {
            note.textContent = "This file is larger than 500 KB. Choose a smaller screenshot.";
            event.target.setAttribute("aria-invalid", "true");
        } else {
            event.target.removeAttribute("aria-invalid");
            note.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : "Attach a screenshot only if it helps explain the issue.";
        }
    }, listenOptions);
    root.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        if (action === "clear-cache") void clearCache();
        else if (action === "clear-queue") void clearQueue();
        else if (action === "refresh-sync" || action === "retry-history") void loadSyncHistory();
        else if (action === "retry-help") { const box = root.querySelector("[data-help-content]"); if (box) box.dataset.loaded = "false"; void loadHelp(); }
        else if (action === "refresh-reports" || action === "retry-own-reports") void loadOwnReports();
    }, listenOptions);

    themeMedia = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
    themeMedia?.addEventListener?.("change", applyPreferences, listenOptions);
    connection?.addEventListener?.("change", applyPreferences, listenOptions);
    videoObserver = new MutationObserver((changes) => {
        if (saverIsActive()) applyDataSaver();
        translateAddedNodes(changes.flatMap((change) => [...change.addedNodes]));
    });
    if (document.body) videoObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", addGearEntry, listenOptions);
    addGearEntry();

    function setUser(user) {
        const previousId = currentUser?.id;
        currentUser = user || getCurrentUser?.() || null;
        const nextId = currentUser?.id;
        const accountChanged = String(previousId || "") !== String(nextId || "");
        if (accountChanged) {
            clearTimeout(prefSaveTimer);
            preferenceRevision += 1;
        }
        gearButton.hidden = !currentUser;
        userName.textContent = currentUser?.name || currentUser?.email || "";
        if (!currentUser && open) closeSettings();
        if (accountChanged) {
            preferences = {
                ...preferences,
                language: "en",
                data_saver: "auto",
                theme: "auto",
                notifications_enabled: true,
                timezone: "Africa/Kampala",
                settings: {},
            };
            aboutData = null;
            const guide = root.querySelector("[data-help-content]");
            if (guide) guide.dataset.loaded = "false";
        }
        installAdminSurface();
        applyPreferences();
        if (accountChanged && currentUser?.id) void loadPreferences();
        if (open && currentUser?.id) {
            void refreshOffline();
            void loadHelp();
            void loadOwnReports();
        }
    }

    installAdminSurface();
    setUser(getCurrentUser?.());

    return {
        setUser,
        destroy() {
            aborter.abort();
            clearTimeout(prefSaveTimer);
            videoObserver?.disconnect();
            document.body.classList.remove("apsh-settings-open");
            preferences.data_saver = "off";
            activateVideoSaver();
            globalThis.__APSHULE_SAVE_DATA_ACTIVE = false;
            root.remove();
            adminTab?.remove();
            adminView?.remove();
            gearButton.remove();
            if (originalTheme == null) document.documentElement.removeAttribute("data-apshule-theme");
            else document.documentElement.setAttribute("data-apshule-theme", originalTheme);
            if (originalSaver == null) document.documentElement.removeAttribute("data-apshule-data-saver");
            else document.documentElement.setAttribute("data-apshule-data-saver", originalSaver);
            document.documentElement.style.colorScheme = originalColorScheme;
            if (originalLanguage == null) document.documentElement.removeAttribute("lang");
            else document.documentElement.setAttribute("lang", originalLanguage);
            if (ownsStylesheet) stylesheet?.remove();
        },
    };
}
