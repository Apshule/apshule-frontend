const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

export function initSchoolAdminAiAccess({ api, getCurrentUser, notify, escapeHtml = esc }) {
  const panelHost = document.getElementById("adminPanel");
  if (!panelHost) return { setUser() {} };
  let panel = panelHost.querySelector("#schoolAiAccess");
  let overlayOpen = false;
  let entryButton = panelHost.querySelector("#schoolAiQuickAccess");
  if (!entryButton) {
    entryButton = document.createElement("button");
    entryButton.id = "schoolAiQuickAccess";
    entryButton.type = "button";
    entryButton.className = "cc6-button";
    entryButton.textContent = "🤖 Grant AI to My Students";
    panelHost.prepend(entryButton);
  }
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "schoolAiAccess";
    panel.className = "admin-card";
    panel.innerHTML = `<h3>🤖 AI Access</h3>
      <div class="cc6-grid" id="schoolAiStats"></div>
      <div class="cc6-toolbar">
        <select id="schoolAiClass" class="cc6-field"><option value="">Choose class</option>${["S1","S2","S3","S4","S5","S6","P1","P2","P3","P4","P5","P6","P7"].map(x=>`<option>${x}</option>`).join("")}</select>
        <button class="cc6-button" type="button" data-ai-class>Grant Student Pro to Class · 30 days</button>
        <button class="cc6-button secondary" type="button" data-ai-all>Grant Student Pro to All · 30 days</button>
      </div>
      <div class="cc6-toolbar"><input id="schoolAiSearch" class="cc6-field" type="search" placeholder="Search student name or email"><button class="cc6-button secondary" type="button" data-ai-refresh>Refresh</button></div>
      <div id="schoolAiStudents" class="cc6-table-wrap"></div>`;
    panelHost.prepend(panel);
  }
  panelHost.prepend(entryButton);
  let closeButton = panel.querySelector("[data-school-ai-close]");
  if (!closeButton) {
    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.dataset.schoolAiClose = "true";
    closeButton.className = "cc6-button secondary";
    closeButton.textContent = "✕ Close";
    panel.prepend(closeButton);
  }
  entryButton.addEventListener("click", () => { overlayOpen = true; void refresh(); });
  closeButton.addEventListener("click", () => { overlayOpen = false; panel.hidden = true; panel.style.cssText = ""; });
  panel.style.cssText = "position:fixed;inset:0;z-index:9999;overflow-y:auto;background:#f5f5f5;border-radius:0;margin:0;padding:16px";
  let students = [];
  const showError = (e) => notify?.(e?.message || "AI access could not be loaded.", "error");
  const render = () => {
    const q = panel.querySelector("#schoolAiSearch").value.trim().toLowerCase();
    const rows = students.filter(s => `${s.name} ${s.email}`.toLowerCase().includes(q));
    panel.querySelector("#schoolAiStudents").innerHTML = `<table><thead><tr><th>Name</th><th>Class</th><th>Tier</th><th>Used Today</th><th>Limit</th><th>Expires</th><th>Actions</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${escapeHtml(s.name)}<br>${escapeHtml(s.email)}</td><td>${escapeHtml(s.class_level||"—")}</td><td>${escapeHtml(s.tier)}</td><td>${s.used_today}</td><td>${s.daily_limit}</td><td>${escapeHtml(s.ai_tier_expires_at||"—")}</td><td><button class="cc6-button small" data-grant="${escapeHtml(s.email)}">Grant / Extend</button> <button class="cc6-button secondary small" data-revoke="${escapeHtml(s.email)}">Revoke</button></td></tr>`).join("")||'<tr><td colspan="7">No students found.</td></tr>'}</tbody></table>`;
  };
  const refresh = async () => {
    const isSchoolAdmin = getCurrentUser()?.role === "school";
    entryButton.hidden = !isSchoolAdmin;
    if (!isSchoolAdmin || !overlayOpen) { panel.hidden = true; return; }
    panel.hidden = false;
    try {
      const [stats, data] = await Promise.all([api("/api/school-admin/ai-tiers/stats"), api("/api/school-admin/ai-tiers/students")]);
      students = data.students || [];
      panel.querySelector("#schoolAiStats").innerHTML = [["Students on Free",stats.free],["Student Pro",stats.student_pro],["Requests Today",stats.requests_today],["School Plan",stats.school_plan_expires_at?`Active · ${stats.school_plan_expires_at}`:"No"]].map(([k,v])=>`<article class="cc6-card"><div>${escapeHtml(k)}</div><strong>${escapeHtml(v)}</strong></article>`).join("");
      render();
    } catch(e) { showError(e); }
  };
  panel.addEventListener("input", e => { if (e.target.id === "schoolAiSearch") render(); });
  panel.addEventListener("click", async e => {
    const b=e.target.closest("button"); if(!b)return;
    try {
      if(b.hasAttribute("data-ai-refresh")) return void refresh();
      if(b.hasAttribute("data-ai-class")) {
        const class_level=panel.querySelector("#schoolAiClass").value;if(!class_level)throw new Error("Choose a class first.");
        await api("/api/school-admin/ai-tiers/grant-class",{method:"POST",body:{class_level,duration_days:30,reason:`School admin class grant: ${class_level}`}});
      } else if(b.hasAttribute("data-ai-all")) {
        if(!confirm("Grant Student Pro to every student in your school for 30 days?"))return;
        await api("/api/school-admin/ai-tiers/grant-class",{method:"POST",body:{class_level:"ALL",duration_days:30,reason:"School admin bulk grant"}});
      } else if(b.hasAttribute("data-grant")) {
        await api("/api/school-admin/ai-tiers/grant-student",{method:"POST",body:{student_email:b.dataset.grant,duration_days:30,reason:"School admin grant"}});
      } else if(b.hasAttribute("data-revoke")) {
        if(!confirm(`Revoke AI access for ${b.dataset.revoke}?`))return;
        await api("/api/school-admin/ai-tiers/revoke-student",{method:"POST",body:{student_email:b.dataset.revoke,reason:"School admin revocation"}});
      } else return;
      notify?.("AI access updated.","success"); await refresh();
    } catch(error) { showError(error); }
  });
  return { setUser: refresh };
}
