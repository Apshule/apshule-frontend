export function initAccountProfileUI({
    api,
    getCurrentUser,
    setCurrentUser,
    notify,
    escapeHtml,
    onPasswordChanged,
    onOpenSchoolBranding,
    getSiteBrandLogo,
}) {
    const accountMount = document.getElementById("accountInfo");
    const brandingMount = document.getElementById("schoolBrandingMount");
    const classLevels = [
        ["", "Choose class"],
        ["Baby", "Baby Class"], ["Middle", "Middle Class"], ["Top", "Top Class"],
        ["P1", "Primary 1"], ["P2", "Primary 2"], ["P3", "Primary 3"],
        ["P4", "Primary 4"], ["P5", "Primary 5"], ["P6", "Primary 6"],
        ["P7", "Primary 7"], ["S1", "Senior 1"], ["S2", "Senior 2"],
        ["S3", "Senior 3"], ["S4", "Senior 4"], ["S5", "Senior 5"], ["S6", "Senior 6"],
    ];
    let currentUser = null;
    let profile = null;
    let school = null;
    let pendingAvatar = "";
    let pendingLogo = "";
    let passwordDialog = null;
    let profileBusy = false;
    let brandingBusy = false;
    let headerOriginals = null;

    const styles = `
      <style id="apshule-profile-styles">
        .ap-profile { --ap-ink:#29243a; --ap-muted:#716d7d; --ap-line:#e7e2ef; --ap-paper:#fffefa; --ap-wash:#f6f3fa; --ap-purple:#4b2e9e; --ap-deep:#37216f; --ap-lilac:#eee8f8; --ap-green:#24634c; color:var(--ap-ink); font-family:inherit; }
        .ap-profile * { box-sizing:border-box; }
        .ap-profile button,.ap-profile input,.ap-profile select,.ap-profile textarea { font:inherit; }
        .ap-profile button { cursor:pointer; }
        .ap-profile .ap-card { background:var(--ap-paper); border:1px solid var(--ap-line); border-radius:18px; box-shadow:0 7px 24px rgba(50,35,79,.055); padding:clamp(16px,3vw,26px); }
        .ap-profile .ap-heading { margin:0; color:var(--ap-ink); font-size:1.12rem; letter-spacing:-.025em; }
        .ap-profile .ap-subheading { margin:5px 0 0; color:var(--ap-muted); font-size:.9rem; line-height:1.5; }
        .ap-profile .ap-profile-head { display:flex; align-items:center; gap:17px; padding-bottom:21px; border-bottom:1px solid var(--ap-line); margin-bottom:21px; }
        .ap-profile .ap-avatar { width:78px; height:78px; flex:none; border-radius:50%; display:grid; place-items:center; overflow:hidden; color:#fff; font-size:1.45rem; font-weight:750; background:linear-gradient(145deg,#7055bd,#3c277e); border:3px solid #f1ebfb; }
        .ap-profile .ap-avatar img { width:100%; height:100%; object-fit:cover; }
        .ap-profile .ap-identity { min-width:0; flex:1; }
        .ap-profile .ap-identity h2 { margin:0 0 6px; font-size:clamp(1.2rem,3vw,1.55rem); letter-spacing:-.035em; overflow-wrap:anywhere; }
        .ap-profile .ap-meta { display:flex; flex-wrap:wrap; gap:8px; align-items:center; color:var(--ap-muted); font-size:.86rem; }
        .ap-profile .ap-badge { display:inline-flex; align-items:center; border:1px solid #dfd6f0; background:var(--ap-lilac); color:var(--ap-deep); border-radius:999px; padding:4px 10px; font-weight:700; font-size:.76rem; }
        .ap-profile .ap-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px 18px; margin-top:19px; }
        .ap-profile .ap-field { min-width:0; }
        .ap-profile .ap-field--wide { grid-column:1/-1; }
        .ap-profile .ap-field label { display:block; margin:0 0 7px; font-size:.83rem; font-weight:700; color:#484355; }
        .ap-profile .ap-control { display:block; width:100%; min-height:44px; border:1px solid #dcd6e6; border-radius:10px; padding:10px 12px; background:#fff; color:var(--ap-ink); outline:none; transition:border-color .16s,box-shadow .16s; }
        .ap-profile textarea.ap-control { min-height:90px; resize:vertical; }
        .ap-profile .ap-control:focus { border-color:#775fc0; box-shadow:0 0 0 3px rgba(91,65,163,.14); }
        .ap-profile .ap-control:disabled { background:#f2f0f5; color:#777181; cursor:not-allowed; }
        .ap-profile .ap-readonly { min-height:44px; display:flex; align-items:center; padding:9px 12px; background:#f6f4f8; border:1px solid #ece8f0; border-radius:10px; color:#686374; overflow-wrap:anywhere; }
        .ap-profile .ap-hint { color:var(--ap-muted); font-size:.78rem; margin:6px 0 0; line-height:1.45; }
        .ap-profile .ap-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:21px; }
        .ap-profile .ap-button { min-height:42px; border:1px solid #d9d2e5; border-radius:10px; padding:9px 15px; background:#fff; color:#453b5d; font-weight:700; transition:background .16s,transform .16s,border-color .16s; }
        .ap-profile .ap-button:hover:not(:disabled) { background:#f5f1fb; border-color:#b9a9dc; }
        .ap-profile .ap-button:active:not(:disabled) { transform:translateY(1px); }
        .ap-profile .ap-button:disabled { opacity:.58; cursor:not-allowed; }
        .ap-profile .ap-button--primary { background:var(--ap-purple); border-color:var(--ap-purple); color:white; }
        .ap-profile .ap-button--primary:hover:not(:disabled) { background:var(--ap-deep); border-color:var(--ap-deep); }
        .ap-profile .ap-button--link { border:0; background:transparent; color:var(--ap-purple); padding:6px 0; min-height:auto; text-align:left; }
        .ap-profile .ap-status { min-height:1.25em; margin:12px 0 0; color:var(--ap-green); font-size:.86rem; }
        .ap-profile .ap-status[data-kind="error"] { color:#a33338; }
        .ap-profile .ap-status[data-kind="loading"] { color:var(--ap-muted); }
        .ap-profile .ap-photo-pick { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:9px; background:#f5f1fb; color:var(--ap-purple); border:1px solid #e1d8f0; font-size:.8rem; font-weight:700; cursor:pointer; }
        .ap-profile .ap-photo-pick input { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
        .ap-profile .ap-photo-pick:focus-within { outline:3px solid rgba(91,65,163,.25); }
        .ap-profile .ap-role-panel { margin-top:22px; padding-top:19px; border-top:1px solid var(--ap-line); }
        .ap-profile .ap-role-panel h3 { margin:0 0 3px; font-size:.98rem; }
        .ap-profile .ap-role-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:13px; margin-top:14px; }
        .ap-profile .ap-divider { height:1px; background:var(--ap-line); margin:22px 0; }
        .ap-profile .ap-color-field { display:flex; align-items:center; gap:10px; }
        .ap-profile input[type="color"].ap-control { width:52px; min-width:52px; height:44px; padding:5px; }
        .ap-profile .ap-logo-preview { width:86px; height:86px; border-radius:14px; display:grid; place-items:center; overflow:hidden; color:var(--ap-purple); background:#f2eef8; border:1px dashed #c9bddf; font-size:.77rem; font-weight:700; text-align:center; }
        .ap-profile .ap-logo-preview img { width:100%; height:100%; object-fit:contain; background:#fff; }
        .ap-profile .ap-brand-logo-row { display:flex; align-items:center; gap:15px; }
        .ap-profile .ap-error-box { padding:13px 15px; border:1px solid #edc8c8; background:#fff4f2; border-radius:12px; color:#812d34; }
        .header .school-motto { margin-top:2px; color:var(--school-header-foreground,rgba(255,255,255,.82)); font-size:11px; line-height:1.35; }
        .header .school-motto[hidden] { display:none; }
        .ap-profile .ap-skeleton { height:14px; border-radius:8px; margin:13px 0; background:linear-gradient(90deg,#f0edf4,#faf8fc,#f0edf4); background-size:200% 100%; animation:ap-shimmer 1.4s ease-in-out infinite; }
        .ap-profile .ap-skeleton.ap-wide { width:82%; height:24px; }
        @keyframes ap-shimmer { to { background-position:-200% 0; } }
        .ap-profile .ap-modal-backdrop { position:fixed; inset:0; z-index:10080; background:rgba(31,25,44,.5); display:grid; place-items:center; padding:18px; }
        .ap-profile .ap-modal-backdrop[hidden] { display:none; }
        .ap-profile .ap-modal { width:min(100%,460px); max-height:min(90dvh,700px); overflow:auto; background:#fffefa; border:1px solid #e6dfed; border-radius:18px; padding:23px; box-shadow:0 24px 70px rgba(24,14,48,.25); }
        .ap-profile .ap-modal-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:18px; }
        .ap-profile .ap-close { width:36px; height:36px; flex:none; border:1px solid var(--ap-line); border-radius:50%; color:#5a5269; background:#fff; font-size:1.2rem; }
        .ap-profile .ap-modal .ap-field + .ap-field { margin-top:14px; }
        @media(max-width:620px) {
          .ap-profile .ap-form-grid,.ap-profile .ap-role-grid { grid-template-columns:1fr; }
          .ap-profile .ap-field--wide { grid-column:auto; }
          .ap-profile .ap-profile-head { align-items:flex-start; }
          .ap-profile .ap-avatar { width:66px; height:66px; }
          .ap-profile .ap-card { border-radius:15px; }
        }
        @media(prefers-reduced-motion:reduce) { .ap-profile *, .ap-profile *::before, .ap-profile *::after { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
      </style>`;

    if (!document.getElementById("apshule-profile-styles")) {
        document.head.insertAdjacentHTML("beforeend", styles);
    }

    const esc = (value) => {
        const text = value == null ? "" : String(value);
        if (typeof escapeHtml === "function") return escapeHtml(text);
        return text.replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[char]);
    };
    const statusMarkup = (id) => `<p class="ap-status" id="${id}" role="status" aria-live="polite"></p>`;
    const writeStatus = (id, message, kind = "") => {
        const node = document.getElementById(id);
        if (!node) return;
        node.textContent = message || "";
        node.dataset.kind = kind;
    };
    const tell = (message, type = "success") => {
        if (typeof notify === "function") notify(message, type);
    };
    const isStudent = (user) => user?.role === "individual" && String(user?.sector || "").toLowerCase() === "education";
    const isImpersonated = (user) => Boolean(user?.impersonatedBy || user?.impersonated_by);
    const schoolIdOf = (user) => user?.schoolId || user?.school_id || "";
    const roleTitle = (user) => ({
        individual: isStudent(user) ? "Student" : "Individual",
        teacher: "Teacher",
        school: "School Admin",
        superadmin: "Super Admin",
    }[user?.role] || "Account");
    const initials = (name) => String(name || "A").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
    const dateValue = (value) => value ? String(value).slice(0, 10) : "";
    const imageSource = (value, fallback = "") => {
        if (!value) return fallback;
        const text = String(value);
        if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(text)) return text;
        if (/^https?:\/\/\S+$/i.test(text)) return text;
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return `data:image/jpeg;base64,${text}`;
        return fallback;
    };

    function renderAccountLoading() {
        if (!accountMount) return;
        accountMount.innerHTML = `<section class="ap-profile ap-card" aria-label="Loading account profile" aria-busy="true"><div class="ap-skeleton ap-wide"></div><div class="ap-skeleton"></div><div class="ap-skeleton"></div><div class="ap-skeleton"></div></section>`;
    }

    function renderProfile(user) {
        if (!accountMount) return;
        const locked = isImpersonated(user);
        const student = isStudent(user);
        const teacher = user?.role === "teacher";
        const avatar = imageSource(user?.avatar_base64 || user?.profile_pic);
        const name = user?.name || "";
        const schoolName = user?.school_name || user?.schoolName || "";
        const studentOptions = classLevels.map(([value, label]) =>
            `<option value="${esc(value)}"${String(user?.class_level || "") === value ? " selected" : ""}>${esc(label)}</option>`
        ).join("");
        const genderOptions = [
            ["", "Not specified"], ["female", "Female"], ["male", "Male"],
            ["other", "Other"], ["prefer_not_to_say", "Prefer not to say"],
        ].map(([value, label]) =>
            `<option value="${value}"${String(user?.gender || "") === value ? " selected" : ""}>${label}</option>`
        ).join("");
        const teacherFields = teacher ? `
          <section class="ap-role-panel" aria-labelledby="ap-role-heading">
            <h3 id="ap-role-heading">Teaching details</h3>
            <p class="ap-subheading">These school-assigned details are read-only.</p>
            <div class="ap-role-grid">
              <div class="ap-field"><label>Subjects taught</label><div class="ap-readonly">${esc(Array.isArray(user.subjects_taught) ? user.subjects_taught.join(", ") : user.subjects_taught || "Not assigned")}</div></div>
              <div class="ap-field"><label>Assigned classes</label><div class="ap-readonly">${esc(Array.isArray(user.assigned_classes) ? user.assigned_classes.join(", ") : user.assigned_classes || "Not assigned")}</div></div>
              <div class="ap-field"><label>Learner identification number (LIN)</label><div class="ap-readonly">${esc(user.lin || "Not set")}</div></div>
            </div>
          </section>` : "";
        const studentFields = student ? `
          <section class="ap-role-panel" aria-labelledby="ap-role-heading">
            <h3 id="ap-role-heading">School details</h3>
            <div class="ap-role-grid">
              <div class="ap-field"><label for="apClassLevel">Class level</label><select class="ap-control" id="apClassLevel"${locked ? " disabled" : ""}>${studentOptions}</select></div>
              <div class="ap-field"><label>Learner identification number (LIN)</label><div class="ap-readonly">${esc(user.lin || "Not set")}</div></div>
            </div>
          </section>` : "";
        const schoolLink = user?.role === "school" ? `
          <section class="ap-role-panel">
            <h3>School information</h3>
            <button type="button" class="ap-button ap-button--link" id="apOpenBranding">${esc(schoolName || "Open school branding")} <span aria-hidden="true">→</span></button>
          </section>` : "";
        const lockNotice = locked ? `<p class="ap-hint" role="note">Profile editing is unavailable during an impersonation session.</p>` : "";

        accountMount.innerHTML = `
          <section class="ap-profile ap-card" aria-labelledby="ap-profile-title">
            <div class="ap-profile-head">
              <div class="ap-avatar" id="apAvatarPreview" aria-label="${avatar ? "Profile photo" : `Profile initials for ${esc(name)}`}">${avatar ? `<img src="${esc(avatar)}" alt="Profile photo">` : esc(initials(name))}</div>
              <div class="ap-identity">
                <h2 id="ap-profile-title">${esc(name || "Your profile")}</h2>
                <div class="ap-meta"><span class="ap-badge">${esc(roleTitle(user))}</span><span>${esc(user?.email || "Email unavailable")}</span></div>
                <label class="ap-photo-pick" for="apAvatarInput">Choose profile photo<input id="apAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a PNG, JPEG or WebP profile photo"${locked ? " disabled" : ""}></label>
                <p class="ap-hint">PNG, JPEG or WebP. Images are resized to 200 KB or less.</p>
              </div>
            </div>
            ${lockNotice}
            <form id="apProfileForm" novalidate>
              <div class="ap-form-grid">
                <div class="ap-field"><label for="apName">Full name</label><input class="ap-control" id="apName" name="name" autocomplete="name" maxlength="120" required value="${esc(name)}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label>Email address</label><div class="ap-readonly" aria-readonly="true">${esc(user?.email || "Not available")}</div><p class="ap-hint">Email is managed by your account and cannot be edited here.</p></div>
                <div class="ap-field"><label for="apPhone">Phone number</label><input class="ap-control" id="apPhone" name="phone" type="tel" autocomplete="tel" maxlength="40" value="${esc(user?.phone || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apGender">Gender</label><select class="ap-control" id="apGender" name="gender"${locked ? " disabled" : ""}>${genderOptions}</select></div>
                <div class="ap-field"><label for="apDob">Date of birth</label><input class="ap-control" id="apDob" name="date_of_birth" type="date" value="${esc(dateValue(user?.date_of_birth))}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apAddress">Address</label><input class="ap-control" id="apAddress" name="address" autocomplete="street-address" maxlength="300" value="${esc(user?.address || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field ap-field--wide"><label for="apBio">About you</label><textarea class="ap-control" id="apBio" name="bio" maxlength="200" aria-describedby="apBioHint"${locked ? " disabled" : ""}>${esc(user?.bio || "")}</textarea><p class="ap-hint" id="apBioHint">A short introduction, up to 200 characters.</p></div>
              </div>
              ${studentFields}${teacherFields}${schoolLink}
              <div class="ap-actions">
                <button class="ap-button ap-button--primary" id="apSaveProfile" type="submit"${locked ? " disabled" : ""}>Save profile</button>
                <button class="ap-button" id="apOpenPassword" type="button"${locked ? " disabled" : ""}>Change password</button>
              </div>
              ${statusMarkup("apProfileStatus")}
            </form>
          </section>
          <div class="ap-modal-backdrop" id="apPasswordBackdrop" hidden>
            <section class="ap-modal" role="dialog" aria-modal="true" aria-labelledby="apPasswordTitle" aria-describedby="apPasswordHelp">
              <div class="ap-modal-top"><div><h2 class="ap-heading" id="apPasswordTitle">Change password</h2><p class="ap-subheading" id="apPasswordHelp">Choose a new password you have not used before.</p></div><button class="ap-close" type="button" id="apPasswordClose" aria-label="Close password dialog">×</button></div>
              <form id="apPasswordForm" novalidate>
                <div class="ap-field"><label for="apOldPassword">Current password</label><input class="ap-control" id="apOldPassword" type="password" autocomplete="current-password" required></div>
                <div class="ap-field"><label for="apNewPassword">New password</label><input class="ap-control" id="apNewPassword" type="password" autocomplete="new-password" minlength="6" required><p class="ap-hint">Use at least 6 characters.</p></div>
                <div class="ap-field"><label for="apConfirmPassword">Confirm new password</label><input class="ap-control" id="apConfirmPassword" type="password" autocomplete="new-password" minlength="6" required></div>
                <div class="ap-actions"><button class="ap-button ap-button--primary" id="apPasswordSubmit" type="submit">Update password</button><button class="ap-button" type="button" id="apPasswordCancel">Cancel</button></div>
                ${statusMarkup("apPasswordStatus")}
              </form>
            </section>
          </div>`;

        passwordDialog = accountMount.querySelector("#apPasswordBackdrop");
        wireProfileEvents(user);
    }

    function wireProfileEvents(user) {
        const form = document.getElementById("apProfileForm");
        const avatarInput = document.getElementById("apAvatarInput");
        const saveButton = document.getElementById("apSaveProfile");
        const locked = isImpersonated(user);
        form?.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (locked || profileBusy) return;
            const name = document.getElementById("apName")?.value.trim() || "";
            if (!name) {
                writeStatus("apProfileStatus", "Please enter your name.", "error");
                document.getElementById("apName")?.focus();
                return;
            }
            const body = {
                name,
                phone: document.getElementById("apPhone")?.value.trim() || null,
                address: document.getElementById("apAddress")?.value.trim() || null,
                bio: document.getElementById("apBio")?.value.trim() || null,
                date_of_birth: document.getElementById("apDob")?.value || null,
                gender: document.getElementById("apGender")?.value || null,
            };
            if (isStudent(user)) body.class_level = document.getElementById("apClassLevel")?.value || null;
            if (pendingAvatar) body.avatar_base64 = pendingAvatar;
            await saveProfile(body, saveButton);
        });

        avatarInput?.addEventListener("change", async () => {
            const file = avatarInput.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await prepareImage(file);
                pendingAvatar = dataUrl;
                const preview = document.getElementById("apAvatarPreview");
                if (preview) preview.innerHTML = `<img src="${esc(dataUrl)}" alt="Selected profile photo preview">`;
                writeStatus("apProfileStatus", "Photo ready. Save your profile to apply it.", "loading");
            } catch (error) {
                avatarInput.value = "";
                showError(error, "apProfileStatus");
            }
        });

        document.getElementById("apOpenPassword")?.addEventListener("click", openPasswordDialog);
        document.getElementById("apPasswordClose")?.addEventListener("click", closePasswordDialog);
        document.getElementById("apPasswordCancel")?.addEventListener("click", closePasswordDialog);
        passwordDialog?.addEventListener("click", (event) => {
            if (event.target === passwordDialog) closePasswordDialog();
        });
        document.getElementById("apOpenBranding")?.addEventListener("click", () => {
            if (typeof onOpenSchoolBranding === "function") onOpenSchoolBranding();
            brandingMount?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        });
        document.getElementById("apPasswordForm")?.addEventListener("submit", submitPassword);
    }

    async function saveProfile(body, button) {
        profileBusy = true;
        if (button) {
            button.disabled = true;
            button.textContent = "Saving…";
        }
        writeStatus("apProfileStatus", "Saving profile…", "loading");
        try {
            const response = await api("/api/users/me/profile", { method: "PATCH", body });
            const updated = response?.user;
            if (!updated) throw new Error("The profile was saved, but the server returned no profile.");
            profile = updated;
            pendingAvatar = "";
            const merged = { ...(currentUser || {}), ...updated };
            currentUser = merged;
            if (typeof setCurrentUser === "function") setCurrentUser(merged);
            renderProfile(merged);
            writeStatus("apProfileStatus", "Your profile has been saved.", "success");
            tell("Profile saved.");
        } catch (error) {
            showError(error, "apProfileStatus");
        } finally {
            profileBusy = false;
            const currentButton = document.getElementById("apSaveProfile");
            if (currentButton) {
                currentButton.disabled = isImpersonated(currentUser);
                currentButton.textContent = "Save profile";
            }
        }
    }

    function openPasswordDialog() {
        if (!passwordDialog || isImpersonated(currentUser)) return;
        passwordDialog.hidden = false;
        document.body.style.overflow = "hidden";
        document.getElementById("apOldPassword")?.focus();
        document.addEventListener("keydown", onPasswordKeydown);
    }

    function closePasswordDialog() {
        if (!passwordDialog) return;
        passwordDialog.hidden = true;
        document.body.style.overflow = "";
        document.removeEventListener("keydown", onPasswordKeydown);
        document.getElementById("apPasswordForm")?.reset();
        writeStatus("apPasswordStatus", "");
        document.getElementById("apOpenPassword")?.focus();
    }

    function onPasswordKeydown(event) {
        if (event.key === "Escape") closePasswordDialog();
        if (event.key !== "Tab" || passwordDialog?.hidden) return;
        const focusable = [...passwordDialog.querySelectorAll("button:not(:disabled),input:not(:disabled)")];
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
            event.preventDefault();
            focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
            event.preventDefault();
            focusable[0].focus();
        }
    }

    async function submitPassword(event) {
        event.preventDefault();
        if (isImpersonated(currentUser)) return;
        const oldPassword = document.getElementById("apOldPassword")?.value || "";
        const newPassword = document.getElementById("apNewPassword")?.value || "";
        const confirmation = document.getElementById("apConfirmPassword")?.value || "";
        if (!oldPassword || newPassword.length < 6) {
            writeStatus("apPasswordStatus", "Enter your current password and a new password of at least 6 characters.", "error");
            return;
        }
        if (newPassword !== confirmation) {
            writeStatus("apPasswordStatus", "The new passwords do not match.", "error");
            document.getElementById("apConfirmPassword")?.focus();
            return;
        }
        const submit = document.getElementById("apPasswordSubmit");
        if (submit) {
            submit.disabled = true;
            submit.textContent = "Updating…";
        }
        writeStatus("apPasswordStatus", "Updating password…", "loading");
        try {
            const response = await api("/api/users/me/change-password", {
                method: "POST",
                body: { old_password: oldPassword, new_password: newPassword },
            });
            const message = response?.message || "Password changed.";
            writeStatus("apPasswordStatus", message, "success");
            tell(message);
            if (typeof onPasswordChanged === "function") onPasswordChanged(message);
            document.getElementById("apPasswordForm")?.reset();
            window.setTimeout(closePasswordDialog, 450);
        } catch (error) {
            showError(error, "apPasswordStatus");
        } finally {
            const currentSubmit = document.getElementById("apPasswordSubmit");
            if (currentSubmit) {
                currentSubmit.disabled = false;
                currentSubmit.textContent = "Update password";
            }
        }
    }

    function showError(error, statusId) {
        const message = error?.message || "Something went wrong. Please try again.";
        writeStatus(statusId, message, "error");
        tell(message, "error");
    }

    async function prepareImage(file) {
        const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
        if (!allowed.has(file.type)) throw new Error("Choose a PNG, JPEG or WebP image.");
        if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
        let bitmap;
        try {
            if (typeof createImageBitmap === "function") {
                bitmap = await createImageBitmap(file);
            } else {
                bitmap = await loadImage(file);
            }
        } catch {
            throw new Error("This image could not be opened. Please choose another file.");
        }
        let width = bitmap.width;
        let height = bitmap.height;
        if (!width || !height) throw new Error("This image has no usable dimensions.");
        const maxDimension = 1200;
        const scale = Math.min(1, maxDimension / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image editing is not available in this browser.");
        let blob;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            canvas.width = width;
            canvas.height = height;
            context.clearRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            blob = await canvasBlob(canvas, "image/jpeg", Math.max(.38, .86 - attempt * .045));
            if (blob.size <= 200 * 1024) break;
            width = Math.max(160, Math.round(width * .82));
            height = Math.max(160, Math.round(height * .82));
        }
        if (bitmap.close) bitmap.close();
        if (!blob || blob.size > 200 * 1024) throw new Error("This image could not be reduced below 200 KB. Choose a smaller image.");
        return await blobDataUrl(blob);
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const url = URL.createObjectURL(file);
            image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("Could not decode image"));
            };
            image.src = url;
        });
    }

    function canvasBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image compression failed.")), type, quality);
        });
    }

    function blobDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("The compressed image could not be read."));
            reader.readAsDataURL(blob);
        });
    }

    async function refreshProfile() {
        if (!accountMount) return null;
        if (!currentUser && typeof getCurrentUser === "function") currentUser = getCurrentUser();
        if (!currentUser) {
            accountMount.innerHTML = `<section class="ap-profile ap-card"><h2 class="ap-heading">Your account</h2><p class="ap-subheading">Sign in to view and update your profile.</p></section>`;
            return null;
        }
        renderAccountLoading();
        try {
            const response = await api("/api/users/me/profile");
            if (!response?.user) throw new Error("The profile could not be loaded.");
            profile = response.user;
            currentUser = { ...(currentUser || {}), ...response.user };
            if (typeof setCurrentUser === "function") setCurrentUser(currentUser);
            renderProfile(currentUser);
            return currentUser;
        } catch (error) {
            accountMount.innerHTML = `<section class="ap-profile ap-card"><div class="ap-error-box"><strong>Profile unavailable</strong><p id="apProfileLoadError">${esc(error?.message || "Please try again.")}</p><button class="ap-button" type="button" id="apRetryProfile">Try again</button></div></section>`;
            accountMount.querySelector("#apRetryProfile")?.addEventListener("click", refreshProfile);
            tell(error?.message || "Could not load your profile.", "error");
            return null;
        }
    }

    function ensureHeaderOriginals() {
        if (headerOriginals) return;
        const logo = document.getElementById("headerLogoImg");
        const header = document.querySelector(".header");
        const motto = document.getElementById("schoolMotto");
        headerOriginals = {
            logoSrc: logo?.getAttribute("src") || "",
            background: header?.style.background || "",
            backgroundColor: header?.style.backgroundColor || "",
            foreground: header?.style.getPropertyValue("--school-header-foreground") || "",
            mottoText: motto?.textContent || "",
            mottoHidden: motto?.hidden !== false,
        };
    }

    function applyHeaderBranding(branding) {
        ensureHeaderOriginals();
        const logo = document.getElementById("headerLogoImg");
        const header = document.querySelector(".header");
        const motto = document.getElementById("schoolMotto");
        const siteLogo = typeof getSiteBrandLogo === "function" ? getSiteBrandLogo() : headerOriginals.logoSrc;
        const brandLogo = branding?.logo_base64 || branding?.logo;
        if (logo) logo.src = imageSource(brandLogo, siteLogo || headerOriginals.logoSrc);
        const brandColor = String(branding?.brand_color || "");
        if (header && /^#[0-9a-f]{6}$/i.test(brandColor)) {
            header.style.background = brandColor;
            header.style.setProperty("--school-header-foreground", contrastingForeground(brandColor));
        }
        if (motto) {
            motto.textContent = branding?.motto || "";
            motto.hidden = !branding?.motto;
        }
    }

    function contrastingForeground(hexColor) {
        const values = hexColor.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
        const [red, green, blue] = values.map((channel) =>
            channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        );
        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        const whiteContrast = 1.05 / (luminance + 0.05);
        const darkContrast = (luminance + 0.05) / 0.05;
        return whiteContrast >= darkContrast ? "#FFFFFF" : "#1D1930";
    }

    function resetHeaderBranding() {
        ensureHeaderOriginals();
        const logo = document.getElementById("headerLogoImg");
        const header = document.querySelector(".header");
        const motto = document.getElementById("schoolMotto");
        const siteLogo = typeof getSiteBrandLogo === "function" ? getSiteBrandLogo() : "";
        if (logo) logo.src = siteLogo || headerOriginals.logoSrc;
        if (header) header.style.background = headerOriginals.background;
        if (header) header.style.backgroundColor = headerOriginals.backgroundColor;
        if (header) {
            if (headerOriginals.foreground) header.style.setProperty("--school-header-foreground", headerOriginals.foreground);
            else header.style.removeProperty("--school-header-foreground");
        }
        if (motto) {
            motto.textContent = headerOriginals.mottoText;
            motto.hidden = headerOriginals.mottoHidden;
        }
        school = null;
    }

    function renderBrandingLoading() {
        if (!brandingMount) return;
        brandingMount.innerHTML = `<section class="ap-profile ap-card" aria-label="Loading school information" aria-busy="true"><div class="ap-skeleton ap-wide"></div><div class="ap-skeleton"></div><div class="ap-skeleton"></div></section>`;
    }

    function renderBrandingForm(value) {
        if (!brandingMount) return;
        const locked = isImpersonated(currentUser);
        const logoSrc = imageSource(value.logo_base64 || value.logo);
        brandingMount.innerHTML = `
          <section class="ap-profile ap-card" aria-labelledby="ap-branding-title">
            <h2 class="ap-heading" id="ap-branding-title">School profile &amp; branding</h2>
            <p class="ap-subheading">Keep your school’s contact details and identity current for families and learners.</p>
            ${locked ? `<p class="ap-hint" role="note">School details cannot be changed during an impersonation session.</p>` : ""}
            <form id="apBrandingForm" novalidate>
              <div class="ap-form-grid">
                <div class="ap-field"><label for="apSchoolName">School name</label><input class="ap-control" id="apSchoolName" maxlength="160" required value="${esc(value.name || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apSchoolMotto">School motto</label><input class="ap-control" id="apSchoolMotto" maxlength="200" value="${esc(value.motto || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field ap-field--wide"><label for="apSchoolAddress">Address</label><input class="ap-control" id="apSchoolAddress" maxlength="300" autocomplete="street-address" value="${esc(value.address || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apSchoolPhone">Phone</label><input class="ap-control" id="apSchoolPhone" type="tel" maxlength="40" value="${esc(value.phone || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apSchoolEmail">Email</label><input class="ap-control" id="apSchoolEmail" type="email" maxlength="254" value="${esc(value.email || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apSchoolWebsite">Website</label><input class="ap-control" id="apSchoolWebsite" type="url" maxlength="500" placeholder="https://" value="${esc(value.website || "")}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apBrandColor">Header brand color</label><div class="ap-color-field"><input class="ap-control" id="apBrandColor" type="color" value="${/^#[0-9a-f]{6}$/i.test(value.brand_color || "") ? esc(value.brand_color) : "#4B2E9E"}" aria-label="Choose school brand color"${locked ? " disabled" : ""}><span class="ap-hint" id="apBrandColorValue">${esc(value.brand_color || "#4B2E9E")}</span></div></div>
                <div class="ap-field ap-field--wide"><span class="ap-field-label" style="display:block;margin-bottom:7px;font-size:.83rem;font-weight:700;color:#484355">School logo</span><div class="ap-brand-logo-row"><div class="ap-logo-preview" id="apLogoPreview">${logoSrc ? `<img src="${esc(logoSrc)}" alt="Current school logo">` : "No logo yet"}</div><div><label class="ap-photo-pick" for="apLogoInput">Choose logo<input id="apLogoInput" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a PNG, JPEG or WebP school logo"${locked ? " disabled" : ""}></label><p class="ap-hint">PNG, JPEG or WebP. The image is resized to 200 KB or less.</p></div></div></div>
                <div class="ap-field"><label for="apTermEnded">Term ended on</label><input class="ap-control" id="apTermEnded" type="date" value="${esc(dateValue(value.term_ended_on))}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apNextTerm">Next term begins</label><input class="ap-control" id="apNextTerm" type="date" value="${esc(dateValue(value.next_term_begins_on))}"${locked ? " disabled" : ""}></div>
                <div class="ap-field"><label for="apNextFees">Next term fees</label><input class="ap-control" id="apNextFees" type="number" min="0" step="any" inputmode="decimal" value="${esc(value.next_term_fees ?? "")}"${locked ? " disabled" : ""}></div>
              </div>
              <div class="ap-actions"><button class="ap-button ap-button--primary" id="apSaveBranding" type="submit"${locked ? " disabled" : ""}>Save school details</button></div>
              ${statusMarkup("apBrandingStatus")}
            </form>
          </section>`;
        wireBrandingEvents(value);
    }

    function wireBrandingEvents(value) {
        const form = document.getElementById("apBrandingForm");
        const logoInput = document.getElementById("apLogoInput");
        document.getElementById("apBrandColor")?.addEventListener("input", (event) => {
            const valueNode = document.getElementById("apBrandColorValue");
            if (valueNode) valueNode.textContent = event.currentTarget.value.toUpperCase();
        });
        logoInput?.addEventListener("change", async () => {
            const file = logoInput.files?.[0];
            if (!file) return;
            try {
                pendingLogo = await prepareImage(file);
                const preview = document.getElementById("apLogoPreview");
                if (preview) preview.innerHTML = `<img src="${esc(pendingLogo)}" alt="Selected school logo preview">`;
                writeStatus("apBrandingStatus", "Logo ready. Save school details to apply it.", "loading");
            } catch (error) {
                logoInput.value = "";
                showError(error, "apBrandingStatus");
            }
        });
        form?.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (isImpersonated(currentUser) || brandingBusy) return;
            const name = document.getElementById("apSchoolName")?.value.trim() || "";
            if (!name) {
                writeStatus("apBrandingStatus", "Please enter your school name.", "error");
                document.getElementById("apSchoolName")?.focus();
                return;
            }
            const body = {
                name,
                motto: document.getElementById("apSchoolMotto")?.value.trim() || null,
                address: document.getElementById("apSchoolAddress")?.value.trim() || null,
                phone: document.getElementById("apSchoolPhone")?.value.trim() || null,
                email: document.getElementById("apSchoolEmail")?.value.trim() || null,
                website: document.getElementById("apSchoolWebsite")?.value.trim() || null,
                brand_color: document.getElementById("apBrandColor")?.value || "#4B2E9E",
                term_ended_on: document.getElementById("apTermEnded")?.value || null,
                next_term_begins_on: document.getElementById("apNextTerm")?.value || null,
                next_term_fees: document.getElementById("apNextFees")?.value === "" ? null : Number(document.getElementById("apNextFees")?.value),
            };
            if (pendingLogo) body.logo_base64 = pendingLogo;
            await saveBranding(body);
        });
    }

    async function saveBranding(body) {
        brandingBusy = true;
        const button = document.getElementById("apSaveBranding");
        if (button) {
            button.disabled = true;
            button.textContent = "Saving…";
        }
        writeStatus("apBrandingStatus", "Saving school details…", "loading");
        try {
            const response = await api("/api/school/me", { method: "PATCH", body });
            if (!response?.school) throw new Error("School details were saved, but no school profile was returned.");
            school = response.school;
            pendingLogo = "";
            if (currentUser) {
                currentUser = {
                    ...currentUser,
                    school_name: school.name,
                    schoolName: school.name,
                };
                if (typeof setCurrentUser === "function") setCurrentUser(currentUser);
            }
            applyHeaderBranding(school);
            await refreshBranding();
            writeStatus("apBrandingStatus", "School details have been saved.", "success");
            tell("School branding saved.");
        } catch (error) {
            showError(error, "apBrandingStatus");
        } finally {
            brandingBusy = false;
            const currentButton = document.getElementById("apSaveBranding");
            if (currentButton) {
                currentButton.disabled = isImpersonated(currentUser);
                currentButton.textContent = "Save school details";
            }
        }
    }

    async function refreshBranding() {
        if (!currentUser && typeof getCurrentUser === "function") currentUser = getCurrentUser();
        const schoolId = schoolIdOf(currentUser);
        if (!schoolId) {
            resetHeaderBranding();
            if (brandingMount) brandingMount.innerHTML = "";
            return null;
        }
        let brandingResult = null;
        try {
            const response = await api(`/api/school/branding?school_id=${encodeURIComponent(schoolId)}`, { auth: false });
            if (!response?.branding) throw new Error("School branding could not be loaded.");
            brandingResult = response.branding;
            applyHeaderBranding(brandingResult);
        } catch (error) {
            if (brandingMount && currentUser?.role === "school") {
                brandingMount.innerHTML = `<section class="ap-profile ap-card"><div class="ap-error-box"><strong>School branding unavailable</strong><p>${esc(error?.message || "Please try again.")}</p><button class="ap-button" type="button" id="apRetryBranding">Try again</button></div></section>`;
                brandingMount.querySelector("#apRetryBranding")?.addEventListener("click", refreshBranding);
            }
            tell(error?.message || "Could not load school branding.", "error");
        }

        if (currentUser?.role === "school" && brandingMount) {
            renderBrandingLoading();
            try {
                const response = await api("/api/school/me");
                if (!response?.school) throw new Error("School profile could not be loaded.");
                school = response.school;
                renderBrandingForm(school);
                applyHeaderBranding({ ...(brandingResult || {}), ...school });
                return school;
            } catch (error) {
                brandingMount.innerHTML = `<section class="ap-profile ap-card"><div class="ap-error-box"><strong>School profile unavailable</strong><p>${esc(error?.message || "Please try again.")}</p><button class="ap-button" type="button" id="apRetryBranding">Try again</button></div></section>`;
                brandingMount.querySelector("#apRetryBranding")?.addEventListener("click", refreshBranding);
                tell(error?.message || "Could not load school profile.", "error");
                return null;
            }
        }
        if (brandingMount) brandingMount.innerHTML = "";
        return brandingResult;
    }

    async function setUser(user) {
        if (passwordDialog && !passwordDialog.hidden) closePasswordDialog();
        passwordDialog = null;
        currentUser = user || (typeof getCurrentUser === "function" ? getCurrentUser() : null);
        profile = null;
        school = null;
        pendingAvatar = "";
        pendingLogo = "";
        if (!currentUser) {
            resetHeaderBranding();
            if (accountMount) accountMount.innerHTML = "";
            if (brandingMount) brandingMount.innerHTML = "";
            return null;
        }
        const results = await Promise.all([refreshProfile(), refreshBranding()]);
        return results[0];
    }

    return {
        setUser,
        refreshProfile,
        refreshBranding,
        resetHeaderBranding,
    };
}