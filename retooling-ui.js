const MAX_PHOTO_BASE64_CHARS = 500 * 1024;

export function initRetoolingUI({ api, getCurrentUser, escapeHtml, notify }) {
    let activeUserId = null;
    let modules = [];
    let activeModule = null;
    let currentCertificate = null;
    let practicalPhotoBase64 = "";
    let certificateRows = [];
    let certificatePage = 1;
    let certificateTotalPages = 1;
    let certificateSearchTimer = null;
    let adminPdfObjectUrl = null;

    const byId = (id) => document.getElementById(id);
    const safe = (value) => escapeHtml(value ?? "");
    const setStatus = (id, message, isError = false) => {
        const element = byId(id);
        if (!element) return;
        element.textContent = message || "";
        element.classList.toggle("is-error", Boolean(isError));
    };
    const asDate = (value) => {
        if (!value) return "Not recorded";
        const date = new Date(value);
        return Number.isFinite(date.getTime())
            ? date.toLocaleDateString(undefined, { dateStyle: "medium" })
            : "Not recorded";
    };
    const progressFor = (module) => module?.progress || module || {};
    const isPdfRead = (module) => !module.pdf_url || Boolean(progressFor(module).pdf_read_at);

    function teacherModuleStatus(module) {
        const progress = progressFor(module);
        if (progress.completed) return "✅ Completed";
        if (!progress.module_started_at) return "⏳ Not started";
        if (module.pdf_url && !progress.pdf_read_at) return "📖 In progress";
        if (progress.quiz_passed && !progress.has_practical_photo) return "⏳ Awaiting practical";
        if (!progress.quiz_passed) return "⏳ Awaiting quiz";
        return "📖 In progress";
    }

    function renderCourse() {
        const moduleGrid = byId("teacherRetoolingModules");
        if (!moduleGrid) return;
        const completedCount = modules.filter((module) => Boolean(module.completed)).length;
        const percent = Math.round((completedCount / 10) * 100);
        byId("teacherRetoolingProgressText").textContent = `${completedCount} of 10 modules complete`;
        byId("teacherRetoolingPercent").textContent = `${percent}%`;
        byId("teacherRetoolingProgressBar").setAttribute("aria-valuenow", String(completedCount));
        byId("teacherRetoolingProgressFill").style.width = `${percent}%`;
        byId("teacherRetoolingCardCount").textContent = String(completedCount);
        moduleGrid.innerHTML = modules.map((module) => {
            const status = teacherModuleStatus(module);
            const complete = Boolean(module.completed);
            const score = module.quiz_score;
            return `<button type="button" class="teacher-module-card ${complete ? "teacher-module-card--done" : ""}" data-teacher-module="${Number(module.id)}">
                <span class="teacher-retooling-card-top"><small>MODULE ${Number(module.id)}</small><span class="teacher-retooling-status ${complete ? "is-complete" : ""}">${safe(status)}</span></span>
                <strong>${safe(module.title)}</strong>
                <small>${safe(module.description || "NCDC professional development")}${score !== null && score !== undefined ? ` · Quiz ${safe(score)}%` : ""}</small>
            </button>`;
        }).join("");

        const banner = byId("teacherRetoolingComplete");
        const viewCertificateButton = byId("teacherRetoolingViewCertificate");
        banner.hidden = completedCount !== 10;
        viewCertificateButton.hidden = !currentCertificate || Boolean(currentCertificate.revoked);
        if (completedCount === 10) {
            byId("teacherRetoolingCompleteText").textContent = currentCertificate?.revoked
                ? "🎉 Course complete. Your CPD certificate has been revoked."
                : currentCertificate
                    ? "🎉 Course complete! Your CPD certificate is ready."
                    : "🎉 Course complete! Your certificate is being prepared.";
        }
    }

    async function loadCourse() {
        if (getCurrentUser()?.role !== "teacher") return;
        setStatus("teacherRetoolingStatus", "Loading course modules…");
        try {
            const response = await api("/api/retooling-modules");
            if (getCurrentUser()?.id !== activeUserId) return;
            modules = Array.isArray(response?.modules) ? response.modules : [];
            currentCertificate = null;
            if (modules.length === 10 && modules.every((module) => module.completed)) {
                try {
                    const certificateResponse = await api("/api/teacher/retooling/certificate");
                    currentCertificate = certificateResponse?.certificate || null;
                } catch (error) {
                    if (error?.message && !error.message.includes("has not been issued yet")) {
                        setStatus("teacherRetoolingStatus", error.message || "Certificate status could not be loaded.", true);
                    }
                }
            }
            renderCourse();
            setStatus("teacherRetoolingStatus", "");
        } catch (error) {
            if (getCurrentUser()?.id !== activeUserId) return;
            modules = [];
            renderCourse();
            setStatus("teacherRetoolingStatus", error.message || "Retooling modules could not be loaded.", true);
        }
    }

    function showTeacherSubview(viewId) {
        byId("teacherRetoolingHome").hidden = viewId !== "teacherRetoolingHome";
        byId("teacherRetoolingModuleView").hidden = viewId !== "teacherRetoolingModuleView";
        byId("teacherRetoolingCertificateView").hidden = viewId !== "teacherRetoolingCertificateView";
        byId("teacherRetoolingHomeHeader").hidden = viewId !== "teacherRetoolingHome";
        byId("teacherRetoolingSubviewHeader").hidden = viewId === "teacherRetoolingHome";
        if (viewId === "teacherRetoolingHome") {
            currentCertificate = null;
        }
    }

    function renderModule(module) {
        const progress = progressFor(module);
        const started = Boolean(progress.module_started_at);
        const pdfRead = isPdfRead(module);
        const quizPassed = progress.quiz_passed === true;
        const photoUploaded = progress.has_practical_photo === true;
        const questions = Array.isArray(module.quiz_questions) ? module.quiz_questions : [];
        const detail = byId("teacherRetoolingModuleBody");
        byId("teacherRetoolingSubviewTitle").textContent = `Module ${module.id}: ${module.title}`;

        const videoPanel = module.youtube_id
            ? `<iframe class="teacher-retooling-video" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(module.youtube_id)}" title="Module ${Number(module.id)} video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
            : `<div class="teacher-retooling-placeholder">The course administrator has not added a YouTube video yet.</div>`;
        const pdfPanel = module.pdf_url
            ? `<a class="teacher-retooling-link" href="${safe(module.pdf_url)}" target="_blank" rel="noopener noreferrer">Open PDF summary in a new tab</a>
               <p class="teacher-retooling-step-note">${progress.pdf_read_at ? `Reviewed ${safe(asDate(progress.pdf_read_at))}` : "Open the summary, review it, then confirm below."}</p>
               <button type="button" class="teacher-secondary" data-retooling-action="pdf-read" ${!started || progress.pdf_read_at ? "disabled" : ""}>${progress.pdf_read_at ? "PDF reviewed" : "I have reviewed the PDF"}</button>`
            : `<div class="teacher-retooling-placeholder">No PDF summary is attached to this module yet. This step will not block the quiz.</div>`;
        const quizPanel = questions.length === 5
            ? `<form id="teacherRetoolingQuizForm" class="teacher-retooling-quiz">
                ${questions.map((question, index) => `<fieldset class="teacher-retooling-question">
                    <legend>${index + 1}. ${safe(question.q)}</legend>
                    ${question.options.map((option, optionIndex) => `<label><input type="radio" name="question-${index}" value="${optionIndex}" required> <span>${safe(option)}</span></label>`).join("")}
                </fieldset>`).join("")}
                <button type="submit" class="teacher-primary" ${!started || !pdfRead ? "disabled" : ""}>Submit quiz · ${Number(module.pass_score)}% to pass</button>
            </form>`
            : `<div class="teacher-retooling-placeholder">Quiz questions are not ready yet. The course administrator must add five questions before this module can be completed.</div>`;
        const lastQuiz = progress.quiz_score === null || progress.quiz_score === undefined
            ? ""
            : `<div class="teacher-retooling-result ${quizPassed ? "is-pass" : "is-fail"}" role="status">Latest score: ${safe(progress.quiz_score)}% — ${quizPassed ? "Passed" : `Not passed. Score ${Number(module.pass_score)}% to pass; you can try again.`}</div>`;
        const practicalPanel = `<form id="teacherRetoolingPracticalForm" class="teacher-retooling-practical">
            <label for="teacherRetoolingPhoto">Upload a practical photo (PNG, JPEG, or WebP; 500 KB base64 limit)</label>
            <input id="teacherRetoolingPhoto" type="file" accept="image/png,image/jpeg,image/webp" ${quizPassed && pdfRead ? "" : "disabled"}>
            <div id="teacherRetoolingPhotoPreview" class="teacher-retooling-photo-preview" aria-live="polite">${photoUploaded ? "<span>Practical photo submitted.</span>" : ""}</div>
            <button type="submit" class="teacher-primary" ${quizPassed && pdfRead ? "" : "disabled"}>${photoUploaded ? "Replace practical photo" : "Submit practical photo"}</button>
        </form>`;

        detail.innerHTML = `<p class="teacher-retooling-description">${safe(module.description || "")}</p>
            <section class="teacher-retooling-step"><div class="teacher-retooling-step-heading"><span>01</span><div><h3>Watch the video</h3><p>${started ? "Marked as watched" : "Watch the course video, then mark it as watched."}</p></div></div>${videoPanel}<button type="button" class="teacher-primary" data-retooling-action="start" ${!module.youtube_id || started ? "disabled" : ""}>${started ? "Video marked as watched" : "Mark as watched"}</button></section>
            <section class="teacher-retooling-step"><div class="teacher-retooling-step-heading"><span>02</span><div><h3>Read the summary</h3><p>Review the module reference before you take the quiz.</p></div></div>${pdfPanel}</section>
            <section class="teacher-retooling-step"><div class="teacher-retooling-step-heading"><span>03</span><div><h3>Take the quiz</h3><p>Answer all five questions. You need ${Number(module.pass_score)}% to pass.</p></div></div>${lastQuiz}${quizPanel}</section>
            <section class="teacher-retooling-step"><div class="teacher-retooling-step-heading"><span>04</span><div><h3>Complete the practical</h3><p>Upload a photo showing your classroom application.</p></div></div>${practicalPanel}</section>
            <div id="teacherRetoolingDetailStatus" class="teacher-screen-status" role="status" aria-live="polite"></div>
            <div class="teacher-retooling-complete-note" ${module.completed ? "" : "hidden"}>Module complete.</div>`;
        practicalPhotoBase64 = "";
    }

    async function openModule(moduleId) {
        const id = Number(moduleId);
        if (!Number.isInteger(id) || id < 1 || id > 10) return;
        activeModule = null;
        practicalPhotoBase64 = "";
        showTeacherSubview("teacherRetoolingModuleView");
        byId("teacherRetoolingModuleBody").innerHTML = `<div class="teacher-empty">Loading module…</div>`;
        setStatus("teacherRetoolingDetailStatus", "");
        try {
            const response = await api(`/api/retooling-modules/${id}`);
            if (getCurrentUser()?.role !== "teacher") return;
            activeModule = response?.module || null;
            if (!activeModule) throw new Error("Module details were not returned.");
            renderModule(activeModule);
        } catch (error) {
            setStatus("teacherRetoolingDetailStatus", error.message || "Module details could not be loaded.", true);
            byId("teacherRetoolingModuleBody").innerHTML = `<div class="teacher-empty">Try again after your connection is restored.</div>`;
        }
    }

    async function refreshActiveModule() {
        if (!activeModule) return;
        const moduleId = Number(activeModule.id);
        await Promise.all([loadCourse(), openModule(moduleId)]);
    }

    function bytesFromBase64(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function pdfObjectUrl(base64) {
        return URL.createObjectURL(new Blob([bytesFromBase64(base64)], { type: "application/pdf" }));
    }

    async function openCertificate() {
        showTeacherSubview("teacherRetoolingCertificateView");
        byId("teacherRetoolingCertificateBody").innerHTML = `<div class="teacher-empty">Loading certificate…</div>`;
        setStatus("teacherRetoolingCertificateStatus", "");
        try {
            const response = await api("/api/teacher/retooling/certificate");
            currentCertificate = response?.certificate || null;
            if (!currentCertificate) throw new Error("Your certificate is not available yet.");
            const certificate = currentCertificate;
            byId("teacherRetoolingCertificateBody").innerHTML = `<div class="teacher-certificate-preview">
                ${certificate.revoked ? `<div class="teacher-retooling-result is-fail">This certificate has been revoked and is no longer valid.</div>` : ""}
                <iframe title="CPD certificate preview" src="data:application/pdf;base64,${safe(certificate.pdf_base64)}"></iframe>
                <div class="teacher-certificate-meta"><strong>${safe(certificate.certificate_number)}</strong><span>${safe(asDate(certificate.issued_at))} · ${Number(certificate.points)} CPD points</span></div>
                <div class="teacher-certificate-actions">
                    <button type="button" class="teacher-primary" data-retooling-action="download-certificate" ${certificate.revoked ? "disabled" : ""}>Download PDF</button>
                    <button type="button" class="teacher-secondary" data-retooling-action="share-certificate" ${certificate.revoked ? "disabled" : ""}>Share verification link</button>
                </div>
            </div>`;
        } catch (error) {
            setStatus("teacherRetoolingCertificateStatus", error.message || "Your certificate could not be loaded.", true);
            byId("teacherRetoolingCertificateBody").innerHTML = "";
        }
    }

    function downloadPdf(base64, filename) {
        const url = pdfObjectUrl(base64);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }

    async function handleTeacherDetailClick(event) {
        const button = event.target.closest("[data-retooling-action]");
        if (!button || !activeModule && !button.dataset.retoolingAction.endsWith("certificate")) return;
        const action = button.dataset.retoolingAction;
        if (action === "download-certificate" && currentCertificate?.pdf_base64) {
            downloadPdf(currentCertificate.pdf_base64, `${currentCertificate.certificate_number}.pdf`);
            return;
        }
        if (action === "share-certificate" && currentCertificate) {
            const url = `https://appshule.com/?verify=${encodeURIComponent(currentCertificate.certificate_number)}`;
            try {
                if (navigator.share) {
                    await navigator.share({ title: "APSHULE CPD Certificate", text: currentCertificate.certificate_number, url });
                } else if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(url);
                    notify("Verification link copied.");
                } else {
                    window.prompt("Copy this verification link:", url);
                }
            } catch (error) {
                if (error?.name !== "AbortError") notify("The verification link could not be shared.", "error");
            }
            return;
        }
        if (!activeModule) return;
        button.disabled = true;
        try {
            if (action === "start") {
                await api(`/api/teacher/retooling/${Number(activeModule.id)}/start`, { method: "POST" });
                notify("Video marked as watched.");
            } else if (action === "pdf-read") {
                await api(`/api/teacher/retooling/${Number(activeModule.id)}/pdf-read`, { method: "POST" });
                notify("PDF review recorded.");
            }
            await refreshActiveModule();
        } catch (error) {
            setStatus("teacherRetoolingDetailStatus", error.message || "This module could not be updated.", true);
            button.disabled = false;
        }
    }

    async function submitQuiz(event) {
        event.preventDefault();
        if (!activeModule) return;
        const form = event.currentTarget;
        const answers = Array.from({ length: 5 }, (_, index) => {
            const selected = form.querySelector(`input[name="question-${index}"]:checked`);
            return selected ? Number(selected.value) : null;
        });
        if (answers.some((answer) => answer === null)) {
            setStatus("teacherRetoolingDetailStatus", "Answer all five questions before submitting.", true);
            return;
        }
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setStatus("teacherRetoolingDetailStatus", "Checking your answers…");
        try {
            const response = await api(`/api/teacher/retooling/${Number(activeModule.id)}/quiz`, {
                method: "POST",
                body: { answers },
            });
            if (response?.queued) {
                setStatus(
                    "teacherRetoolingDetailStatus",
                    "Your answers are saved on this device. The quiz will be checked after your account is verified online.",
                );
                notify("Quiz answers saved on this device and waiting to sync.", "info");
                button.disabled = false;
                return;
            }
            await refreshActiveModule();
            setStatus(
                "teacherRetoolingDetailStatus",
                response.pass
                    ? `Quiz passed with ${response.score}%.`
                    : `You scored ${response.score}%. Score ${Number(activeModule.pass_score)}% to pass; try again.`,
                !response.pass,
            );
            notify(response.pass ? "Quiz passed." : "Quiz not passed yet.", response.pass ? "success" : "error");
        } catch (error) {
            setStatus("teacherRetoolingDetailStatus", error.message || "Quiz results could not be saved.", true);
            button.disabled = false;
        }
    }

    async function previewPracticalPhoto(file) {
        const preview = byId("teacherRetoolingPhotoPreview");
        preview.replaceChildren();
        practicalPhotoBase64 = "";
        if (!file) return;
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
            setStatus("teacherRetoolingDetailStatus", "Choose a PNG, JPEG, or WebP image.", true);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const value = typeof reader.result === "string" ? reader.result : "";
            if (!value.startsWith("data:image/") || value.length > MAX_PHOTO_BASE64_CHARS) {
                setStatus("teacherRetoolingDetailStatus", "This image exceeds the 500 KB base64 limit. Choose a smaller image.", true);
                return;
            }
            practicalPhotoBase64 = value;
            const image = document.createElement("img");
            image.alt = "Preview of the practical photo to submit";
            image.src = value;
            preview.append(image);
            setStatus("teacherRetoolingDetailStatus", "");
        };
        reader.onerror = () => setStatus("teacherRetoolingDetailStatus", "The selected image could not be read.", true);
        reader.readAsDataURL(file);
    }

    async function submitPractical(event) {
        event.preventDefault();
        if (!activeModule || !practicalPhotoBase64) {
            setStatus("teacherRetoolingDetailStatus", "Choose a valid photo before submitting.", true);
            return;
        }
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        setStatus("teacherRetoolingDetailStatus", "Uploading practical evidence…");
        try {
            const response = await api(`/api/teacher/retooling/${Number(activeModule.id)}/practical`, {
                method: "POST",
                body: { photo_base64: practicalPhotoBase64 },
            });
            const certificateIssued = Boolean(response?.certificate);
            await refreshActiveModule();
            if (certificateIssued) {
                notify(`Course complete. Certificate ${response.certificate.certificate_number} issued.`);
            } else {
                notify(response.completed ? "Module completed." : "Practical photo submitted.");
            }
        } catch (error) {
            setStatus("teacherRetoolingDetailStatus", error.message || "Practical evidence could not be saved.", true);
            button.disabled = false;
        }
    }

    function renderAdminModules() {
        const list = byId("ccRetoolingModulesList");
        if (!list) return;
        if (!modules.length) {
            list.innerHTML = `<div class="cc-state">No retooling modules are available.</div>`;
            return;
        }
        list.innerHTML = modules.map((module) => {
            const questionCount = Array.isArray(module.quiz_questions) ? module.quiz_questions.length : 0;
            return `<article class="cc-retooling-module">
                <div><span class="cc-retooling-module-number">MODULE ${Number(module.id)}</span><h4>${safe(module.title)}</h4><p>${safe(module.description || "No description set.")}</p><small>${questionCount === 5 ? "5 quiz questions configured" : "Quiz not ready"} · Pass score ${Number(module.pass_score)}%</small></div>
                <button type="button" class="cc-refresh" data-retooling-edit="${Number(module.id)}">Edit</button>
            </article>`;
        }).join("");
    }

    function openAdminModule(module) {
        byId("ccRetoolingModuleId").value = String(module.id);
        byId("ccRetoolingModuleEditorTitle").textContent = `Edit Module ${module.id}`;
        byId("ccRetoolingTitle").value = module.title || "";
        byId("ccRetoolingDescription").value = module.description || "";
        byId("ccRetoolingYoutube").value = module.youtube_id || "";
        byId("ccRetoolingPdf").value = module.pdf_url || "";
        byId("ccRetoolingPassScore").value = String(module.pass_score ?? 80);
        byId("ccRetoolingQuestions").value = JSON.stringify(module.quiz_questions || [], null, 2);
        byId("ccRetoolingModuleEditor").hidden = false;
        setStatus("ccRetoolingModuleEditorStatus", "");
        byId("ccRetoolingModuleEditor").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function loadAdminModules() {
        setStatus("ccRetoolingModulesStatus", "Loading modules…");
        try {
            const response = await api("/api/retooling-modules");
            modules = Array.isArray(response?.modules) ? response.modules : [];
            renderAdminModules();
            setStatus("ccRetoolingModulesStatus", "");
        } catch (error) {
            setStatus("ccRetoolingModulesStatus", error.message || "Course modules could not be loaded.", true);
        }
    }

    async function saveAdminModule(event) {
        event.preventDefault();
        const id = Number(byId("ccRetoolingModuleId").value);
        const submit = byId("ccRetoolingModuleSave");
        const statusId = "ccRetoolingModuleEditorStatus";
        let quizQuestions;
        try {
            quizQuestions = JSON.parse(byId("ccRetoolingQuestions").value);
            if (!Array.isArray(quizQuestions)) throw new Error("Quiz JSON must be an array.");
        } catch (error) {
            setStatus(statusId, error.message || "Quiz JSON is invalid.", true);
            return;
        }
        const youtubeId = byId("ccRetoolingYoutube").value.trim();
        const pdfUrl = byId("ccRetoolingPdf").value.trim();
        const body = {
            title: byId("ccRetoolingTitle").value.trim(),
            description: byId("ccRetoolingDescription").value.trim() || null,
            youtube_id: youtubeId || null,
            pdf_url: pdfUrl || null,
            pass_score: Number(byId("ccRetoolingPassScore").value),
            quiz_questions: quizQuestions,
        };
        submit.disabled = true;
        setStatus(statusId, "Saving module…");
        try {
            await api(`/api/retooling-modules/${id}`, { method: "PATCH", body });
            byId("ccRetoolingModuleEditor").hidden = true;
            notify(`Module ${id} updated.`);
            await loadAdminModules();
        } catch (error) {
            setStatus(statusId, error.message || "Module details could not be saved.", true);
        } finally {
            submit.disabled = false;
        }
    }

    function renderCertificates() {
        const body = byId("ccCpdCertificateRows");
        if (!body) return;
        if (!certificateRows.length) {
            body.innerHTML = `<tr><td colspan="5" class="cc-state">No matching certificates.</td></tr>`;
        } else {
            body.innerHTML = certificateRows.map((certificate) => `<tr>
                <td>${safe(certificate.teacher_name)}<small>${safe(certificate.teacher_email)}</small></td>
                <td>${safe(certificate.certificate_number)}</td>
                <td>${safe(asDate(certificate.issued_at))}</td>
                <td><span class="cc-retooling-cert-status ${certificate.revoked ? "is-revoked" : "is-active"}">${certificate.revoked ? "Revoked" : "Active"}</span></td>
                <td class="cc-retooling-cert-actions">
                    <button type="button" class="cc-refresh" data-cpd-view="${safe(certificate.id)}">View PDF</button>
                    ${certificate.revoked ? "" : `<button type="button" class="cc-danger" data-cpd-revoke="${safe(certificate.id)}">Revoke</button>`}
                </td>
            </tr>`).join("");
        }
        byId("ccCpdPageText").textContent = `Page ${certificatePage} of ${Math.max(certificateTotalPages, 1)}`;
        byId("ccCpdPrevious").disabled = certificatePage <= 1;
        byId("ccCpdNext").disabled = certificatePage >= certificateTotalPages;
    }

    async function loadCertificates(page = certificatePage) {
        const search = byId("ccCpdSearch").value.trim();
        const revoked = byId("ccCpdStatusFilter").value;
        const query = new URLSearchParams({ page: String(page), page_size: "20" });
        if (search) query.set("search", search);
        if (revoked !== "all") query.set("revoked", revoked);
        setStatus("ccCpdCertificatesStatus", "Loading certificates…");
        try {
            const response = await api(`/api/superadmin/cpd-certificates?${query}`);
            certificateRows = Array.isArray(response?.certificates) ? response.certificates : [];
            certificatePage = Number(response?.pagination?.page || page);
            certificateTotalPages = Number(response?.pagination?.total_pages || 0);
            renderCertificates();
            setStatus("ccCpdCertificatesStatus", "");
        } catch (error) {
            setStatus("ccCpdCertificatesStatus", error.message || "CPD certificates could not be loaded.", true);
        }
    }

    async function showAdminCertificate(id) {
        try {
            const response = await api(`/api/superadmin/cpd-certificates/${encodeURIComponent(id)}`);
            const certificate = response?.certificate;
            if (!certificate?.pdf_base64) throw new Error("Certificate PDF was not returned.");
            const dialog = byId("ccCpdPdfDialog");
            if (adminPdfObjectUrl) URL.revokeObjectURL(adminPdfObjectUrl);
            adminPdfObjectUrl = pdfObjectUrl(certificate.pdf_base64);
            byId("ccCpdPdfTitle").textContent = `${certificate.certificate_number} · ${certificate.teacher_name}`;
            byId("ccCpdPdfFrame").src = adminPdfObjectUrl;
            byId("ccCpdPdfDownload").href = adminPdfObjectUrl;
            byId("ccCpdPdfDownload").download = `${certificate.certificate_number}.pdf`;
            dialog.showModal();
        } catch (error) {
            notify(error.message || "Certificate PDF could not be opened.", "error");
        }
    }

    async function revokeCertificate(id) {
        const reason = window.prompt("Enter the reason for revoking this CPD certificate:");
        if (reason === null) return;
        if (!reason.trim()) {
            notify("A revocation reason is required.", "error");
            return;
        }
        try {
            await api(`/api/superadmin/cpd-certificates/${encodeURIComponent(id)}/revoke`, {
                method: "POST",
                body: { reason: reason.trim() },
            });
            notify("Certificate revoked. Public verification will now report it as invalid.");
            await loadCertificates();
        } catch (error) {
            notify(error.message || "The certificate could not be revoked.", "error");
        }
    }

    async function loadAdmin() {
        if (getCurrentUser()?.role !== "superadmin" || getCurrentUser()?.impersonatedBy) return;
        await Promise.all([loadAdminModules(), loadCertificates(1)]);
    }

    async function verifyFromLocation() {
        const number = new URLSearchParams(window.location.search).get("verify");
        if (!number) return false;
        const screen = byId("cpdVerifyScreen");
        if (!screen) return false;
        screen.hidden = false;
        byId("cpdVerifyNumber").textContent = number;
        byId("cpdVerifyStatus").textContent = "Checking certificate…";
        byId("cpdVerifyStatus").className = "cpd-verify-status";
        try {
            const response = await api(`/api/cpd-certificates/${encodeURIComponent(number)}/verify`, {
                auth: false,
            });
            if (response?.valid) {
                byId("cpdVerifyStatus").textContent = `Valid certificate — ${response.name} — issued ${asDate(response.issued_at)}.`;
                byId("cpdVerifyStatus").classList.add("is-valid");
            } else {
                byId("cpdVerifyStatus").textContent = "Invalid or revoked certificate.";
                byId("cpdVerifyStatus").classList.add("is-invalid");
            }
        } catch (error) {
            byId("cpdVerifyStatus").textContent = "Certificate verification is temporarily unavailable. Please try again.";
            byId("cpdVerifyStatus").classList.add("is-invalid");
        }
        return true;
    }

    byId("teacherRetoolingModules")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-teacher-module]");
        if (button) void openModule(button.dataset.teacherModule);
    });
    byId("teacherRetoolingModuleBody")?.addEventListener("click", (event) => {
        void handleTeacherDetailClick(event);
    });
    byId("teacherRetoolingModuleBody")?.addEventListener("submit", (event) => {
        if (event.target.id === "teacherRetoolingQuizForm") void submitQuiz(event);
        if (event.target.id === "teacherRetoolingPracticalForm") void submitPractical(event);
    });
    byId("teacherRetoolingModuleBody")?.addEventListener("change", (event) => {
        if (event.target.id === "teacherRetoolingPhoto") {
            void previewPracticalPhoto(event.target.files?.[0]);
        }
    });
    window.addEventListener("apshule:offline-queue-item-synced", (event) => {
        const detail = event.detail;
        const match = String(detail?.path || "").match(/^\/api\/teacher\/retooling\/(\d+)\/quiz$/u);
        if (
            !match ||
            String(detail.userId) !== String(getCurrentUser?.()?.id || "") ||
            Number(match[1]) !== Number(activeModule?.id)
        ) return;
        void refreshActiveModule();
    });
    byId("teacherRetoolingCertificateBody")?.addEventListener("click", (event) => {
        void handleTeacherDetailClick(event);
    });
    byId("teacherRetoolingViewCertificate")?.addEventListener("click", () => void openCertificate());
    byId("teacherRetoolingSubviewBack")?.addEventListener("click", () => {
        showTeacherSubview("teacherRetoolingHome");
        void loadCourse();
    });
    byId("ccRetoolingRefresh")?.addEventListener("click", () => void loadAdmin());
    byId("ccRetoolingModulesList")?.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-retooling-edit]");
        if (!button) return;
        try {
            const response = await api(`/api/retooling-modules/${Number(button.dataset.retoolingEdit)}`);
            if (response?.module) openAdminModule(response.module);
        } catch (error) {
            setStatus("ccRetoolingModulesStatus", error.message || "Module details could not be loaded.", true);
        }
    });
    byId("ccRetoolingModuleEditor")?.addEventListener("submit", saveAdminModule);
    byId("ccRetoolingModuleCancel")?.addEventListener("click", () => {
        byId("ccRetoolingModuleEditor").hidden = true;
    });
    byId("ccCpdRefresh")?.addEventListener("click", () => void loadCertificates(1));
    byId("ccCpdSearch")?.addEventListener("input", () => {
        window.clearTimeout(certificateSearchTimer);
        certificateSearchTimer = window.setTimeout(() => void loadCertificates(1), 250);
    });
    byId("ccCpdStatusFilter")?.addEventListener("change", () => void loadCertificates(1));
    byId("ccCpdPrevious")?.addEventListener("click", () => {
        if (certificatePage > 1) void loadCertificates(certificatePage - 1);
    });
    byId("ccCpdNext")?.addEventListener("click", () => {
        if (certificatePage < certificateTotalPages) void loadCertificates(certificatePage + 1);
    });
    byId("ccCpdCertificateRows")?.addEventListener("click", (event) => {
        const viewButton = event.target.closest("[data-cpd-view]");
        if (viewButton) {
            void showAdminCertificate(viewButton.dataset.cpdView);
            return;
        }
        const revokeButton = event.target.closest("[data-cpd-revoke]");
        if (revokeButton) void revokeCertificate(revokeButton.dataset.cpdRevoke);
    });
    byId("ccCpdPdfClose")?.addEventListener("click", () => byId("ccCpdPdfDialog").close());
    byId("ccCpdPdfDialog")?.addEventListener("close", () => {
        byId("ccCpdPdfFrame").src = "about:blank";
        if (adminPdfObjectUrl) URL.revokeObjectURL(adminPdfObjectUrl);
        adminPdfObjectUrl = null;
    });

    return {
        setUser(user) {
            const nextUserId = user?.id ? String(user.id) : null;
            if (activeUserId !== nextUserId) {
                activeUserId = nextUserId;
                modules = [];
                activeModule = null;
                currentCertificate = null;
                practicalPhotoBase64 = "";
                showTeacherSubview("teacherRetoolingHome");
                if (byId("teacherRetoolingModules")) renderCourse();
            }
        },
        loadCourse,
        loadAdmin,
        verifyFromLocation,
    };
}