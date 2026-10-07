export function initClinicPatientPortalUI({ api, escapeHtml, notify, host }) {
  const root = host || document.getElementById("clinicPortalPage");
  const state = {
    user: null,
    patient: null,
    organization: null,
    tab: "home",
    home: null,
    visits: [],
    prescriptions: [],
    invoices: [],
    selectedInvoice: null,
    profileError: "",
    loading: false,
    error: "",
    saving: false,
  };

  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const message = (text, type = "success") => {
    if (typeof notify === "function") notify(text, type);
  };
  const displayName = () => `${state.patient?.first_name || ""} ${state.patient?.last_name || ""}`.trim() || state.user?.name || "Patient";
  const money = (value, currency = "UGX") => {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return `${esc(currency)} ${esc(value)}`;
    try {
      return new Intl.NumberFormat("en-UG", {
        style: "currency",
        currency: /^[A-Z]{3}$/u.test(currency) ? currency : "UGX",
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${esc(currency)} ${amount.toLocaleString("en-UG")}`;
    }
  };
  const dateTime = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return esc(value);
    return new Intl.DateTimeFormat("en-UG", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Kampala",
    }).format(date);
  };
  const dateOnly = (value) => {
    if (!value) return "—";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00+03:00`);
    if (!Number.isFinite(date.getTime())) return esc(value);
    return new Intl.DateTimeFormat("en-UG", {
      dateStyle: "medium",
      timeZone: "Africa/Kampala",
    }).format(date);
  };
  const badge = (value) => {
    const status = String(value || "unknown").replaceAll("_", " ");
    return `<span class="clinic-status">${esc(status)}</span>`;
  };
  const claimStatusLabel = (value) => ({
    submitted: "pending",
    approved: "approved",
    paid: "paid",
    rejected: "rejected",
  }[String(value || "").toLowerCase()] || "not submitted");

  async function request(path, options) {
    const result = options ? await api(path, options) : await api(path);
    if (typeof Response !== "undefined" && result instanceof Response) {
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) {
        const error = new Error(payload?.error?.message || payload?.message || payload?.error || `Request failed (${result.status}).`);
        error.status = result.status;
        throw error;
      }
      return payload;
    }
    if (result && Number(result.status) >= 400) {
      const error = new Error(result.message || result.error?.message || `Request failed (${result.status}).`);
      error.status = Number(result.status);
      throw error;
    }
    return result || {};
  }

  function setBrandColor() {
    const color = String(state.organization?.brand_color || "").trim();
    if (root && /^#[0-9a-f]{6}$/iu.test(color)) {
      root.style.setProperty("--clinic-primary", color);
    }
  }

  function shell(content) {
    const logo = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/iu.test(String(state.organization?.logo_base64 || ""))
      ? state.organization.logo_base64
      : "";
    const tabs = [["home", "Home"], ["visits", "Visits"], ["prescriptions", "Prescriptions"], ["invoices", "Invoices"], ["profile", "Profile"]];
    root.innerHTML = `<section id="patientPortal" class="clinic-portal clinic-patient-portal">
      <div class="clinic-shell">
        <header class="clinic-topbar">
          <div class="clinic-brand">${logo
            ? `<img class="clinic-brand-logo" src="${esc(logo)}" alt="${esc(state.organization?.name || "Clinic")} logo">`
            : `<div class="clinic-brand-mark" aria-hidden="true">A.</div>`}
            <div><strong>${esc(state.organization?.name || "Clinic patient portal")}</strong><span>APSHULE · PATIENT PORTAL</span></div>
          </div>
          <div class="clinic-user"><div class="clinic-avatar" aria-hidden="true">${esc(displayName().split(/\s+/u).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase())}</div>
            <div><strong>${esc(displayName())}</strong><span>${esc(state.patient?.patient_number || "Patient account")}</span></div>
          </div>
        </header>
        <div class="clinic-intro"><div><p class="clinic-eyebrow">Your care</p><h1>${esc(tabs.find(([key]) => key === state.tab)?.[1] || "Patient portal")}</h1>
          <p>View your clinic records, prescriptions, and the separate patient and insurance portions of your invoices.</p></div></div>
        <nav class="clinic-nav" aria-label="Patient portal">
          ${tabs.map(([key, label]) => `<button type="button" data-patient-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${esc(label)}</button>`).join("")}
        </nav>
        <main class="clinic-view">${content}</main>
      </div>
    </section>`;
    setBrandColor();
  }

  function stateCard(title, description, retry = false) {
    return `<section class="clinic-panel"><div class="clinic-state ${retry ? "clinic-error" : ""}">
      <div class="clinic-state-mark" aria-hidden="true">${retry ? "!" : "CL"}</div>
      <strong>${esc(title)}</strong><p>${esc(description)}</p>
      ${retry ? `<button class="clinic-btn clinic-btn--quiet" type="button" data-patient-action="retry">Try again</button>` : ""}
    </div></section>`;
  }

  function invoiceSummary(invoice) {
    const currency = invoice.currency || "UGX";
    const claimStatus = claimStatusLabel(invoice.insurance_claim_status);
    return `<article class="clinic-patient-invoice">
      <div class="clinic-section-head">
        <div><h2>${esc(invoice.invoice_number || "Invoice")}</h2><p>${dateOnly(invoice.created_at)} · ${badge(invoice.status)}</p></div>
        <button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-patient-action="invoice-detail" data-id="${esc(invoice.id)}">View details</button>
      </div>
      <div class="clinic-patient-invoice-grid">
        <div><span>Your portion</span><strong>${money(invoice.patient_portion, currency)}</strong></div>
        <div><span>Paid</span><strong>${money(invoice.patient_portion_paid, currency)}</strong></div>
        <div><span>Your balance</span><strong>${money(invoice.patient_balance_due, currency)}</strong></div>
        <div><span>Insurance portion</span><strong>${money(invoice.insurance_portion, currency)}</strong></div>
      </div>
      <p class="clinic-patient-claim">Insurance claim: <strong>${esc(claimStatus)}</strong></p>
    </article>`;
  }

  function homeView() {
    if (!state.home) return stateCard("No portal profile found", "Ask your clinic to confirm that your patient account is enabled.");
    const balance = state.home.balance || {};
    const appointment = state.home.upcoming_appointment;
    const visit = state.home.recent_visit;
    const recentPrescription = state.prescriptions[0];
    const latestInvoice = state.invoices[0];
    return `<section class="clinic-metrics">
      <article class="clinic-metric"><span>Your unpaid portion</span><strong>${money(balance.patient_balance_due)}</strong></article>
      <article class="clinic-metric"><span>Insurance outstanding</span><strong>${money(balance.insurance_balance_due)}</strong></article>
      <article class="clinic-metric"><span>Total invoice balance</span><strong>${money(balance.total_balance_due)}</strong></article>
      <article class="clinic-metric"><span>Patient number</span><strong class="clinic-patient-number">${esc(state.patient?.patient_number || "—")}</strong></article>
    </section>
    <div class="clinic-dashboard-grid">
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Next appointment</h2><p>Your upcoming clinic visit.</p></div></div>
        ${appointment ? `<div class="clinic-info-grid">
          <div class="clinic-info-item"><span>Date and time</span><strong>${dateTime(appointment.scheduled_for)}</strong></div>
          <div class="clinic-info-item"><span>Status</span><strong>${esc(String(appointment.status).replaceAll("_", " "))}</strong></div>
          <div class="clinic-info-item"><span>Reason</span><strong>${esc(appointment.reason || "Not provided")}</strong></div>
        </div>` : `<div class="clinic-empty-note">No upcoming appointment is scheduled.</div>`}
      </section>
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Recent visit</h2><p>Your latest clinic record.</p></div></div>
        ${visit ? `<div class="clinic-info-grid">
          <div class="clinic-info-item"><span>Visit</span><strong>${esc(visit.visit_number || "—")}</strong></div>
          <div class="clinic-info-item"><span>Date</span><strong>${dateTime(visit.visit_started_at)}</strong></div>
          <div class="clinic-info-item"><span>Reason</span><strong>${esc(visit.chief_complaint || "Not recorded")}</strong></div>
          <div class="clinic-info-item"><span>Diagnosis</span><strong>${esc(visit.diagnosis || "Not recorded")}</strong></div>
        </div>` : `<div class="clinic-empty-note">No visits are available yet.</div>`}
      </section>
    </div>
    <div class="clinic-dashboard-grid">
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Latest prescription</h2><p>Your most recent prescription record.</p></div>
        <button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-patient-tab="prescriptions">All prescriptions</button></div>
        ${recentPrescription ? `<div class="clinic-info-grid">
          <div class="clinic-info-item"><span>Prescription</span><strong>${esc(recentPrescription.prescription_number || "—")}</strong></div>
          <div class="clinic-info-item"><span>Date and status</span><strong>${dateTime(recentPrescription.created_at)} · ${esc(String(recentPrescription.status || "").replaceAll("_", " "))}</strong></div>
          <div class="clinic-info-item clinic-span-2"><span>Medicines</span><strong>${esc((recentPrescription.items || []).map((item) => item.medicine_name).join(", ") || "No items listed")}</strong></div>
        </div>` : `<div class="clinic-empty-note">No prescriptions are available yet.</div>`}
      </section>
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Latest invoice</h2><p>Your most recent billing statement.</p></div>
        <button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-patient-tab="invoices">All invoices</button></div>
        ${latestInvoice ? `<div class="clinic-info-grid">
          <div class="clinic-info-item"><span>Invoice</span><strong>${esc(latestInvoice.invoice_number || "—")}</strong></div>
          <div class="clinic-info-item"><span>Status</span><strong>${esc(String(latestInvoice.status || "").replaceAll("_", " "))}</strong></div>
          <div class="clinic-info-item"><span>Your balance</span><strong>${money(latestInvoice.patient_balance_due, latestInvoice.currency || "UGX")}</strong></div>
          <div class="clinic-info-item"><span>Insurance claim</span><strong>${esc(claimStatusLabel(latestInvoice.insurance_claim_status))}</strong></div>
        </div>` : `<div class="clinic-empty-note">No invoices are available yet.</div>`}
      </section>
    </div>
    <section class="clinic-panel clinic-patient-quick-links"><div class="clinic-section-head"><div><h2>Quick links</h2><p>Open your records and statements.</p></div></div>
      <div class="clinic-actions">
        <button class="clinic-btn clinic-btn--quiet" type="button" data-patient-tab="visits">View visits</button>
        <button class="clinic-btn clinic-btn--quiet" type="button" data-patient-tab="prescriptions">View prescriptions</button>
        <button class="clinic-btn" type="button" data-patient-tab="invoices">View invoices</button>
      </div>
    </section>
    <section class="clinic-panel clinic-patient-insurance-card"><div class="clinic-section-head"><div><h2>Insurance details</h2><p>For your reference only. Contact clinic staff if these details need to change.</p></div></div>
      <div class="clinic-info-grid">
        <div class="clinic-info-item"><span>Provider</span><strong>${esc(state.patient?.insurance_provider_name || "None on file")}</strong></div>
        <div class="clinic-info-item"><span>Member number</span><strong>${esc(state.patient?.insurance_member_number || "—")}</strong></div>
        <div class="clinic-info-item"><span>Valid until</span><strong>${dateOnly(state.patient?.insurance_valid_until)}</strong></div>
      </div>
    </section>`;
  }

  function visitsView() {
    if (!state.visits.length) return `<section class="clinic-panel">${stateCard("No visits yet", "Your completed and current visit summaries will appear here.")}</section>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Visit history</h2><p>Only your own clinic visit summaries are shown.</p></div></div>
      <div class="clinic-patient-record-list">${state.visits.map((visit) => `<article class="clinic-subpanel">
        <div class="clinic-section-head"><div><h3>${esc(visit.visit_number || "Clinical visit")}</h3><p>${dateTime(visit.visit_started_at)} · ${badge(visit.status)}</p></div></div>
        <div class="clinic-info-grid">
          <div class="clinic-info-item"><span>Chief complaint</span><strong>${esc(visit.chief_complaint || "Not recorded")}</strong></div>
          <div class="clinic-info-item"><span>Symptoms</span><strong>${esc(visit.symptoms || "Not recorded")}</strong></div>
          <div class="clinic-info-item"><span>Diagnosis</span><strong>${esc(visit.diagnosis || "Not recorded")}</strong></div>
          <div class="clinic-info-item"><span>Treatment plan</span><strong>${esc(visit.treatment_plan || "Not recorded")}</strong></div>
          <div class="clinic-info-item"><span>Referral</span><strong>${esc(visit.referral || "None")}</strong></div>
          <div class="clinic-info-item"><span>Follow-up</span><strong>${dateOnly(visit.follow_up_date)}</strong></div>
        </div>
        ${Array.isArray(visit.prescriptions) && visit.prescriptions.length
          ? `<div class="clinic-patient-rx-list"><h4>Prescriptions</h4>${visit.prescriptions.map((rx) => `<div class="clinic-patient-rx"><strong>${esc(rx.prescription_number)} · ${esc(String(rx.status).replaceAll("_", " "))}</strong>${(rx.items || []).map((item) => `<span>${esc(item.medicine_name)} · ${esc(item.dosage)} · ${esc(item.frequency)} · ${esc(item.duration)}</span>`).join("")}</div>`).join("")}</div>`
          : ""}
      </article>`).join("")}</div></section>`;
  }

  function prescriptionsView() {
    if (!state.prescriptions.length) return `<section class="clinic-panel">${stateCard("No prescriptions yet", "Prescriptions issued to you will appear here.")}</section>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Your prescriptions</h2><p>Use the instructions given by your clinic team.</p></div></div>
      <div class="clinic-patient-record-list">${state.prescriptions.map((rx) => `<article class="clinic-subpanel">
        <div class="clinic-section-head"><div><h3>${esc(rx.prescription_number)}</h3><p>${dateTime(rx.created_at)} · ${badge(rx.status)}</p></div></div>
        ${rx.notes ? `<p class="clinic-help">${esc(rx.notes)}</p>` : ""}
        <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Medicine</th><th>Instructions</th><th>Quantity</th><th>Dispensed</th></tr></thead><tbody>
          ${(rx.items || []).map((item) => `<tr><td class="clinic-primary-cell"><strong>${esc(item.medicine_name)}</strong><span>${esc(item.dosage)}</span></td>
            <td>${esc([item.frequency, item.duration, item.route, item.instructions].filter(Boolean).join(" · ") || "—")}</td>
            <td>${esc(item.quantity)}</td><td>${esc(item.dispensed_quantity ?? 0)}</td></tr>`).join("")}
        </tbody></table></div>
      </article>`).join("")}</div></section>`;
  }

  function invoicesView() {
    if (!state.invoices.length) return `<section class="clinic-panel">${stateCard("No invoices yet", "Invoices and separate insurance claim updates will appear here.")}</section>`;
    if (state.selectedInvoice) {
      const invoice = state.selectedInvoice.invoice || {};
      const currency = invoice.currency || "UGX";
      const claimStatus = claimStatusLabel(invoice.insurance_claim_status);
      return `<section class="clinic-panel">
        <div class="clinic-section-head"><div><button type="button" class="clinic-back" data-patient-action="invoice-back">← All invoices</button><h2>${esc(invoice.invoice_number || "Invoice")}</h2><p>${dateOnly(invoice.created_at)} · ${badge(invoice.status)}</p></div></div>
        <section class="clinic-patient-invoice">
          <h3>Patient portion</h3>
          <div class="clinic-patient-invoice-grid">
            <div><span>Your portion</span><strong>${money(invoice.patient_portion, currency)}</strong></div>
            <div><span>Paid</span><strong>${money(invoice.patient_portion_paid, currency)}</strong></div>
            <div><span>Your balance</span><strong>${money(invoice.patient_balance_due, currency)}</strong></div>
          </div>
          <p class="clinic-patient-claim">Insurance claim: <strong>${esc(claimStatus)}</strong></p>
          <div class="clinic-patient-invoice-grid">
            <div><span>Insurance portion</span><strong>${money(invoice.insurance_portion, currency)}</strong></div>
            <div><span>Insurance paid</span><strong>${money(invoice.insurance_portion_paid, currency)}</strong></div>
            <div><span>Insurance balance</span><strong>${money(invoice.insurance_balance_due, currency)}</strong></div>
          </div>
        </section>
        <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>
          ${(state.selectedInvoice.items || []).map((item) => `<tr><td>${esc(item.description)}</td><td>${esc(item.quantity)}</td><td>${money(item.unit_price, currency)}</td><td>${money(item.total, currency)}</td></tr>`).join("")}
        </tbody></table></div>
        <section class="clinic-subpanel"><h3>Payments</h3>${(state.selectedInvoice.payments || []).length
          ? `<div class="clinic-patient-record-list">${state.selectedInvoice.payments.map((payment) => `<div class="clinic-info-item"><span>${esc(payment.receipt_number)} · ${dateTime(payment.paid_at)} · ${esc(payment.payment_method)}</span><strong>${money(payment.applied_amount, currency)}${payment.reversed ? " · reversed" : ""}</strong></div>`).join("")}</div>`
          : `<div class="clinic-empty-note">No payments have been recorded.</div>`}</section>
      </section>`;
    }
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Invoice statements</h2><p>Your portion and the insurer's portion are tracked separately.</p></div></div>
      <div class="clinic-patient-record-list">${state.invoices.map(invoiceSummary).join("")}</div></section>`;
  }

  function profileView() {
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Contact profile</h2><p>You can update your name and phone number. Other records are managed by clinic staff.</p></div></div>
      ${state.profileError ? `<div class="clinic-form-error" role="alert">${esc(state.profileError)}</div>` : ""}
      <form class="clinic-form-grid" data-patient-form="profile">
        <div class="clinic-field"><label for="patientProfileFirst">First name</label><input class="clinic-control" id="patientProfileFirst" name="first_name" required maxlength="100" value="${esc(state.patient?.first_name || "")}"></div>
        <div class="clinic-field"><label for="patientProfileLast">Last name</label><input class="clinic-control" id="patientProfileLast" name="last_name" required maxlength="100" value="${esc(state.patient?.last_name || "")}"></div>
        <div class="clinic-field"><label for="patientProfilePhone">Phone</label><input class="clinic-control" id="patientProfilePhone" name="phone" type="tel" maxlength="40" value="${esc(state.patient?.phone || "")}"></div>
        <div class="clinic-field"><label>Email</label><input class="clinic-control" value="${esc(state.patient?.email || "")}" disabled></div>
        <div class="clinic-span-2 clinic-actions"><button class="clinic-btn" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save contact details"}</button></div>
      </form></section>`;
  }

  function content() {
    if (state.loading) return `<section class="clinic-panel"><div class="clinic-skeleton" aria-label="Loading"><span></span><span></span><span></span><span></span></div></section>`;
    if (state.error) return stateCard("Portal data could not be loaded", state.error, true);
    if (state.tab === "home") return homeView();
    if (state.tab === "visits") return visitsView();
    if (state.tab === "prescriptions") return prescriptionsView();
    if (state.tab === "invoices") return invoicesView();
    return profileView();
  }

  function render() {
    if (!root) return;
    if (!state.user) {
      root.innerHTML = "";
      return;
    }
    shell(content());
  }

  async function loadTab(tab = state.tab) {
    state.tab = tab;
    state.loading = true;
    state.error = "";
    render();
    try {
      const mePayload = await request("/api/clinic-patient/me");
      state.patient = mePayload.patient || null;
      state.organization = mePayload.organization || null;
      state.home = mePayload;
      if (tab === "visits") {
        const payload = await request("/api/clinic-patient/me/visits");
        state.visits = Array.isArray(payload.visits) ? payload.visits : [];
      } else if (tab === "prescriptions") {
        const payload = await request("/api/clinic-patient/me/prescriptions");
        state.prescriptions = Array.isArray(payload.prescriptions) ? payload.prescriptions : [];
      } else if (tab === "invoices") {
        if (!state.selectedInvoice) {
          const payload = await request("/api/clinic-patient/me/invoices");
          state.invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
        }
      } else if (tab === "home") {
        const [prescriptionsPayload, invoicesPayload] = await Promise.all([
          request("/api/clinic-patient/me/prescriptions"),
          request("/api/clinic-patient/me/invoices"),
        ]);
        state.prescriptions = Array.isArray(prescriptionsPayload.prescriptions) ? prescriptionsPayload.prescriptions : [];
        state.invoices = Array.isArray(invoicesPayload.invoices) ? invoicesPayload.invoices : [];
      }
    } catch (error) {
      state.error = error?.message || "Your portal records could not be loaded.";
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openInvoice(id) {
    state.loading = true;
    state.error = "";
    render();
    try {
      state.selectedInvoice = await request(`/api/clinic-patient/me/invoices/${encodeURIComponent(id)}`);
    } catch (error) {
      state.error = error?.message || "Invoice details could not be loaded.";
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveProfile(form) {
    state.saving = true;
    state.profileError = "";
    render();
    try {
      const data = new FormData(form);
      const payload = await request("/api/clinic-patient/me", {
        method: "PATCH",
        body: {
          first_name: String(data.get("first_name") || "").trim(),
          last_name: String(data.get("last_name") || "").trim(),
          phone: String(data.get("phone") || "").trim(),
        },
      });
      state.patient = { ...state.patient, ...payload.patient };
      message("Your contact details were updated.");
    } catch (error) {
      state.profileError = error?.message || "Your profile could not be updated.";
      message(state.profileError, "error");
    } finally {
      state.saving = false;
      render();
    }
  }

  root?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-patient-tab]");
    if (tab) {
      state.selectedInvoice = null;
      void loadTab(tab.dataset.patientTab);
      return;
    }
    const action = event.target.closest("[data-patient-action]");
    if (!action) return;
    if (action.dataset.patientAction === "retry") void loadTab(state.tab);
    if (action.dataset.patientAction === "invoice-back") {
      state.selectedInvoice = null;
      void loadTab("invoices");
    }
    if (action.dataset.patientAction === "invoice-detail") void openInvoice(action.dataset.id);
  });
  root?.addEventListener("submit", (event) => {
    const form = event.target.closest('[data-patient-form="profile"]');
    if (!form) return;
    event.preventDefault();
    void saveProfile(form);
  });

  async function setUser(user) {
    state.user = user || null;
    state.patient = null;
    state.organization = null;
    state.home = null;
    state.visits = [];
    state.prescriptions = [];
    state.invoices = [];
    state.selectedInvoice = null;
    state.error = "";
    state.profileError = "";
    state.tab = "home";
    if (!user || user.role !== "patient" || user.sector !== "clinic") {
      render();
      return;
    }
    await loadTab("home");
  }

  return { setUser, loadTab, render };
}

export default initClinicPatientPortalUI;
