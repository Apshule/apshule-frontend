const icon = (name, extra = "") => `<i class="fas fa-${name}${extra ? ` ${extra}` : ""}" aria-hidden="true"></i>`;
let studioInstance = null;

export function initVideoStudioUI({ api, getCurrentUser = () => null, notify = () => {}, escapeHtml } = {}) {
  if (typeof api !== "function") throw new TypeError("initVideoStudioUI requires the app api(path, options) function.");
  if (studioInstance) {
    studioInstance.updateDependencies({ api, getCurrentUser, notify, escapeHtml });
    studioInstance.setUser(getCurrentUser?.());
    return studioInstance.publicApi;
  }

  let dependencies = { api, getCurrentUser, notify, escapeHtml };
  const localEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const esc = (value) => {
    try { return typeof dependencies.escapeHtml === "function" ? dependencies.escapeHtml(String(value ?? "")) : localEscape(value); }
    catch { return localEscape(value); }
  };
  const safeUrl = (value) => {
    const text = String(value || "").trim();
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,/iu.test(text)) return text;
    try {
      const parsed = new URL(text, location.href);
      return ["https:", "http:", "blob:"].includes(parsed.protocol) ? text : "";
    } catch { return ""; }
  };
  const safeHttpUrl = (value) => {
    try {
      const parsed = new URL(String(value || "").trim());
      return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : "";
    } catch { return ""; }
  };
  const listFrom = (result, key) => Array.isArray(result) ? result : Array.isArray(result?.[key]) ? result[key] : [];
  const thumbnailUrl = (project) => {
    const thumb = project.thumbnail_base64 || project.thumbnail_url || project.cover_url || project.scenes?.[0]?.background_url;
    if (project.thumbnail_base64 && !String(project.thumbnail_base64).startsWith("data:")) return `data:image/jpeg;base64,${project.thumbnail_base64}`;
    return safeUrl(thumb);
  };
  const request = (path, options) => dependencies.api(path, options);
  const notifyUser = (message, type = "info") => { try { dependencies.notify(message, type); } catch {} };
  const root = document.createElement("div");
  root.className = "apsh-video-studio";
  root.innerHTML = `
    <div class="apsh-vs-backdrop" data-vs-backdrop hidden>
      <div class="apsh-vs-app" role="dialog" aria-modal="true" aria-labelledby="vs-app-title" tabindex="-1">
        <header class="apsh-vs-topbar">
          <div class="apsh-vs-brand"><span class="apsh-vs-mark" aria-hidden="true">A</span><div><small data-i18n="video_studio_kicker">APSHULE · TEACHER TOOLS</small><h1 id="vs-app-title" data-i18n="video_studio">Video Studio</h1></div></div>
          <div class="apsh-vs-top-actions"><span class="apsh-vs-user" data-vs-user></span><button class="apsh-vs-close" type="button" data-action="close" aria-label="Close Video Studio" data-i18n-aria-label="close_video_studio">${icon("xmark")}</button></div>
        </header>
        <main class="apsh-vs-shell" data-vs-main tabindex="-1">
          <div data-vs-view="projects">
            <div class="apsh-vs-page-head">
              <div><p class="apsh-vs-eyebrow" data-i18n="video_studio_eyebrow">LESSON VIDEO WORKSPACE</p><h2 data-i18n="your_projects">Your projects</h2><p data-i18n="video_studio_intro">Build a lesson, scene by scene. Narration, visuals and exports stay in your browser.</p></div>
              <div class="apsh-vs-actions"><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="new-project">${icon("plus")}<span data-i18n="new_project">New project</span></button></div>
            </div>
            <nav class="apsh-vs-tabs" aria-label="Video Studio sections" data-i18n-aria-label="video_studio_sections">
              <button type="button" data-action="show-projects" aria-current="page">${icon("film")}<span data-i18n="projects">Projects</span></button>
              <button type="button" data-action="show-library">${icon("play")}<span data-i18n="video_library">Video library</span><span data-vs-library-count></span></button>
            </nav>
            <div data-vs-project-list aria-live="polite"></div>
            <div data-vs-project-error class="apsh-vs-error" role="alert" hidden></div>
          </div>
          <div data-vs-view="library" hidden>
            <div class="apsh-vs-page-head">
              <div><p class="apsh-vs-eyebrow" data-i18n="video_studio_eyebrow">LESSON VIDEO WORKSPACE</p><h2 data-i18n="video_library">Video library</h2><p data-i18n="library_intro">Find published lesson videos and resources saved to your workspace.</p></div>
              <div class="apsh-vs-actions"><button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="add-library-link">${icon("link")}<span data-i18n="add_video_link">Add video link</span></button><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="new-project">${icon("plus")}<span data-i18n="new_project">New project</span></button></div>
            </div>
            <nav class="apsh-vs-tabs" aria-label="Video Studio sections" data-i18n-aria-label="video_studio_sections">
              <button type="button" data-action="show-projects">${icon("film")}<span data-i18n="projects">Projects</span></button>
              <button type="button" data-action="show-library" aria-current="page">${icon("play")}<span data-i18n="video_library">Video library</span><span data-vs-library-count></span></button>
            </nav>
            <div class="apsh-vs-filterbar">
              <div class="apsh-vs-field apsh-vs-search"><label for="vs-library-search" data-i18n="search_library">Search library</label><input id="vs-library-search" type="search" data-library-search></div>
              <div class="apsh-vs-field"><label for="vs-library-category" data-i18n="category">Category</label><select id="vs-library-category" data-library-category><option value="" data-i18n="all_categories">All categories</option></select></div>
              <div class="apsh-vs-field"><label for="vs-library-language" data-i18n="language">Language</label><select id="vs-library-language" data-library-language><option value="" data-i18n="all_languages">All languages</option></select></div>
              <button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="refresh-library">${icon("rotate")}<span data-i18n="refresh">Refresh</span></button>
            </div>
            <div data-vs-library-list aria-live="polite"></div>
            <div data-vs-library-error class="apsh-vs-error" role="alert" hidden></div>
          </div>
          <div data-vs-view="editor" hidden>
            <div class="apsh-vs-editor-head">
              <button type="button" class="apsh-vs-back" data-action="back-projects">${icon("arrow-left")} <span data-i18n="back_to_projects">Back to projects</span></button>
              <div class="apsh-vs-field"><label for="vs-project-title" data-i18n="project_title">Project title</label><input id="vs-project-title" maxlength="180" data-project-title><label for="vs-project-description" data-i18n="project_description">Short description</label><input id="vs-project-description" maxlength="500" data-project-description></div>
              <div class="apsh-vs-actions"><button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="save-project">${icon("floppy-disk")}<span data-i18n="save_draft">Save draft</span></button><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="open-render">${icon("clapperboard")}<span data-i18n="render_video">Render video</span></button></div>
            </div>
            <div class="apsh-vs-editor-layout">
              <aside class="apsh-vs-scene-panel" aria-label="Scene list" data-i18n-aria-label="scene_list">
                <div class="apsh-vs-panel-heading"><h3 data-i18n="scenes">Scenes</h3><button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="add-scene">${icon("plus")}<span data-i18n="add_scene">Add scene</span></button></div>
                <div class="apsh-vs-scenes" data-vs-scenes></div>
              </aside>
              <section class="apsh-vs-editor-panel" aria-label="Scene editor" data-i18n-aria-label="scene_editor">
                <div class="apsh-vs-panel-heading"><h3 data-i18n="scene_editor">Scene editor</h3><span class="apsh-vs-pill" data-vs-scene-index></span></div>
                <div class="apsh-vs-workarea">
                  <div>
                    <div class="apsh-vs-form-grid">
                      <div class="apsh-vs-field apsh-vs-span-2"><label for="vs-scene-title" data-i18n="scene_title">Scene title</label><input id="vs-scene-title" maxlength="160" data-scene-field="title"></div>
                      <div class="apsh-vs-field apsh-vs-span-2"><label for="vs-scene-body" data-i18n="scene_body">On-screen text</label><textarea id="vs-scene-body" rows="3" maxlength="1200" data-scene-field="body"></textarea></div>
                      <div class="apsh-vs-field"><label for="vs-scene-duration" data-i18n="scene_duration">Duration · seconds</label><input id="vs-scene-duration" type="number" min="3" max="30" step="1" data-scene-field="duration" value="8"><small data-i18n="scene_duration_hint">Choose 3–30 seconds.</small></div>
                      <div class="apsh-vs-field"><label for="vs-scene-background" data-i18n="background">Background</label><select id="vs-scene-background" data-scene-field="background_type"><option value="solid" data-i18n="solid_color">Solid color</option><option value="image" data-i18n="image_background">Image</option><option value="video" data-i18n="video_background">Video</option></select></div>
                      <div class="apsh-vs-field apsh-vs-span-2" data-vs-color-field><label for="vs-scene-color" data-i18n="background_color">Background color</label><input id="vs-scene-color" type="color" data-scene-field="background_color" value="#17675f"></div>
                      <div class="apsh-vs-field apsh-vs-span-2" data-vs-background-url-field hidden><label for="vs-scene-background-url" data-i18n="background_url">Background media URL</label><input id="vs-scene-background-url" type="url" data-scene-field="background_url"></div>
                      <div class="apsh-vs-field"><label for="vs-narration-voice" data-i18n="narration_voice">Narration voice</label><select id="vs-narration-voice" data-voice-select><option value="" data-i18n="browser_default_voice">Browser default</option></select></div>
                      <div class="apsh-vs-field apsh-vs-span-2"><label for="vs-speech-text" data-i18n="speech_text">Narration text</label><textarea id="vs-speech-text" rows="3" maxlength="1800" data-scene-field="speech_text"></textarea><div class="apsh-vs-media-actions"><button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="preview-voice">${icon("play")}<span data-i18n="generate_voice">Generate voice</span></button></div><small data-i18n="browser_speech_note">Optional · spoken with browser-native speech. Nothing is sent to a paid voice service.</small></div>
                      <div class="apsh-vs-field apsh-vs-span-2"><label for="vs-audio-file"><span data-i18n="upload_audio">Use an audio file</span></label><input id="vs-audio-file" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" data-audio-file><small data-i18n="audio_file_hint">Optional · MP3, WAV or M4A · stays on this device · up to 1 MB.</small><div class="apsh-vs-media-actions"><span data-vs-audio-name class="apsh-vs-credit" aria-live="polite"></span><button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="clear-audio" hidden data-i18n="remove_audio">Remove audio</button></div></div>
                    </div>
                    <div class="apsh-vs-media-actions">
                      <button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="open-pixabay">${icon("magnifying-glass")}<span data-i18n="choose_pixabay">Choose Pixabay media</span></button>
                      <button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="clear-background" data-i18n="clear_background">Clear media</button>
                    </div>
                    <p class="apsh-vs-credit" data-vs-attribution></p>
                    <div class="apsh-vs-pixabay" data-vs-pixabay hidden>
                      <div class="apsh-vs-filterbar" style="margin:0;padding:0;border:0;background:transparent">
                        <div class="apsh-vs-field apsh-vs-search"><label for="vs-pixabay-query" data-i18n="search_pixabay">Search Pixabay</label><input id="vs-pixabay-query" type="search" data-pixabay-query></div>
                        <div class="apsh-vs-field"><label for="vs-pixabay-type" data-i18n="pixabay_media_type">Pixabay media</label><select id="vs-pixabay-type" data-pixabay-type><option value="image" data-i18n="images">Images</option><option value="video" data-i18n="videos">Videos</option></select></div>
                        <button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="search-pixabay"><span data-i18n="search">Search</span></button>
                      </div>
                      <div data-vs-pixabay-results class="apsh-vs-pixabay-results" aria-live="polite"></div>
                    </div>
                    <div class="apsh-vs-pixabay" data-vs-pixabay-fallback hidden>
                      <p class="apsh-vs-local-media-title" data-i18n="local_media_fallback">📷 Upload your own image or paste a URL</p>
                      <div class="apsh-vs-form-grid">
                        <div class="apsh-vs-field apsh-vs-span-2">
                          <label for="vs-local-background-file" data-i18n="upload_image">Upload an image</label>
                          <input id="vs-local-background-file" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" data-local-background-file>
                          <small data-i18n="image_file_hint">PNG, JPEG, or WebP · maximum 300 KB · saved with this project.</small>
                          <span class="apsh-vs-credit" data-vs-local-image-name aria-live="polite"></span>
                        </div>
                        <div class="apsh-vs-field apsh-vs-span-2">
                          <label for="vs-local-background-url" data-i18n="image_url">Image URL</label>
                          <input id="vs-local-background-url" type="url" placeholder="https://example.com/image.jpg" data-local-background-url>
                          <button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="use-local-image-url" data-i18n="use_image_url">Use URL</button>
                        </div>
                      </div>
                      <div class="apsh-vs-media-actions">
                        <button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="retry-pixabay" data-i18n="try_pixabay_again">Try Pixabay again</button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div class="apsh-vs-preview-top"><span data-i18n="canvas_preview">Canvas preview</span><span data-i18n="sixteen_nine">16:9</span></div>
                    <div class="apsh-vs-preview-wrap">
                      <canvas class="apsh-vs-preview" data-vs-preview width="1280" height="720" role="img" aria-label="Scene canvas preview" data-i18n-aria-label="scene_canvas_preview"></canvas>
                    </div>
                    <p class="apsh-vs-context"><span>${icon("circle-info")}</span><span data-i18n="preview_context">Your preview is assembled from scene text and media. The finished WebM is rendered and saved locally.</span></p>
                  </div>
                </div>
                <div class="apsh-vs-editor-footer"><p class="apsh-vs-status" role="status" aria-live="polite" data-vs-editor-status></p><div class="apsh-vs-actions"><button type="button" class="apsh-vs-btn apsh-vs-danger apsh-vs-sm" data-action="delete-project">${icon("trash")}<span data-i18n="delete_project">Delete project</span></button></div></div>
              </section>
            </div>
            <section class="apsh-vs-editor-panel" style="margin-top:12px" data-vs-publish-panel>
              <div class="apsh-vs-panel-heading"><div><h3 data-i18n="publish_youtube">YouTube publishing</h3><p data-i18n="publish_youtube_note">Upload your downloaded WebM to YouTube manually, then paste the video URL here.</p></div><span class="apsh-vs-pill" data-vs-publish-status data-i18n="draft">Draft</span></div>
              <div class="apsh-vs-actions"><a class="apsh-vs-btn apsh-vs-quiet" href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer" data-i18n="open_youtube_studio">Open YouTube Studio</a><button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="paste-published-url">${icon("link")}<span data-i18n="paste_video_url">Paste video URL</span></button><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="mark-published">${icon("check")}<span data-i18n="mark_published">Mark published</span></button></div>
              <p class="apsh-vs-credit" data-vs-published-url></p>
            </section>
            <div class="apsh-vs-progress" data-vs-progress-wrap hidden><div style="display:flex;justify-content:space-between;gap:10px"><strong data-i18n="rendering_progress">Rendering video…</strong><span data-vs-progress-label>0%</span></div><progress max="100" value="0" data-vs-progress></progress><div class="apsh-vs-actions"><button type="button" class="apsh-vs-btn apsh-vs-danger apsh-vs-sm" data-action="cancel-render" data-i18n="cancel_render">Cancel render</button></div><p class="apsh-vs-credit" data-vs-render-status role="status" aria-live="polite"></p></div>
          </div>
        </main>
      </div>
      <div class="apsh-vs-modal-layer" data-vs-modal-layer hidden>
        <section class="apsh-vs-modal" role="dialog" aria-modal="true" aria-labelledby="vs-modal-title" tabindex="-1">
          <h2 id="vs-modal-title" data-vs-modal-title></h2>
          <div data-vs-modal-content></div>
          <div class="apsh-vs-modal-actions" data-vs-modal-actions></div>
        </section>
      </div>
    </div>`;
  document.body.append(root);
  let stylesheet = document.getElementById("apsh-video-studio-stylesheet");
  if (!stylesheet) {
    stylesheet = document.createElement("link");
    stylesheet.id = "apsh-video-studio-stylesheet";
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./video-studio-ui.css", import.meta.url).href;
    document.head.append(stylesheet);
  }

  const backdrop = root.querySelector("[data-vs-backdrop]");
  const modalLayer = root.querySelector("[data-vs-modal-layer]");
  const modalTitle = root.querySelector("[data-vs-modal-title]");
  const modalContent = root.querySelector("[data-vs-modal-content]");
  const modalActions = root.querySelector("[data-vs-modal-actions]");
  const views = [...root.querySelectorAll("[data-vs-view]")];
  const state = {
    user: null, isOpen: false, previousFocus: null, view: "projects", projects: [], library: [],
    libraryLoaded: false, libraryLoading: false, libraryRequestId: 0, libraryTotal: 0, libraryCategories: new Set(), libraryLanguages: new Set(), librarySearchTimer: null, project: null, selectedScene: 0, pixabayResults: [], pixabayType: "image", pixabayUnavailable: false, pixabayOpen: false,
    publishedUrl: "", ttsVoices: [], renderController: null,
    projectLoading: false, ttsVoicesLoaded: false, savingProject: false, creatingProject: false,
    previewKey: "", previewSource: null, previewFrame: 0, draggingSceneIndex: null,
  };
  const schoolLaunch = document.createElement("section");
  schoolLaunch.className = "apsh-vs-school-launch";
  schoolLaunch.hidden = true;
  schoolLaunch.innerHTML = `<div><p class="apsh-vs-eyebrow" data-i18n="video_studio_eyebrow">LESSON VIDEO WORKSPACE</p><h2 data-i18n="video_studio">Video Studio</h2><p data-i18n="video_studio_dashboard_desc">Create, narrate and publish free lesson videos.</p></div><button type="button" class="apsh-vs-btn apsh-vs-primary" data-video-studio-open><span data-i18n="open_video_studio">Open Video Studio</span>${icon("arrow-right")}</button>`;
  const adminLaunch = document.createElement("section");
  adminLaunch.className = "apsh-vs-admin-launch";
  adminLaunch.hidden = true;
  adminLaunch.innerHTML = `<div class="apsh-vs-admin-head"><div><p class="apsh-vs-eyebrow" data-i18n="video_studio_eyebrow">LESSON VIDEO WORKSPACE</p><h2 data-i18n="video_studio">Video Studio</h2><p data-i18n="video_admin_summary">Published lessons shared across APSHULE.</p></div><div class="apsh-vs-admin-filter"><label for="vs-admin-sector" data-i18n="filter_sector">Filter by sector</label><select id="vs-admin-sector" data-vs-admin-sector><option value="" data-i18n="all_sectors">All sectors</option><option value="education" data-i18n="education">Education</option><option value="mfi" data-i18n="mfi">MFI</option><option value="clinic" data-i18n="clinic">Clinic</option><option value="farm" data-i18n="farm">Farm</option></select></div></div><div data-vs-admin-stat-content></div><button type="button" class="apsh-vs-btn apsh-vs-quiet" data-video-studio-open><span data-i18n="open_video_studio">Open Video Studio</span>${icon("arrow-right")}</button>`;
  const teacherLaunchMarkup = `<span class="teacher-tool-icon" aria-hidden="true">🎬</span><strong data-i18n="video_studio">Video Studio</strong><small data-i18n="video_studio_dashboard_desc">Create, narrate and publish free lesson videos.</small><span class="teacher-tool-count" data-vs-teacher-count><span data-vs-draft-count>0</span> <span data-i18n="drafts">drafts</span> · <span data-vs-published-count>0</span> <span data-i18n="published">published</span></span><small data-i18n="video_studio_dashboard_hint">Build and export a lesson video on this device.</small>`;
  function syncDashboardEntryPoints(user) {
    const eligible = Boolean(user) && (
      user.role === "superadmin" ||
      (user.sector === "education" && ["teacher", "school"].includes(user.role))
    );
    let teacherLaunch = document.querySelector('[data-video-studio-launch="teacher"]');
    const teacherGrid = document.querySelector("#teacherDashboardSection .teacher-dashboard-grid");
    if (!teacherLaunch && teacherGrid) {
      teacherLaunch = document.createElement("button");
      teacherLaunch.type = "button";
      teacherLaunch.className = "teacher-tool-card apsh-vs-teacher-launch";
      teacherLaunch.dataset.videoStudioLaunch = "teacher";
      teacherLaunch.dataset.videoStudioOpen = "";
      teacherLaunch.innerHTML = teacherLaunchMarkup;
      teacherGrid.append(teacherLaunch);
    }
    if (teacherLaunch) teacherLaunch.hidden = !eligible || user?.role !== "teacher";
    updateTeacherStats();
    const home = document.getElementById("homePage");
    if (home && !schoolLaunch.isConnected) home.append(schoolLaunch);
    schoolLaunch.hidden = !eligible || user?.role !== "school";
    const commandCenter = document.getElementById("commandCenter");
    if (commandCenter && !adminLaunch.isConnected) {
      const tabs = commandCenter.querySelector(".cc-tabs");
      commandCenter.insertBefore(adminLaunch, tabs || null);
    }
    adminLaunch.hidden = !eligible || user?.role !== "superadmin";
    if (user?.role === "superadmin" && !adminLaunch.dataset.loaded) {
      adminLaunch.dataset.loaded = "true";
      const selector = adminLaunch.querySelector("[data-vs-admin-sector]");
      selector?.addEventListener("change", () => {
        void renderSuperAdminStats(adminLaunch.querySelector("[data-vs-admin-stat-content]"), selector.value);
      });
    }
    if (user?.role === "superadmin" && eligible) {
      void renderSuperAdminStats(adminLaunch.querySelector("[data-vs-admin-stat-content]"), adminLaunch.querySelector("[data-vs-admin-sector]")?.value || "");
    }
  }

  const element = (selector) => root.querySelector(selector);
  const setLibraryCount = () => {
    const text = state.libraryTotal ? ` · ${state.libraryTotal}` : "";
    root.querySelectorAll("[data-vs-library-count]").forEach((node) => { node.textContent = text; });
  };
  const setStatus = (selector, message, error = false) => {
    const node = element(selector);
    if (!node) return;
    if (!message) node.replaceChildren();
    else {
      const messages = [
        ["Saving draft…", "saving_draft", "Saving draft…"],
        ["Draft saved.", "draft_saved", "Draft saved."],
      ];
      const match = messages.find(([prefix]) => message === prefix);
      let key = match?.[1] || "video_studio_status";
      let fallback = match?.[2] || message;
      let detail = "";
      if (message.startsWith("Could not save draft.")) { key = "could_not_save_draft"; fallback = "Could not save draft."; detail = message.slice(fallback.length); }
      else if (message.startsWith("Could not delete project.")) { key = "could_not_delete_project"; fallback = "Could not delete project."; detail = message.slice(fallback.length); }
      node.innerHTML = `<span data-i18n="${key}">${esc(fallback)}</span>${detail ? `<span>${esc(detail)}</span>` : ""}`;
    }
    node.dataset.kind = error ? "error" : "success";
  };
  const setI18nText = (selector, key, fallback, detail = "") => {
    const node = element(selector);
    if (node) node.innerHTML = `<span data-i18n="${key}">${esc(fallback)}</span>${detail ? `<span>${esc(detail)}</span>` : ""}`;
  };
  const sceneDefault = () => ({
    title: "New scene", body: "", duration: 8, background_type: "solid", background_color: "#17675f",
    background_url: "", speech_text: "", attribution: "", voiceover_audio_base64: "", voiceover_audio_name: "",
  });
  const normalizeScene = (raw = {}) => ({
    ...sceneDefault(), ...raw,
    duration: Math.min(30, Math.max(3, Number(raw.duration_seconds ?? raw.duration ?? 8))),
    background_type: raw.background_type === "color" ? "solid" : (["solid", "image", "video"].includes(raw.background_type) ? raw.background_type : "solid"),
    background_color: raw.background_value || raw.background_color || "#17675f",
    background_url: raw.background_asset_url || raw.background_url || "",
    attribution: raw.background_user ? `${raw.background_user} / Pixabay` : (raw.attribution || ""),
    speech_text: raw.voiceover_text ?? raw.speech_text ?? "",
    voiceover_audio_base64: raw.voiceover_audio_base64 || "",
    voiceover_audio_name: raw.voiceover_audio_name || "",
  });
  const normalizeProject = (raw = {}) => ({
    ...raw,
    id: raw.id ?? raw.project_id,
    title: raw.title || raw.name || "Untitled lesson",
    scenes: (Array.isArray(raw.scenes) ? raw.scenes : []).map(normalizeScene),
    description: raw.description || "",
    language: raw.language || "en",
    status: raw.status || (raw.published_url ? "published" : "draft"),
  });
  const currentScene = () => state.project?.scenes?.[state.selectedScene] || null;
  const fmtDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    try { return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(); } catch { return String(value); }
  };
  const setView = (view) => {
    if (view !== "editor") stopPreview();
    state.view = view;
    views.forEach((node) => { node.hidden = node.dataset.vsView !== view; });
    root.querySelectorAll(".apsh-vs-tabs [data-action]").forEach((button) => {
      button.setAttribute("aria-current", button.dataset.action === (view === "library" ? "show-library" : "show-projects") ? "page" : "false");
      if (button.getAttribute("aria-current") === "false") button.removeAttribute("aria-current");
    });
    if (view === "projects") void loadProjects();
    if (view === "library") void loadLibrary();
  };
  const setOpen = (open) => {
    state.isOpen = open;
    backdrop.hidden = !open;
    document.body.classList.toggle("apsh-vs-open", open);
    if (open) {
      state.previousFocus = document.activeElement;
      root.querySelector("[data-vs-main]")?.focus();
      setView(state.view === "editor" && state.project ? "editor" : "projects");
      void loadTtsVoices();
    } else {
      stopPreview();
      closeModal();
      if (state.previousFocus?.isConnected) state.previousFocus.focus();
    }
  };
  const modalTitleKeys = new Map([
    ["Delete this project?", "delete_project_confirm_title"], ["Add a video link", "add_video_link"],
    ["Confirm YouTube publishing", "confirm_youtube_publishing"], ["Prepare a local render", "prepare_local_render"],
    ["WebM export unavailable", "webm_unavailable"], ["Include your voiceover?", "render_modal_title"],
    ["Add narration audio", "upload_audio_instead"],
  ]);
  let modalPreviousFocus = null;
  const showModal = (title, bodyHtml, actions) => {
    modalPreviousFocus = document.activeElement;
    modalTitle.textContent = title;
    if (modalTitleKeys.has(title)) modalTitle.dataset.i18n = modalTitleKeys.get(title);
    else delete modalTitle.dataset.i18n;
    modalContent.innerHTML = bodyHtml;
    modalActions.innerHTML = actions;
    modalLayer.hidden = false;
    modalLayer.querySelector(".apsh-vs-modal")?.focus();
  };
  const closeModal = () => {
    modalLayer.hidden = true;
    modalContent.replaceChildren();
    modalActions.replaceChildren();
    if (modalPreviousFocus?.isConnected) modalPreviousFocus.focus();
    modalPreviousFocus = null;
  };
  const emptyMarkup = (titleKey, title, descriptionKey, description, action = "") => `<div class="apsh-vs-empty"><span class="apsh-vs-empty-icon">${icon("film")}</span><strong data-i18n="${titleKey}">${title}</strong><p data-i18n="${descriptionKey}">${description}</p>${action}</div>`;
  const errorMarkup = (message, retryAction) => `<span>${esc(message)}</span><button type="button" data-action="${retryAction}" data-i18n="retry">Retry</button>`;
  const displayError = (selector, message, retryAction) => {
    const node = element(selector);
    node.innerHTML = errorMarkup(message, retryAction);
    node.hidden = false;
  };

  async function loadProjects() {
    if (!state.user) return;
    state.projectLoading = true;
    const host = element("[data-vs-project-list]");
    host.innerHTML = `<div class="apsh-vs-skeleton" aria-label="Loading projects" data-i18n-aria-label="loading_projects"><i></i><i></i><i></i></div>`;
    element("[data-vs-project-error]").hidden = true;
    try {
      const result = await request("/api/video-studio/projects");
      state.projects = listFrom(result, "projects").map(normalizeProject);
      updateTeacherStats();
      if (state.isOpen && state.view === "projects") renderProjects();
      await refreshCounts();
    } catch (error) {
      if (state.isOpen && state.view === "projects") {
        host.replaceChildren();
        displayError("[data-vs-project-error]", `Could not load projects. ${error?.message || "Try again."}`, "refresh-projects");
      }
      notifyUser(`Could not load Video Studio projects. ${error?.message || ""}`, "error");
    } finally { state.projectLoading = false; }
  }

  function renderProjects() {
    const host = element("[data-vs-project-list]");
    element("[data-vs-project-error]").hidden = true;
    if (!state.projects.length) {
      host.innerHTML = emptyMarkup("no_video_projects", "Your next lesson starts here", "no_video_projects_note", "Create a scene, add narration and choose a visual. Your draft will be saved to APSHULE.", `<button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="new-project">${icon("plus")}<span data-i18n="new_project">New project</span></button>`);
      return;
    }
    host.innerHTML = `<div class="apsh-vs-grid">${state.projects.map((project, index) => {
      const previewUrl = thumbnailUrl(project);
      const status = String(project.status || "draft");
      return `<article class="apsh-vs-project">
        <div class="apsh-vs-project-art">${previewUrl ? `<img src="${esc(previewUrl)}" alt="" loading="lazy">` : `<span data-i18n="lesson_video">${String(index + 1).padStart(2, "0")} · LESSON</span>`}</div>
        <div class="apsh-vs-project-copy"><h3>${esc(project.title)}</h3><p>${project.scenes.length} <span data-i18n="scenes_count_label">scenes</span> · ${esc(fmtDate(project.updated_at || project.created_at))}${!project.updated_at && !project.created_at ? ` <span data-i18n="draft_in_progress">Draft in progress</span>` : ""}</p><div class="apsh-vs-project-meta"><span class="apsh-vs-pill ${status === "published" ? "is-published" : ""}" data-i18n="${status === "published" ? "published" : "draft"}">${esc(status)}</span><button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="edit-project" data-project-id="${esc(project.id)}"><span data-i18n="open_project">Open project</span>${icon("arrow-right")}</button></div></div>
      </article>`;
    }).join("")}</div>`;
  }

  async function loadLibrary() {
    if (!state.user) return;
    const requestId = ++state.libraryRequestId;
    state.libraryLoading = true;
    const host = element("[data-vs-library-list]");
    host.innerHTML = `<div class="apsh-vs-skeleton" aria-label="Loading library" data-i18n-aria-label="loading_library"><i></i><i></i><i></i></div>`;
    element("[data-vs-library-error]").hidden = true;
    try {
      const params = new URLSearchParams();
      const search = String(element("[data-library-search]").value || "").trim();
      const category = String(element("[data-library-category]").value || "");
      const language = String(element("[data-library-language]").value || "");
      if (search) params.set("search", search);
      if (category) params.set("category", category);
      if (language) params.set("language", language);
      const query = params.toString();
      const result = await request(`/api/video-studio/library${query ? `?${query}` : ""}`);
      if (requestId !== state.libraryRequestId) return;
      state.library = listFrom(result, "videos").map((item) => ({ ...item }));
      state.libraryTotal = Number(result?.total ?? state.library.length);
      state.libraryLoaded = true;
      setLibraryCount();
      updateLibraryFilters();
      if (state.isOpen && state.view === "library") renderLibrary();
    } catch (error) {
      if (requestId !== state.libraryRequestId) return;
      state.libraryLoaded = false;
      if (state.isOpen && state.view === "library") {
        host.replaceChildren();
        displayError("[data-vs-library-error]", `Could not load the video library. ${error?.message || "Try again."}`, "refresh-library");
      }
      notifyUser(`Could not load the Video Studio library. ${error?.message || ""}`, "error");
    } finally {
      if (requestId === state.libraryRequestId) state.libraryLoading = false;
    }
  }

  function renderLibrary() {
    const host = element("[data-vs-library-list]");
    element("[data-vs-library-error]").hidden = true;
    const query = String(element("[data-library-search]").value || "").trim().toLowerCase();
    const category = element("[data-library-category]").value;
    const language = element("[data-library-language]").value;
    const results = state.library.filter((item) => {
      const label = `${item.title || item.name || ""} ${item.description || ""}`.toLowerCase();
      return (!query || label.includes(query)) &&
        (!category || String(item.category || "") === category) &&
        (!language || String(item.language || "") === language);
    });
    if (!results.length) {
      const filtered = Boolean(query || category || language);
      host.innerHTML = emptyMarkup("library_empty_title", filtered ? "No matching videos" : "Your library is ready", "library_empty_note", filtered ? "Try another search, category or language." : "Published videos and shared media will appear here.", filtered ? "" : `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="add-library-link">${icon("link")}<span data-i18n="add_video_link">Add video link</span></button>`);
      return;
    }
    host.innerHTML = `<div class="apsh-vs-library-grid">${results.map((item) => {
      const url = safeUrl(item.published_url || item.url || item.media_url || item.asset_url);
      const typeName = String(item.media_type || item.type || item.kind || "video").toLowerCase();
      const thumb = safeUrl(item.thumbnail_url || item.preview_url || (typeName === "image" ? url : ""));
      return `<article class="apsh-vs-library-card">
        ${typeName === "image" && url ? `<img class="apsh-vs-library-media" src="${esc(url)}" alt="${esc(item.title || item.name || "Video library image")}" loading="lazy">` : thumb ? `<button type="button" class="apsh-vs-library-open" data-action="play-library" data-library-id="${esc(item.id)}" aria-label="${esc(item.title || item.name || "Play video")}" data-i18n-aria-label="play_library_video"><img class="apsh-vs-library-media" src="${esc(thumb)}" alt=""></button>` : `<button type="button" class="apsh-vs-library-media" data-action="play-library" data-library-id="${esc(item.id)}" aria-label="${esc(item.title || item.name || "Play video")}" data-i18n-aria-label="play_library_video">${icon("play")}</button>`}
        <div class="apsh-vs-library-info"><strong>${esc(item.title || item.name || "Untitled video")}</strong><span>${esc(item.description || item.attribution || typeName)}${item.created_at ? ` · ${esc(fmtDate(item.created_at))}` : ""}</span>${typeName !== "image" && url ? `<button type="button" class="apsh-vs-btn apsh-vs-quiet apsh-vs-sm" data-action="play-library" data-library-id="${esc(item.id)}">${icon("play")}<span data-i18n="play_video">Play video</span></button>` : ""}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function updateLibraryFilters() {
    const categorySelect = element("[data-library-category]");
    const languageSelect = element("[data-library-language]");
    for (const item of state.library) {
      const category = String(item.category || "").trim();
      const language = String(item.language || "").trim();
      if (category) state.libraryCategories.add(category);
      if (language) state.libraryLanguages.add(language);
    }
    const categories = [...state.libraryCategories].sort();
    const languages = [...state.libraryLanguages].sort();
    const setOptions = (select, options, key, label) => {
      const current = select.value;
      select.innerHTML = `<option value="" data-i18n="${key}">${label}</option>${options.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
      if (options.includes(current)) select.value = current;
    };
    setOptions(categorySelect, categories, "all_categories", "All categories");
    setOptions(languageSelect, languages, "all_languages", "All languages");
  }

  async function refreshCounts() {
    if (!state.user) return { projects: 0, library: 0 };
    try {
      if (!state.libraryLoaded) {
        const result = await request("/api/video-studio/library");
        state.library = listFrom(result, "videos");
        state.libraryTotal = Number(result?.total ?? state.library.length);
        state.libraryLoaded = true;
      }
      setLibraryCount();
      return { projects: state.projects.length, library: state.libraryTotal };
    } catch (error) {
      return { projects: state.projects.length, library: state.library.length, error };
    }
  }

  function updateTeacherStats() {
    const count = document.querySelector("[data-vs-teacher-count]");
    if (!count) return;
    const drafts = state.projects.filter((project) => String(project.status || "draft") !== "published").length;
    const published = state.projects.filter((project) => String(project.status || "") === "published").length;
    const draftValue = count.querySelector("[data-vs-draft-count]");
    const publishedValue = count.querySelector("[data-vs-published-count]");
    if (draftValue) draftValue.textContent = String(drafts);
    if (publishedValue) publishedValue.textContent = String(published);
  }

  function setUser(user) {
    const previousUserId = String(state.user?.id || "");
    const nextUserId = String(user?.id || "");
    const previousRole = String(state.user?.role || "");
    const nextRole = String(user?.role || "");
    if (previousUserId && nextUserId && previousUserId !== nextUserId) {
      state.libraryRequestId += 1;
      clearTimeout(state.librarySearchTimer);
      cancelRender();
      state.project?.scenes?.forEach((scene) => { if (scene.local_audio_url) URL.revokeObjectURL(scene.local_audio_url); });
      state.project = null;
      state.view = "projects";
      state.projects = [];
      state.library = [];
      state.libraryTotal = 0;
      state.libraryLoaded = false;
      state.libraryCategories = new Set();
      state.libraryLanguages = new Set();
    }
    state.user = user || null;
    syncDashboardEntryPoints(state.user);
    const userName = state.user?.name || state.user?.full_name || state.user?.email || "";
    element("[data-vs-user]").textContent = userName;
    if (!state.user) {
      state.libraryRequestId += 1;
      clearTimeout(state.librarySearchTimer);
      cancelRender();
      state.project?.scenes?.forEach((scene) => { if (scene.local_audio_url) URL.revokeObjectURL(scene.local_audio_url); });
      state.project = null;
      state.view = "projects";
      state.projects = [];
      state.library = [];
      state.libraryTotal = 0;
      state.libraryLoaded = false;
      state.libraryCategories = new Set();
      state.libraryLanguages = new Set();
      setLibraryCount();
      updateTeacherStats();
      if (state.isOpen) setOpen(false);
      return;
    }
    if (state.isOpen && !canEdit()) setOpen(false);
    if (state.isOpen) setView(state.view === "library" ? "library" : "projects");
    else if (previousUserId !== nextUserId || previousRole !== nextRole) void loadProjects();
  }

  async function createProject() {
    if (!canEdit() || state.creatingProject) return;
    state.creatingProject = true;
    try {
      const result = await request("/api/video-studio/projects", { method: "POST", body: { title: "Untitled lesson", description: "", language: document.documentElement.lang || "en" } });
      const project = normalizeProject(result?.project || result);
      if (!project.id) throw new Error("The project response did not include an id.");
      state.projects = [project, ...state.projects.filter((item) => String(item.id) !== String(project.id))];
      updateTeacherStats();
      openProject(project);
      notifyUser("Video project created.", "success");
    } catch (error) {
      notifyUser(`Could not create the project. ${error?.message || "Try again."}`, "error");
      displayError("[data-vs-project-error]", `Could not create the project. ${error?.message || "Try again."}`, "refresh-projects");
    } finally { state.creatingProject = false; }
  }

  const canEdit = () => {
    const role = String(state.user?.role || "").toLowerCase();
    return role === "superadmin" ||
      (state.user?.sector === "education" && ["teacher", "school"].includes(role));
  };
  function openProject(project) {
    state.project?.scenes?.forEach((scene) => { if (scene.local_audio_url) URL.revokeObjectURL(scene.local_audio_url); });
    state.project = normalizeProject(project);
    if (!state.project.scenes.length) state.project.scenes = [sceneDefault()];
    state.selectedScene = 0;
    state.publishedUrl = state.project.published_url || "";
    setView("editor");
    renderEditor();
    void loadTtsVoices();
  }
  async function loadProject(id) {
    try {
      const result = await request(`/api/video-studio/projects/${encodeURIComponent(id)}`);
      openProject(normalizeProject(result?.project || result));
    } catch (error) {
      notifyUser(`Could not open the project. ${error?.message || "Try again."}`, "error");
    }
  }

  function renderSceneList() {
    const scenes = state.project?.scenes || [];
    element("[data-vs-scenes]").innerHTML = scenes.map((scene, index) => `<div class="apsh-vs-scene-item" draggable="true" data-scene-item="${index}" aria-current="${index === state.selectedScene ? "true" : "false"}">
      <button type="button" class="apsh-vs-scene-select" data-action="select-scene" data-scene-index="${index}"><span class="apsh-vs-scene-number">${String(index + 1).padStart(2, "0")}</span><span class="apsh-vs-scene-name">${esc(scene.title || "Untitled scene")}</span></button>
      <div class="apsh-vs-scene-tools"><button type="button" class="apsh-vs-icon-btn" data-action="move-scene-up" data-scene-index="${index}" aria-label="Move scene up" data-i18n-aria-label="move_scene_up" ${index === 0 ? "disabled" : ""}>${icon("arrow-up")}</button><button type="button" class="apsh-vs-icon-btn" data-action="move-scene-down" data-scene-index="${index}" aria-label="Move scene down" data-i18n-aria-label="move_scene_down" ${index === scenes.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button><button type="button" class="apsh-vs-icon-btn" data-action="remove-scene" data-scene-index="${index}" aria-label="Remove scene" data-i18n-aria-label="remove_scene" ${scenes.length < 2 ? "disabled" : ""}>${icon("trash")}</button></div>
    </div>`).join("");
  }

  function renderPreview() {
    const scene = currentScene();
    if (!scene) return;
    const preview = element("[data-vs-preview]");
    const context = preview.getContext("2d");
    if (!context) return;
    const url = safeUrl(scene.background_url);
    const key = `${scene.background_type}|${url}`;
    if (key !== state.previewKey) {
      stopPreview();
      state.previewKey = key;
      if (url && scene.background_type !== "solid") {
        state.previewSource = backgroundSource(scene);
        if (state.previewSource instanceof HTMLImageElement) {
          state.previewSource.addEventListener("load", () => {
            if (state.previewKey === key && currentScene() === scene) drawFrame(context, scene, state.previewSource);
          }, { once: true });
        }
      }
    }
    drawFrame(context, scene, state.previewSource);
    if (state.previewSource instanceof HTMLVideoElement && !state.previewFrame) {
      const tick = () => {
        if (!state.isOpen || state.view !== "editor" || state.previewSource?.paused) { state.previewFrame = 0; return; }
        drawFrame(context, currentScene(), state.previewSource);
        state.previewFrame = requestAnimationFrame(tick);
      };
      state.previewFrame = requestAnimationFrame(tick);
    }
    element("[data-vs-scene-index]").textContent = `${state.selectedScene + 1} / ${state.project.scenes.length}`;
    const creditUrl = safeUrl(scene.background_page_url);
    element("[data-vs-attribution]").innerHTML = scene.attribution
      ? `<span data-i18n="media_credit">Media credit</span>: ${creditUrl ? `<a href="${esc(creditUrl)}" target="_blank" rel="noopener noreferrer">${esc(scene.attribution)}</a>` : esc(scene.attribution)}`
      : "";
    element("[data-vs-color-field]").hidden = scene.background_type !== "solid";
    element("[data-vs-background-url-field]").hidden = scene.background_type === "solid";
  }

  function stopPreview() {
    if (state.previewFrame) cancelAnimationFrame(state.previewFrame);
    state.previewFrame = 0;
    if (state.previewSource instanceof HTMLVideoElement) {
      state.previewSource.pause();
      state.previewSource.src = "";
    }
    state.previewSource = null;
    state.previewKey = "";
  }

  function renderEditor() {
    if (!state.project) return;
    element("[data-project-title]").value = state.project.title || "";
    element("[data-project-description]").value = state.project.description || "";
    element("[data-vs-publish-status]").innerHTML = `<span data-i18n="${state.project.status === "published" ? "published" : "draft"}">${esc(state.project.status || "draft")}</span>`;
    element("[data-vs-publish-status]").classList.toggle("is-published", state.project.status === "published");
    element("[data-vs-published-url]").textContent = state.publishedUrl || "";
    renderSceneList();
    const scene = currentScene();
    if (!scene) return;
    root.querySelectorAll("[data-scene-field]").forEach((field) => {
      const key = field.dataset.sceneField;
      const value = scene[key];
      field.value = key === "background_url" && /^data:image\//iu.test(String(value || ""))
        ? ""
        : value ?? (key === "duration" ? 8 : "");
    });
    element("[data-voice-select]").value = scene.voice_name || "";
    element("[data-vs-audio-name]").textContent = scene.local_audio_file?.name || scene.voiceover_audio_name || "";
    element('[data-action="clear-audio"]').hidden = !(scene.local_audio_file || scene.voiceover_audio_base64);
    element("[data-action='open-pixabay']").hidden = state.pixabayUnavailable;
    element("[data-vs-pixabay]").hidden = state.pixabayUnavailable || !state.pixabayOpen;
    element("[data-vs-pixabay-fallback]").hidden = !state.pixabayUnavailable;
    element("[data-local-background-url]").value = /^data:image\//iu.test(scene.background_url || "") ? "" : scene.background_url || "";
    if (/^data:image\//iu.test(scene.background_url || "")) {
      setI18nText("[data-vs-local-image-name]", "image_attached", "Local image is attached to this scene.");
    } else {
      element("[data-vs-local-image-name]").textContent = "";
    }
    renderPreview();
    setStatus("[data-vs-editor-status]", "");
  }

  function audioMimeFromName(name = "") {
    const extension = String(name).split(".").pop()?.toLowerCase();
    return ({ mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", webm: "audio/webm", opus: "audio/ogg" })[extension] || "audio/mpeg";
  }

  function youtubeEmbedUrl(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.replace(/^www\./u, "").toLowerCase();
      let id = "";
      if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      else if (["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(host)) {
        id = parsed.searchParams.get("v") || parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/]+)/u)?.[1] || "";
      }
      return /^[\w-]{11}$/u.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : "";
    } catch { return ""; }
  }

  function updateField(input) {
    if (!state.project) return;
    if (input.hasAttribute("data-project-title")) {
      state.project.title = input.value;
      return;
    }
    if (input.hasAttribute("data-project-description")) {
      state.project.description = input.value;
      return;
    }
    const key = input.dataset.sceneField;
    const scene = currentScene();
    if (!scene || !key) return;
    let value = input.value;
    if (key === "duration") {
      value = Math.min(30, Math.max(3, Number(value || 3)));
      input.value = String(value);
    }
    scene[key] = value;
    if (key === "title") renderSceneList();
    if (["title", "body", "background_type", "background_color", "background_url"].includes(key)) renderPreview();
  }

  async function saveProject() {
    if (!state.project?.id || !canEdit() || state.savingProject) return false;
    state.savingProject = true;
    const button = element('[data-action="save-project"]');
    button.disabled = true;
    setStatus("[data-vs-editor-status]", "Saving draft…");
    try {
      await Promise.all(state.project.scenes.map((scene) => scene.audio_prepare_promise).filter(Boolean));
      const patch = {
        title: state.project.title,
        description: state.project.description || "",
        language: state.project.language || document.documentElement.lang || "en",
        scenes: state.project.scenes.map((scene) => ({
          ...(scene.id != null ? { id: scene.id } : {}),
          title: scene.title, body: scene.body, background_type: scene.background_type === "solid" ? "color" : scene.background_type,
          background_value: scene.background_type === "solid" ? scene.background_color : "",
          background_asset_url: scene.background_type === "solid" ? "" : safeUrl(scene.background_url),
          background_page_url: scene.background_page_url || "",
          background_user: scene.background_user || (scene.attribution ? scene.attribution.split(" / ")[0] : ""),
          background_tags: scene.background_tags || "",
          voiceover_text: scene.speech_text || "",
          voiceover_audio_base64: scene.voiceover_audio_base64 || "",
          voiceover_audio_name: scene.voiceover_audio_name || "",
          duration_seconds: scene.duration,
        })),
      };
      const response = await request(`/api/video-studio/projects/${encodeURIComponent(state.project.id)}`, { method: "PATCH", body: patch });
      const updated = normalizeProject(response?.project || response);
      if (updated.id) state.project = { ...state.project, ...updated, scenes: updated.scenes.length ? updated.scenes : state.project.scenes };
      state.projects = [state.project, ...state.projects.filter((item) => String(item.id) !== String(state.project.id))];
      updateTeacherStats();
      setStatus("[data-vs-editor-status]", "Draft saved.");
      notifyUser("Video project saved.", "success");
      return true;
    } catch (error) {
      setStatus("[data-vs-editor-status]", `Could not save draft. ${error?.message || "Try again."}`, true);
      notifyUser(`Could not save the video project. ${error?.message || ""}`, "error");
      return false;
    } finally { button.disabled = false; state.savingProject = false; }
  }

  async function deleteProject() {
    if (!state.project?.id || !canEdit()) return;
    showModal("Delete this project?", `<p data-i18n="delete_project_confirm">This permanently removes the project and its scenes. This action cannot be undone.</p>`, `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="cancel">Cancel</button><button type="button" class="apsh-vs-btn apsh-vs-danger" data-action="confirm-delete-project" data-i18n="delete_project">Delete project</button>`);
  }

  async function confirmDeleteProject() {
    const id = state.project?.id;
    if (!id) return;
    try {
      await request(`/api/video-studio/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.projects = state.projects.filter((item) => String(item.id) !== String(id));
      updateTeacherStats();
      state.project = null;
      closeModal();
      setView("projects");
      notifyUser("Project deleted.", "success");
    } catch (error) {
      closeModal();
      notifyUser(`Could not delete the project. ${error?.message || ""}`, "error");
      setStatus("[data-vs-editor-status]", `Could not delete project. ${error?.message || "Try again."}`, true);
    }
  }

  async function searchPixabay() {
    const query = String(element("[data-pixabay-query]").value || "").trim();
    const type = element("[data-pixabay-type]").value === "video" ? "video" : "image";
    const host = element("[data-vs-pixabay-results]");
    if (!query) {
      host.innerHTML = `<p data-i18n="pixabay_enter_query">Enter a search term to find free media.</p>`;
      return;
    }
    state.pixabayType = type;
    host.innerHTML = `<div class="apsh-vs-skeleton"><i></i><i></i></div>`;
    try {
      const result = await request(`/api/video-studio/pixabay/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`);
      if (result?.fallback === true && result?.error === "Pixabay not configured") {
        state.pixabayUnavailable = true;
        state.pixabayOpen = false;
        element("[data-vs-pixabay]").hidden = true;
        element("[data-action='open-pixabay']").hidden = true;
        element("[data-vs-pixabay-fallback]").hidden = false;
        return;
      }
      state.pixabayUnavailable = false;
      state.pixabayOpen = true;
      element("[data-vs-pixabay]").hidden = false;
      element("[data-action='open-pixabay']").hidden = false;
      element("[data-vs-pixabay-fallback]").hidden = true;
      state.pixabayResults = listFrom(result, "hits");
      renderPixabayResults();
    } catch (error) {
      host.innerHTML = `<div class="apsh-vs-error" role="alert">${esc(`Pixabay search failed. ${error?.message || "Try again."}`)}<button type="button" data-action="search-pixabay" data-i18n="retry">Retry</button></div>`;
      notifyUser(`Pixabay search failed. ${error?.message || ""}`, "error");
    }
  }

  function retryPixabay() {
    state.pixabayUnavailable = false;
    state.pixabayOpen = true;
    element("[data-vs-pixabay-fallback]").hidden = true;
    element("[data-action='open-pixabay']").hidden = false;
    element("[data-vs-pixabay]").hidden = false;
    const query = String(element("[data-pixabay-query]").value || "").trim();
    if (query) void searchPixabay();
    else element("[data-pixabay-query]").focus();
  }

  function useLocalImageUrl() {
    const url = safeHttpUrl(element("[data-local-background-url]").value);
    if (!url) {
      setI18nText("[data-vs-editor-status]", "image_url_invalid", "Enter a valid HTTP or HTTPS image URL.");
      element("[data-vs-editor-status]").dataset.kind = "error";
      return;
    }
    const scene = currentScene();
    if (!scene) return;
    scene.background_type = "image";
    scene.background_url = url;
    scene.attribution = "";
    scene.background_page_url = null;
    scene.background_user = "";
    scene.background_tags = "";
    scene.pixabay_id = "";
    renderEditor();
  }

  async function useLocalImageFile(input) {
    const file = input.files?.[0];
    const project = state.project;
    const scene = currentScene();
    if (!file || !project || !scene) return;
    const extension = String(file.name || "").split(".").pop()?.toLowerCase();
    const extensionMime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" })[extension];
    const declaredMime = ({ "image/png": "image/png", "image/jpeg": "image/jpeg", "image/webp": "image/webp" })[file.type];
    const mime = declaredMime || extensionMime;
    const unsupportedDeclaredType = Boolean(file.type && file.type !== "application/octet-stream" && !declaredMime);
    const mismatch = Boolean(declaredMime && extensionMime && declaredMime !== extensionMime);
    if (!mime || unsupportedDeclaredType || mismatch || file.size > 300 * 1024) {
      input.value = "";
      setI18nText("[data-vs-editor-status]", "image_file_invalid", "Choose a PNG, JPEG, or WebP image no larger than 300 KB.");
      element("[data-vs-editor-status]").dataset.kind = "error";
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      if (state.project !== project || !project.scenes.includes(scene)) return;
      scene.background_type = "image";
      scene.background_url = `data:${mime};base64,${btoa(binary)}`;
      scene.attribution = "";
      scene.background_page_url = null;
      scene.background_user = "";
      scene.background_tags = "";
      scene.pixabay_id = "";
      renderEditor();
      input.value = "";
    } catch {
      input.value = "";
      setI18nText("[data-vs-editor-status]", "image_file_read_failed", "The selected image could not be read. Choose another image.");
      element("[data-vs-editor-status]").dataset.kind = "error";
    }
  }

  function renderPixabayResults() {
    const host = element("[data-vs-pixabay-results]");
    if (!state.pixabayResults.length) {
      host.innerHTML = `<p data-i18n="pixabay_no_results">No media found. Try a different search.</p>`;
      return;
    }
    host.innerHTML = state.pixabayResults.map((asset, index) => {
      const imageUrl = safeUrl(asset.asset_url || asset.webformatURL || asset.previewURL || asset.largeImageURL || asset.url);
      const thumb = safeUrl(asset.preview_url || asset.previewURL || imageUrl);
      if (!imageUrl) return "";
      return `<button class="apsh-vs-pixabay-option" type="button" data-action="select-pixabay" data-asset-index="${index}" aria-label="Choose Pixabay media by ${esc(asset.user || asset.author || "Pixabay contributor")}" data-i18n-aria-label="choose_pixabay_asset">
        ${state.pixabayType === "video" ? `<video src="${esc(thumb || imageUrl)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(thumb || imageUrl)}" alt="" loading="lazy">`}
        <span>${esc(asset.user || asset.author || "Pixabay")} · Pixabay</span>
      </button>`;
    }).join("") || `<p data-i18n="pixabay_no_results">No media found. Try a different search.</p>`;
  }

  function choosePixabay(index) {
    const asset = state.pixabayResults[index];
    if (!asset || !currentScene()) return;
    const scene = currentScene();
    const isVideo = state.pixabayType === "video";
    const url = safeUrl(asset.asset_url || asset.webformatURL || asset.previewURL || asset.largeImageURL || asset.url);
    if (!url) return;
    scene.background_type = isVideo ? "video" : "image";
    scene.background_url = url;
    scene.attribution = `${asset.user || asset.author || "Pixabay contributor"} / Pixabay`;
    scene.pixabay_id = asset.id ?? asset.video_id ?? "";
    scene.background_page_url = asset.page_url || "";
    scene.background_user = asset.user || asset.author || "Pixabay contributor";
    scene.background_tags = asset.tags || "";
    state.pixabayOpen = false;
    renderEditor();
    element("[data-vs-pixabay]").hidden = true;
  }

  async function addLibraryLink() {
    if (!canEdit()) return;
    showModal("Add a video link", `<div class="apsh-vs-field"><label for="vs-library-link-title" data-i18n="video_title">Video title</label><input id="vs-library-link-title" maxlength="180"></div><div class="apsh-vs-field"><label for="vs-library-link-url" data-i18n="video_url">Video URL</label><input id="vs-library-link-url" type="url"></div><div class="apsh-vs-field"><label for="vs-library-link-category" data-i18n="category">Category</label><input id="vs-library-link-category" maxlength="80" placeholder="lesson"></div><div class="apsh-vs-field"><label for="vs-library-link-language" data-i18n="language">Language</label><select id="vs-library-link-language"><option value="en">English</option><option value="lg-UG">Luganda</option><option value="xog-UG">Lusoga</option><option value="nyn-UG">Runyankole</option><option value="nyo-UG">Runyoro</option><option value="ach-UG">Acholi</option><option value="sw-UG">Swahili</option></select></div><p data-i18n="library_link_note">Save a link to an online lesson video. Video files are not uploaded to APSHULE.</p>`, `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="cancel">Cancel</button><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="save-library-link" data-i18n="save_link">Save link</button>`);
  }

  async function saveLibraryLink() {
    const title = String(element("#vs-library-link-title")?.value || "").trim();
    const published_url = safeHttpUrl(element("#vs-library-link-url")?.value || "");
    if (!title || !published_url) {
      const note = modalContent.querySelector("p");
      if (note) { note.innerHTML = `<span data-i18n="library_link_invalid">Enter a video title and a valid HTTP or HTTPS URL.</span>`; note.dataset.kind = "error"; }
      return;
    }
    const button = element('[data-action="save-library-link"]');
    button.disabled = true;
    try {
      await request("/api/video-studio/library", {
        method: "POST",
        body: {
          title,
          url: published_url,
          category: String(element("#vs-library-link-category")?.value || "").trim() || "lesson",
          language: element("#vs-library-link-language")?.value || "en",
        },
      });
      state.libraryLoaded = false;
      closeModal();
      notifyUser("Video link added to your library.", "success");
      if (state.view === "library") void loadLibrary();
      void refreshCounts();
    } catch (error) {
      const note = modalContent.querySelector("p");
      if (note) { note.innerHTML = `<span data-i18n="could_not_save_video_link">Could not save the link.</span> ${esc(error?.message || "Try again.")}`; note.dataset.kind = "error"; }
      notifyUser(`Could not add the video link. ${error?.message || ""}`, "error");
      button.disabled = false;
    }
  }

  async function playLibraryItem(id) {
    const item = state.library.find((entry) => String(entry.id) === String(id));
    const url = safeUrl(item?.published_url || item?.url || item?.media_url || item?.asset_url);
    if (!item || !url) {
      notifyUser("This library item does not have a playable link.", "error");
      return;
    }
    const embed = youtubeEmbedUrl(url);
    const media = embed
      ? `<iframe title="${esc(item.title || item.name || "Video")}" src="${esc(embed)}" style="display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:9px;background:#193d3b" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen></iframe>`
      : `<video controls playsinline style="display:block;width:100%;max-height:58vh;background:#193d3b;border-radius:9px" src="${esc(url)}"></video>`;
    showModal(item.title || item.name || "Video", `${media}<p data-i18n="video_player_note">Playback opens here. External videos may open in their own player.</p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-i18n="open_video_new_tab">Open video in a new tab</a>`, `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="close">Close</button>`);
    try { await request(`/api/video-studio/library/${encodeURIComponent(id)}/view`, { method: "POST" }); }
    catch (error) { notifyUser(`Playback started, but the view could not be recorded. ${error?.message || ""}`, "error"); }
  }

  async function loadTtsVoices() {
    if (state.ttsVoicesLoaded) return;
    try {
      const result = await request("/api/video-studio/tts-voices");
      state.ttsVoices = listFrom(result, "voices");
      state.ttsVoicesLoaded = true;
    } catch {
      state.ttsVoices = [];
      notifyUser("Narration voices could not be loaded. Browser default remains available.", "error");
    }
    const select = element("[data-voice-select]");
    if (select) {
      const selected = currentScene()?.voice_name || "";
      select.innerHTML = `<option value="" data-i18n="browser_default_voice">Browser default</option>${state.ttsVoices.map((voice) => `<option value="${esc(voice.name)}">${esc(voice.name)}${voice.lang ? ` · ${esc(voice.lang)}` : ""}</option>`).join("")}`;
      select.value = selected;
    }
  }

  function publishPrompt() {
    const initial = state.publishedUrl || "";
    showModal("Confirm YouTube publishing", `<p data-i18n="youtube_manual_steps">APSHULE does not upload to YouTube. Download the WebM, upload it in YouTube Studio, then paste the resulting URL below.</p><div class="apsh-vs-field"><label for="vs-published-url" data-i18n="youtube_video_url">YouTube video URL</label><input id="vs-published-url" type="url" value="${esc(initial)}"></div>`, `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="cancel">Cancel</button><button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="confirm-published" data-i18n="mark_published">Mark published</button>`);
  }

  async function pastePublishedUrl() {
    try {
      const clipboardValue = await navigator.clipboard?.readText?.();
      if (safeHttpUrl(clipboardValue)) state.publishedUrl = safeHttpUrl(clipboardValue);
    } catch {}
    publishPrompt();
  }

  async function markPublished() {
    if (!state.project?.id) return;
    const url = safeHttpUrl(element("#vs-published-url")?.value || "");
    if (!url || !youtubeEmbedUrl(url)) {
      const field = modalContent.querySelector(".apsh-vs-field");
      if (field) field.insertAdjacentHTML("beforeend", `<small class="apsh-vs-status" data-kind="error" data-i18n="valid_video_url">Enter a valid YouTube video URL.</small>`);
      return;
    }
    if (!await saveProject()) return;
    try {
      const result = await request(`/api/video-studio/projects/${encodeURIComponent(state.project.id)}/publish`, { method: "POST", body: { published_url: url } });
      state.publishedUrl = url;
      state.project = { ...state.project, ...(result?.project || result), status: "published", published_url: url };
      state.projects = [state.project, ...state.projects.filter((item) => String(item.id) !== String(state.project.id))];
      updateTeacherStats();
      if (result?.video) {
        state.library = [result.video, ...state.library.filter((video) => String(video.id) !== String(result.video.id))];
        state.libraryTotal += 1;
        state.libraryLoaded = false;
      }
      element("[data-vs-published-url]").textContent = url;
      element("[data-vs-publish-status]").innerHTML = `<span data-i18n="published">published</span>`;
      element("[data-vs-publish-status]").classList.add("is-published");
      closeModal();
      void refreshCounts();
      notifyUser("Project marked as published.", "success");
    } catch (error) {
      const field = modalContent.querySelector(".apsh-vs-field");
      if (field) field.insertAdjacentHTML("beforeend", `<small class="apsh-vs-status" data-kind="error">${esc(`Could not mark published. ${error?.message || "Try again."}`)}</small>`);
      notifyUser(`Could not update publishing status. ${error?.message || ""}`, "error");
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function drawingText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || "").split(/\s+/u);
    let line = "";
    let lines = 0;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        ctx.fillText(line, x, y + lines * lineHeight, maxWidth);
        lines += 1;
        line = word;
        if (lines >= maxLines - 1) break;
      } else line = candidate;
    }
    const rest = lines >= maxLines - 1 && words.length ? `${line}…` : line;
    if (rest) ctx.fillText(rest, x, y + lines * lineHeight, maxWidth);
  }
  function backgroundSource(scene) {
    const url = safeUrl(scene.background_url);
    if (!url || scene.background_type === "solid") return null;
    if (scene.background_type === "video") {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;
      void video.play().catch(() => {});
      return video;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    return img;
  }
  function drawFrame(ctx, scene, source) {
    const canvas = ctx.canvas;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = scene.background_color || "#17675f";
    ctx.fillRect(0, 0, w, h);
    if (source && ((source instanceof HTMLImageElement && source.complete && source.naturalWidth) || (source instanceof HTMLVideoElement && source.readyState >= 2))) {
      try {
        const sw = source.videoWidth || source.naturalWidth;
        const sh = source.videoHeight || source.naturalHeight;
        const scale = Math.max(w / sw, h / sh);
        const dw = sw * scale, dh = sh * scale;
        ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } catch {}
    }
    const gradient = ctx.createLinearGradient(0, h * .35, 0, h);
    gradient.addColorStop(0, "rgba(11,27,25,.04)");
    gradient.addColorStop(1, "rgba(11,27,25,.82)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "left";
    ctx.fillStyle = "#fffefa";
    ctx.shadowColor = "rgba(0,0,0,.3)";
    ctx.shadowBlur = 14;
    ctx.font = "700 48px Manrope, system-ui, sans-serif";
    drawingText(ctx, scene.title || "", 76, h - 220, w - 152, 58, 2);
    ctx.font = "400 27px 'DM Sans', system-ui, sans-serif";
    drawingText(ctx, scene.body || "", 78, h - 105, w - 156, 38, 3);
    ctx.shadowBlur = 0;
  }

  async function renderPermissionModal() {
    if (state.renderController) return;
    if (!globalThis.MediaRecorder || !document.createElement("canvas").captureStream) {
      showModal(
        "WebM export unavailable",
        `<p data-i18n="webm_unsupported">This browser cannot render WebM locally. Upload the project video to YouTube manually instead.</p><a class="apsh-vs-btn apsh-vs-primary" href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer" data-i18n="open_youtube_studio">Open YouTube Studio</a>`,
        `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="close">Close</button>`,
      );
      return;
    }
    if (!await saveProject()) return;
    const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const intro = supported
      ? `<p data-i18n="render_modal_body">To include the AI voiceover in your video, we need permission to capture this tab's audio.</p>`
      : ios
        ? `<p data-i18n="ios_fallback_message">Your browser can't record voiceover directly. Record audio on your phone and upload it, or render a silent video and add narration in YouTube Studio.</p>`
        : `<p data-i18n="capture_unsupported_message">This browser can't capture tab audio. Render a silent video, then upload audio or add narration in YouTube Studio.</p>`;
    const fallbackMessage = supported
      ? `<p data-i18n="render_audio_permission">Choose this tab and enable tab audio sharing when your browser asks. You can also render without voiceover.</p>`
      : `<p data-i18n="render_silent_option">Or keep the silent video and add narration in YouTube Studio after upload.</p>`;
    const silentOption = supported
      ? `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="begin-render" data-render-silent="true" data-silent-mode="true" data-i18n="render_without_voiceover">Render without voiceover</button>`
      : "";
    showModal(
      "Include your voiceover?",
      `${intro}<p data-i18n="voiceover_optional">Voiceover is optional.</p>${fallbackMessage}<p data-i18n="render_privacy_note">The WebM is rendered locally and is not uploaded to APSHULE.</p>`,
      `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="cancel">Cancel</button>${silentOption}<button type="button" class="apsh-vs-btn apsh-vs-primary" data-action="begin-render" data-render-silent="${supported ? "false" : "true"}"><span data-i18n="${supported ? "start_render" : "render_without_voiceover"}">${supported ? "Start Render with Voiceover" : "Render without voiceover"}</span></button>`,
    );
  }

  function validAudioFile(file, maxBytes = 5 * 1024 * 1024) {
    if (!file || file.size > maxBytes) return false;
    const extension = String(file.name || "").split(".").pop()?.toLowerCase();
    return ["mp3", "wav", "m4a"].includes(extension || "");
  }

  function showAudioFallbackModal() {
    showModal(
      "Add narration audio",
      `<p data-i18n="audio_fallback_body">Rendered without voiceover. Upload an MP3, WAV, or M4A file up to 5 MB to render again with narration.</p><label class="apsh-vs-btn apsh-vs-primary apsh-vs-file-picker" for="vs-render-fallback-audio" data-i18n="choose_audio_file">Choose Audio File</label><input id="vs-render-fallback-audio" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" data-fallback-audio><p data-i18n="render_silent_option">Or keep the silent video and add narration in YouTube Studio after upload.</p>`,
      `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="render-without-voiceover" data-i18n="render_without_voiceover">Continue without voiceover</button><button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="close">Close</button>`,
    );
  }

  async function beginRender(options = {}) {
    closeModal();
    const project = state.project;
    if (!project?.scenes?.length) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.captureStream || !globalThis.MediaRecorder) {
      showModal("WebM export unavailable", `<p data-i18n="webm_unsupported">This browser cannot create a local WebM recording. Try an up-to-date desktop version of Chrome, Edge or Firefox.</p>`, `<button type="button" class="apsh-vs-btn apsh-vs-quiet" data-action="close-modal" data-i18n="close">Close</button>`);
      return;
    }
    const fallbackAudioFile = options.fallbackAudioFile || null;
    const explicitSilent = Boolean(options.silent);
    const skipTabCapture = Boolean(options.skipTabCapture || fallbackAudioFile || explicitSilent);
    const controller = { cancelled: false, recorder: null, stream: null, displayStream: null, speech: false };
    state.renderController = controller;
    const progressWrap = element("[data-vs-progress-wrap]");
    progressWrap.hidden = false;
    element('[data-action="cancel-render"]').hidden = false;
    element("[data-vs-progress]").value = 0;
    element("[data-vs-progress-label]").textContent = "0%";
    element("[data-vs-render-status]").replaceChildren();
    const scenes = project.scenes.map(normalizeScene);
    const totalMs = scenes.reduce((sum, scene) => sum + Number(scene.duration) * 1000, 0);
    const hasSceneAudio = !explicitSilent && scenes.some((scene) => scene.local_audio_file || scene.voiceover_audio_base64);
    const hasSpeechText = !explicitSilent && scenes.some((scene) => String(scene.speech_text || "").trim());
    const hasSpeechWithoutUpload = !explicitSilent && scenes.some((scene) =>
      String(scene.speech_text || "").trim() && !scene.local_audio_file && !scene.voiceover_audio_base64
    );
    const hasBrowserSpeech = Boolean(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
    let displayStream = null;
    let silentFallback = !fallbackAudioFile && hasSpeechWithoutUpload && !hasBrowserSpeech;
    let voiceoverFailure = false;
    if (!skipTabCapture && navigator.mediaDevices?.getDisplayMedia) {
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        controller.displayStream = displayStream;
      } catch {
        silentFallback = !fallbackAudioFile && !hasSceneAudio && hasSpeechText;
        setI18nText("[data-vs-render-status]", "tab_capture_cancelled", "Tab capture was not shared. Continuing without captured audio.");
      }
    } else if (!fallbackAudioFile && hasSpeechWithoutUpload) {
      silentFallback = true;
    }
    if (
      !fallbackAudioFile &&
      hasSpeechWithoutUpload &&
      displayStream &&
      !displayStream.getAudioTracks().length
    ) {
      silentFallback = true;
    }
    if (controller.cancelled) {
      setI18nText("[data-vs-render-status]", "render_cancelled", "Render cancelled.");
      return finishRender(controller);
    }
    const stream = canvas.captureStream(30);
    displayStream?.getAudioTracks?.().forEach((track) => stream.addTrack(track));
    let audioContext = null;
    let audioDestination = null;
    if (fallbackAudioFile || hasSceneAudio) {
      try {
        audioContext = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
        audioDestination = audioContext.createMediaStreamDestination();
        audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
        await audioContext.resume();
      } catch {
        audioContext = null;
        audioDestination = null;
        silentFallback = true;
        voiceoverFailure = true;
        setI18nText("[data-vs-render-status]", "uploaded_audio_unavailable", "Audio could not start. Rendering silently.");
      }
    }
    controller.stream = stream;
    const chunks = [];
    let recorder;
    try {
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported?.(candidate));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      controller.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder.start(300);
    } catch (error) {
      setI18nText("[data-vs-render-status]", "render_failed", "The video could not be rendered.", error?.message || "");
      if (audioContext) void audioContext.close();
      finishRender(controller);
      return;
    }
    let elapsed = 0;
    let speechStarted = false;
    let narrationFailed = false;
    displayStream?.getAudioTracks?.().forEach((track) => track.addEventListener("ended", () => {
      narrationFailed = true;
      silentFallback = true;
      voiceoverFailure = true;
      setI18nText("[data-vs-render-status]", "tab_audio_ended", "Captured tab audio ended. Remaining scenes will render without browser narration.");
    }, { once: true }));
    let fallbackAudio = null;
    let fallbackAudioUrl = "";
    if (fallbackAudioFile) {
      try {
        if (!audioContext || !audioDestination) throw new Error("Audio playback is unavailable.");
        fallbackAudioUrl = URL.createObjectURL(fallbackAudioFile);
        fallbackAudio = new Audio(fallbackAudioUrl);
        fallbackAudio.preload = "auto";
        audioContext.createMediaElementSource(fallbackAudio).connect(audioDestination);
        await fallbackAudio.play();
      } catch {
        silentFallback = true;
        voiceoverFailure = true;
        setI18nText("[data-vs-render-status]", "uploaded_audio_playback_failed", "Uploaded audio could not play. Continuing silently.");
      }
    }
    const playNativeSpeech = (scene) => {
      const text = String(scene.speech_text || "").trim();
      const hasLiveTabAudio = displayStream?.getAudioTracks?.().some((track) => track.readyState === "live");
      if (!text || narrationFailed || !hasLiveTabAudio || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
      try {
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        const languageVoice = state.ttsVoices.find((voice) => voice.name === scene.voice_name)
          || state.ttsVoices.find((voice) => voice.lang && String(voice.lang).toLowerCase().startsWith((document.documentElement.lang || "en").toLowerCase()));
        if (languageVoice) {
          const found = speechSynthesis.getVoices().find((voice) => voice.name === languageVoice.name || voice.lang === languageVoice.lang);
          if (found) utterance.voice = found;
        }
        utterance.onerror = () => { narrationFailed = true; silentFallback = true; voiceoverFailure = true; setI18nText("[data-vs-render-status]", "narration_unavailable", "Narration was unavailable. The remaining scenes will render silently."); };
        utterance.onstart = () => { speechStarted = true; };
        speechSynthesis.speak(utterance);
      } catch {
        narrationFailed = true;
        silentFallback = true;
        voiceoverFailure = true;
        setI18nText("[data-vs-render-status]", "narration_unavailable", "Narration was unavailable. The remaining scenes will render silently.");
      }
    };
    try {
      for (const scene of scenes) {
        if (controller.cancelled) break;
        const source = backgroundSource(scene);
        const sceneStart = performance.now();
        let uploadElement = null;
        const storedAudio = scene.voiceover_audio_base64 || "";
        const audioDataUrl = scene.local_audio_url || (storedAudio
          ? (storedAudio.startsWith("data:") ? storedAudio : `data:${audioMimeFromName(scene.voiceover_audio_name)};base64,${storedAudio}`)
          : "");
        if (audioDataUrl && audioContext && audioDestination) {
          try {
            uploadElement = new Audio(audioDataUrl);
            uploadElement.loop = false;
            const sourceNode = audioContext.createMediaElementSource(uploadElement);
            sourceNode.connect(audioDestination);
            await uploadElement.play();
          } catch {
            uploadElement = null;
            silentFallback = true;
            voiceoverFailure = true;
            setI18nText("[data-vs-render-status]", "uploaded_audio_playback_failed", "Uploaded audio could not play. Continuing with browser narration or silence.");
          }
        }
        if (!uploadElement && !fallbackAudioFile) playNativeSpeech(scene);
        const sceneMs = Number(scene.duration) * 1000;
        while (!controller.cancelled && performance.now() - sceneStart < sceneMs) {
          drawFrame(ctx, scene, source);
          const local = Math.min(sceneMs, performance.now() - sceneStart);
          const percent = Math.min(99, Math.floor((elapsed + local) / totalMs * 100));
          element("[data-vs-progress]").value = percent;
          element("[data-vs-progress-label]").textContent = `${percent}%`;
          await wait(80);
        }
        elapsed += sceneMs;
        if (uploadElement) { uploadElement.pause(); uploadElement.src = ""; }
        if (source instanceof HTMLVideoElement) { source.pause(); source.src = ""; }
        if (globalThis.speechSynthesis) speechSynthesis.cancel();
      }
      if (!controller.cancelled) {
        drawFrame(ctx, scenes.at(-1), null);
        await wait(250);
      }
    } catch (error) {
      setI18nText("[data-vs-render-status]", "render_paused", "Render paused.", error?.message || "The video will be saved with any available audio.");
    }
    if (fallbackAudio) {
      fallbackAudio.pause();
      fallbackAudio.src = "";
    }
    if (fallbackAudioUrl) URL.revokeObjectURL(fallbackAudioUrl);
    if (hasSpeechWithoutUpload && !fallbackAudioFile && !speechStarted) silentFallback = true;
    if (audioContext) void audioContext.close().catch(() => {});
    if (globalThis.speechSynthesis) speechSynthesis.cancel();
    await new Promise((resolve) => {
      if (recorder.state === "inactive") return resolve();
      recorder.addEventListener("stop", resolve, { once: true });
      try { recorder.stop(); } catch { resolve(); }
    });
    let renderedSuccessfully = false;
    if (!controller.cancelled && chunks.length) {
      renderedSuccessfully = true;
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${(project.title || "apshule-lesson").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "apshule-lesson"}.webm`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      element("[data-vs-progress]").value = 100;
      element("[data-vs-progress-label]").textContent = "100%";
      setI18nText("[data-vs-render-status]", "render_complete", "Rendered video is ready. It was downloaded to this device.");
      notifyUser("Video rendered and downloaded to this device.", "success");
    } else if (controller.cancelled) {
      setI18nText("[data-vs-render-status]", "render_cancelled", "Render cancelled.");
    } else {
      setI18nText("[data-vs-render-status]", "render_failed", "The video could not be rendered.");
    }
    if (speechStarted && displayStream && !displayStream.getAudioTracks().length) element("[data-vs-render-status]").insertAdjacentHTML("beforeend", ` <span data-i18n="browser_narration_capture_note">Browser narration may not be captured unless tab audio sharing is enabled.</span>`);
    finishRender(controller);
    if (renderedSuccessfully && silentFallback && !fallbackAudioFile) {
      if (voiceoverFailure) {
        notifyUser("Voiceover failed during rendering. The video finished; upload an audio file to try again.", "warning");
      } else {
        notifyUser("Rendered without voiceover. You can add narration on YouTube after upload.", "info");
      }
      showAudioFallbackModal();
    } else if (renderedSuccessfully && voiceoverFailure) {
      notifyUser("Voiceover failed during rendering. The video finished without the uploaded narration.", "warning");
    }
  }

  function finishRender(controller) {
    element('[data-action="cancel-render"]').hidden = true;
    controller?.stream?.getTracks?.().forEach((track) => track.stop());
    controller?.displayStream?.getTracks?.().forEach((track) => track.stop());
    if (controller?.recorder?.state && controller.recorder.state !== "inactive") {
      try { controller.recorder.stop(); } catch {}
    }
    if (state.renderController === controller) state.renderController = null;
  }

  function cancelRender() {
    if (!state.renderController) return;
    state.renderController.cancelled = true;
    if (globalThis.speechSynthesis) speechSynthesis.cancel();
  }

  function previewVoice() {
    const scene = currentScene();
    const text = String(scene?.speech_text || "").trim();
    if (!text) {
      notifyUser("Add narration text before generating a voice preview.", "info");
      return;
    }
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
      notifyUser("Browser speech is unavailable. Upload an MP3, WAV, or M4A narration file instead.", "warning");
      return;
    }
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const languageVoice = state.ttsVoices.find((voice) => voice.name === scene.voice_name)
        || state.ttsVoices.find((voice) =>
          voice.lang && String(voice.lang).toLowerCase().startsWith((document.documentElement.lang || "en").toLowerCase())
        );
      if (languageVoice) {
        const availableVoice = speechSynthesis.getVoices().find((voice) =>
          voice.name === languageVoice.name || voice.lang === languageVoice.lang
        );
        if (availableVoice) utterance.voice = availableVoice;
      }
      utterance.onerror = () => notifyUser("Browser speech could not generate the voice preview.", "warning");
      speechSynthesis.speak(utterance);
    } catch (error) {
      notifyUser(`Browser speech could not start. ${error?.message || ""}`, "warning");
    }
  }

  function setScene(index) {
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= state.project.scenes.length) return;
    state.selectedScene = next;
    renderEditor();
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || !root.contains(button)) return;
    const action = button.dataset.action;
    if (action === "close") setOpen(false);
    else if (action === "show-projects") setView("projects");
    else if (action === "show-library") setView("library");
    else if (action === "new-project") void createProject();
    else if (action === "refresh-projects") void loadProjects();
    else if (action === "refresh-library") { state.libraryLoaded = false; void loadLibrary(); }
    else if (action === "back-projects") { state.project = null; setView("projects"); }
    else if (action === "edit-project") void loadProject(button.dataset.projectId);
    else if (action === "save-project") void saveProject();
    else if (action === "delete-project") void deleteProject();
    else if (action === "confirm-delete-project") void confirmDeleteProject();
    else if (action === "close-modal") closeModal();
    else if (action === "select-scene") setScene(button.dataset.sceneIndex);
    else if (action === "add-scene") {
      state.project.scenes.push(sceneDefault());
      setScene(state.project.scenes.length - 1);
    } else if (action === "move-scene-up" || action === "move-scene-down") {
      const index = Number(button.dataset.sceneIndex), to = index + (action === "move-scene-up" ? -1 : 1);
      if (to >= 0 && to < state.project.scenes.length) {
        [state.project.scenes[index], state.project.scenes[to]] = [state.project.scenes[to], state.project.scenes[index]];
        setScene(to);
      }
    } else if (action === "remove-scene") {
      if (state.project.scenes.length > 1) {
        state.project.scenes.splice(Number(button.dataset.sceneIndex), 1);
        setScene(Math.min(state.selectedScene, state.project.scenes.length - 1));
      }
    } else if (action === "open-pixabay") {
      state.pixabayOpen = !state.pixabayOpen;
      element("[data-vs-pixabay]").hidden = !state.pixabayOpen;
      if (state.pixabayOpen) element("[data-pixabay-query]").focus();
    } else if (action === "search-pixabay") void searchPixabay();
    else if (action === "retry-pixabay") retryPixabay();
    else if (action === "use-local-image-url") useLocalImageUrl();
    else if (action === "select-pixabay") choosePixabay(button.dataset.assetIndex);
    else if (action === "clear-background") {
      const scene = currentScene();
      if (scene) { scene.background_url = ""; scene.background_type = "solid"; scene.attribution = ""; scene.pixabay_id = ""; renderEditor(); }
    } else if (action === "clear-audio") {
      const scene = currentScene();
      if (scene) {
        if (scene.local_audio_url) URL.revokeObjectURL(scene.local_audio_url);
        scene.local_audio_url = "";
        scene.local_audio_file = null;
        scene.voiceover_audio_base64 = "";
        scene.voiceover_audio_name = "";
        scene.audio_prepare_promise = Promise.resolve();
      }
      element("[data-audio-file]").value = "";
      renderEditor();
    } else if (action === "add-library-link") void addLibraryLink();
    else if (action === "save-library-link") void saveLibraryLink();
    else if (action === "play-library") void playLibraryItem(button.dataset.libraryId);
    else if (action === "paste-published-url") void pastePublishedUrl();
    else if (action === "mark-published") publishPrompt();
    else if (action === "confirm-published") void markPublished();
    else if (action === "open-render") void renderPermissionModal();
    else if (action === "begin-render") void beginRender({ skipTabCapture: button.dataset.renderSilent === "true", silent: button.dataset.silentMode === "true" });
    else if (action === "render-without-voiceover") closeModal();
    else if (action === "preview-voice") previewVoice();
    else if (action === "cancel-render") cancelRender();
  }

  function onInput(event) {
    const target = event.target;
    if (target.matches("[data-project-title],[data-project-description],[data-scene-field]")) {
      updateField(target);
      return;
    }
    if (target.matches("[data-library-search]")) {
      renderLibrary();
      clearTimeout(state.librarySearchTimer);
      state.librarySearchTimer = setTimeout(() => void loadLibrary(), 300);
    }
  }
  function onChange(event) {
    const target = event.target;
    if (target.matches("[data-scene-field]")) updateField(target);
    else if (target.matches("[data-voice-select]")) {
      const scene = currentScene();
      if (scene) scene.voice_name = target.value;
    }
    else if (target.matches("[data-library-category],[data-library-language]")) void loadLibrary();
    else if (target.matches("[data-fallback-audio]")) {
      const file = target.files?.[0];
      if (!file) return;
      if (!validAudioFile(file)) {
        target.value = "";
        notifyUser("Choose an MP3, WAV, or M4A file no larger than 5 MB.", "error");
        return;
      }
      void beginRender({ skipTabCapture: true, fallbackAudioFile: file });
    }
    else if (target.matches("[data-audio-file]")) {
      const file = target.files?.[0];
      if (!file) return;
      if (!validAudioFile(file, 1 * 1024 * 1024)) {
        target.value = "";
        notifyUser("Choose an MP3, WAV, or M4A file no larger than 1 MB.", "error");
        setI18nText("[data-vs-audio-name]", "audio_file_invalid", "Choose an MP3, WAV, or M4A file up to 1 MB.");
        return;
      }
      const scene = currentScene();
      if (!scene) return;
      if (scene.local_audio_url) URL.revokeObjectURL(scene.local_audio_url);
      scene.local_audio_file = file;
      scene.local_audio_url = URL.createObjectURL(file);
      scene.voiceover_audio_name = file.name;
      element("[data-vs-audio-name]").textContent = file.name;
      element('[data-action="clear-audio"]').hidden = false;
      scene.audio_prepare_promise = file.arrayBuffer().then((buffer) => {
        if (scene.local_audio_file !== file) return;
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        scene.voiceover_audio_base64 = btoa(binary);
      }).catch(() => notifyUser("Audio was selected, but could not be prepared for saving.", "error"));
    } else if (target.matches("[data-local-background-file]")) {
      void useLocalImageFile(target);
    } else if (target.matches("[data-pixabay-type]")) state.pixabayType = target.value;
  }

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("dragstart", (event) => {
    const item = event.target instanceof Element ? event.target.closest("[data-scene-item]") : null;
    if (!item || !state.project) return;
    state.draggingSceneIndex = Number(item.dataset.sceneItem);
    item.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(state.draggingSceneIndex));
    }
  });
  root.addEventListener("dragover", (event) => {
    const item = event.target instanceof Element ? event.target.closest("[data-scene-item]") : null;
    if (!item) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", (event) => {
    const item = event.target instanceof Element ? event.target.closest("[data-scene-item]") : null;
    if (!item || !state.project || !Number.isInteger(state.draggingSceneIndex)) return;
    event.preventDefault();
    const from = state.draggingSceneIndex;
    const to = Number(item.dataset.sceneItem);
    if (from !== to && from >= 0 && from < state.project.scenes.length && to >= 0 && to < state.project.scenes.length) {
      const [scene] = state.project.scenes.splice(from, 1);
      state.project.scenes.splice(to, 0, scene);
      state.selectedScene = to;
      renderEditor();
    }
    state.draggingSceneIndex = null;
  });
  root.addEventListener("dragend", (event) => {
    const item = event.target instanceof Element ? event.target.closest("[data-scene-item]") : null;
    item?.classList.remove("is-dragging");
    state.draggingSceneIndex = null;
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!modalLayer.hidden) closeModal();
      else if (state.isOpen) setOpen(false);
    }
    if (event.key === "Enter" && event.target.matches("[data-pixabay-query]")) {
      event.preventDefault();
      void searchPixabay();
    }
    if (event.key === "Tab" && state.isOpen) {
      const scope = !modalLayer.hidden ? modalLayer.querySelector(".apsh-vs-modal") : root.querySelector(".apsh-vs-app");
      const candidates = [...scope.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.closest("[hidden]") && node.getClientRects().length);
      if (!candidates.length) return;
      const first = candidates[0], last = candidates[candidates.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === scope || !scope.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === scope || !scope.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) setOpen(false);
  });
  modalLayer.addEventListener("click", (event) => {
    if (event.target === modalLayer) closeModal();
  });

  async function renderSuperAdminStats(host, sector = "") {
    if (!host) return null;
    try {
      const query = sector ? `?sector=${encodeURIComponent(sector)}` : "";
      const libraryResult = await request(`/api/video-studio/library${query}`);
      const library = listFrom(libraryResult, "videos");
      const total = Number(libraryResult?.total ?? library.length);
      const entries = library.slice(0, 6).map((video) => {
        const url = safeHttpUrl(video.url || video.published_url);
        const title = esc(video.title || "Untitled video");
        return url
          ? `<a class="apsh-vs-admin-video" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span>${title}</span>${icon("external-link-alt")}</a>`
          : `<span class="apsh-vs-admin-video">${title}</span>`;
      }).join("");
      host.innerHTML = `<div class="apsh-vs-admin-count"><span data-i18n="videos_in_library">Videos in library</span><strong>${total}</strong></div><div class="apsh-vs-admin-video-list">${entries || `<p data-i18n="no_published_videos">No published videos yet.</p>`}</div>`;
      return { library: total, videos: library };
    } catch (error) {
      host.innerHTML = `<div class="apsh-vs-error" role="alert">${esc(`Video Studio statistics unavailable. ${error?.message || ""}`)}</div>`;
      return null;
    }
  }

  const publicApi = {
    setUser,
    open() { if (!state.user) state.user = dependencies.getCurrentUser?.() || null; if (canEdit()) setOpen(true); },
    close() { setOpen(false); },
    refreshCounts,
    refresh() { return state.view === "library" ? loadLibrary() : loadProjects(); },
    renderSuperAdminStats,
    getState() { return { isOpen: state.isOpen, view: state.view, projectId: state.project?.id || null, projects: state.projects.length, library: state.library.length }; },
    updateDependencies(next) { dependencies = { ...dependencies, ...next }; },
  };
  studioInstance = { publicApi, setUser, updateDependencies: publicApi.updateDependencies };
  document.addEventListener("click", (event) => {
    const trigger = event.target?.closest?.("[data-video-studio-open]");
    if (!trigger || !canEdit()) return;
    event.preventDefault();
    publicApi.open();
  });
  setUser(dependencies.getCurrentUser?.());
  return publicApi;
}
