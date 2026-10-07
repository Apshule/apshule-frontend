export function initClinicBillingUI({
  api,
  getCurrentUser,
  escapeHtml,
  notify,
  host,
  reload = () => {},
  getPatient = () => null,
}) {
  const root = host || document.getElementById("clinicPortalPage");
  const state = {
    tab: "billing",
    stats: {},
    invoices: [],
    services: [],
    providers: [],
    claims: [],
    patients: [],
    visits: [],
    invoice: null,
    modal: null,
    formValues: {},
    items: [],
    filters: { status: "", patient_id: "", from: "", to: "" },
    panel: "invoices",
    loading: false,
    error: "",
    providersLoaded: false,
    servicesLoaded: false,
  };

  const role = () => String(getCurrentUser()?.role || "").toLowerCase();
  const isAdmin = () => role() === "clinic_admin";
  const canRecordPayment = () => isAdmin() || role() === "receptionist";
  const canManageInvoices = () => ["clinic_admin", "receptionist", "nurse"].includes(role());
  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const message = (text, type = "success") => {
    if (typeof notify === "function") notify(text, type);
  };
  const patientName = (patient) => `${patient?.first_name || ""} ${patient?.last_name || ""}`.trim() || "Patient";
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
  const date = (value) => {
    if (!value) return "—";
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return esc(value);
    return new Intl.DateTimeFormat("en-UG", {
      dateStyle: "medium",
      timeZone: "Africa/Kampala",
    }).format(parsed);
  };
  const dateTime = (value) => {
    if (!value) return "—";
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return esc(value);
    return new Intl.DateTimeFormat("en-UG", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Kampala",
    }).format(parsed);
  };
  const statusLabel = (value) => String(value || "unknown").replaceAll("_", " ");
  const badge = (value) => `<span class="clinic-status">${esc(statusLabel(value))}</span>`;

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

  const selectedPatient = () => {
    const id = state.modal?.patientId || getPatient()?.id;
    return state.patients.find((patient) => String(patient.id) === String(id)) ||
      (String(getPatient()?.id) === String(id) ? getPatient() : null);
  };

  async function loadProviders(force = false) {
    if (state.providersLoaded && !force) return;
    const payload = await request("/api/clinic/insurance-providers");
    state.providers = Array.isArray(payload.providers) ? payload.providers : [];
    state.providersLoaded = true;
  }

  async function loadServices(force = false) {
    if (state.servicesLoaded && !force) return;
    const payload = await request("/api/clinic/services?include_inactive=true");
    state.services = Array.isArray(payload.services) ? payload.services : [];
    state.servicesLoaded = true;
  }

  async function loadPatients() {
    const payload = await request("/api/clinic/patients?status=active&limit=200");
    state.patients = Array.isArray(payload.patients) ? payload.patients : [];
  }

  async function loadTab(tab = state.tab) {
    state.tab = tab;
    state.loading = true;
    state.error = "";
    try {
      if (tab === "billing") {
        const query = new URLSearchParams();
        if (state.filters.status) query.set("status", state.filters.status);
        if (state.filters.patient_id) query.set("patient_id", state.filters.patient_id);
        if (state.filters.from) query.set("from", state.filters.from);
        if (state.filters.to) query.set("to", state.filters.to);
        const qs = query.toString();
        const [statsPayload, invoicePayload, patientsPayload] = await Promise.all([
          request("/api/clinic/billing/stats"),
          request(`/api/clinic/invoices${qs ? `?${qs}` : ""}`),
          request("/api/clinic/patients?status=active&limit=200"),
        ]);
        state.stats = statsPayload.stats || {};
        state.invoices = Array.isArray(invoicePayload.invoices) ? invoicePayload.invoices : [];
        state.patients = Array.isArray(patientsPayload.patients) ? patientsPayload.patients : [];
        await loadServices();
      } else if (tab === "insurance") {
        const [providersPayload, claimsPayload] = await Promise.all([
          request("/api/clinic/insurance-providers?include_inactive=true"),
          request("/api/clinic/claims"),
        ]);
        state.providers = Array.isArray(providersPayload.providers) ? providersPayload.providers : [];
        state.claims = Array.isArray(claimsPayload.claims) ? claimsPayload.claims : [];
        state.providersLoaded = true;
      }
    } catch (error) {
      state.error = error?.message || "Billing data could not be loaded.";
    } finally {
      state.loading = false;
      renderShell();
    }
  }

  function renderStats() {
    const stats = state.stats || {};
    return `<section class="clinic-metrics clinic-billing-metrics">
      <article class="clinic-metric"><span>Invoices today</span><strong>${esc(stats.invoices_today ?? 0)}</strong></article>
      <article class="clinic-metric"><span>Collected today</span><strong class="clinic-metric-money">${money(stats.collected_today)}</strong></article>
      <article class="clinic-metric"><span>Outstanding</span><strong class="clinic-metric-money">${money(stats.outstanding_total)}</strong></article>
      <article class="clinic-metric"><span>Pending claims</span><strong>${esc(stats.pending_claims ?? 0)}</strong></article>
    </section>`;
  }

  function invoiceRows(invoices) {
    return invoices.length ? invoices.map((invoice) => `<tr data-billing-action="view-invoice" data-id="${esc(invoice.id)}" tabindex="0" role="button" aria-label="View invoice ${esc(invoice.invoice_number)}">
      <td class="clinic-primary-cell"><strong>${esc(invoice.invoice_number)}</strong><span>${date(invoice.created_at)}</span></td>
      <td class="clinic-primary-cell"><strong>${esc(invoice.patient_name || "Patient")}</strong><span>${esc(invoice.patient_number || "")}</span></td>
      <td>${money(invoice.total, invoice.currency)}</td>
      <td>${money(invoice.amount_paid, invoice.currency)}</td>
      <td><strong>${money(invoice.balance_due, invoice.currency)}</strong></td>
      <td>${badge(invoice.status)}</td>
      <td><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="view-invoice" data-id="${esc(invoice.id)}">Details</button></td>
    </tr>`).join("") : `<tr><td colspan="7"><div class="clinic-empty-note">No invoices match these filters.</div></td></tr>`;
  }

  function invoicesPanel() {
    const activePatients = state.patients.filter((patient) => patient.status === "active");
    return `<section class="clinic-panel">
      <div class="clinic-section-head"><div><h2>Clinic invoices</h2><p>Patient and insurance balances are tracked separately.</p></div>
        ${canManageInvoices() ? `<button class="clinic-btn" type="button" data-billing-action="new-invoice">+ New invoice</button>` : ""}
      </div>
      ${renderStats()}
      <form class="clinic-toolbar clinic-filter-toolbar" data-billing-form="filters">
        <label class="clinic-field"><span>Status</span><select class="clinic-control" name="status">
          ${[["", "All statuses"], ["draft", "Draft"], ["issued", "Issued"], ["partial", "Partial"], ["patient_settled", "Patient settled"], ["insurance_settled", "Insurance settled"], ["paid", "Paid"], ["cancelled", "Cancelled"]].map(([value, label]) => `<option value="${value}" ${state.filters.status === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></label>
        <label class="clinic-field"><span>Patient</span><select class="clinic-control" name="patient_id"><option value="">All patients</option>
          ${activePatients.map((patient) => `<option value="${esc(patient.id)}" ${String(state.filters.patient_id) === String(patient.id) ? "selected" : ""}>${esc(patient.patient_number)} · ${esc(patientName(patient))}</option>`).join("")}
        </select></label>
        <label class="clinic-field"><span>From</span><input class="clinic-control" type="date" name="from" value="${esc(state.filters.from)}"></label>
        <label class="clinic-field"><span>To</span><input class="clinic-control" type="date" name="to" value="${esc(state.filters.to)}"></label>
        <button class="clinic-btn clinic-btn--quiet" type="submit">Filter</button>
      </form>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Invoice #</th><th>Patient</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead><tbody>${invoiceRows(state.invoices)}</tbody></table></div>
    </section>
    ${servicePanel()}`;
  }

  function servicePanel() {
    return `<section class="clinic-panel clinic-billing-subpanel"><div class="clinic-section-head"><div><h2>Services</h2><p>Maintain consultation, procedure, and other billable services.</p></div>
      ${isAdmin() ? `<button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="new-service">+ Add service</button>` : ""}
    </div>
    <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Code</th><th>Service</th><th>Category</th><th>Price</th><th>Status</th>${isAdmin() ? "<th>Actions</th>" : ""}</tr></thead><tbody>
      ${state.services.length ? state.services.map((service) => `<tr>
        <td>${esc(service.code)}</td><td><strong>${esc(service.name)}</strong></td><td>${esc(service.category || "—")}</td>
        <td>${money(service.price)}</td><td>${badge(service.active ? "active" : "inactive")}</td>
        ${isAdmin() ? `<td><div class="clinic-row-actions"><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="edit-service" data-id="${esc(service.id)}">Edit</button>${service.active ? `<button class="clinic-btn clinic-btn--danger clinic-btn--small" type="button" data-billing-action="deactivate-service" data-id="${esc(service.id)}">Deactivate</button>` : ""}</div></td>` : ""}
      </tr>`).join("") : `<tr><td colspan="${isAdmin() ? 6 : 5}"><div class="clinic-empty-note">Add billable services to use them on invoices.</div></td></tr>`}
    </tbody></table></div></section>`;
  }

  function insurancePanel() {
    return `<div class="clinic-dashboard-grid clinic-insurance-layout">
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Insurance providers</h2><p>Coverage rates are applied when invoices are issued.</p></div>
        ${isAdmin() ? `<button class="clinic-btn" type="button" data-billing-action="new-provider">+ Add provider</button>` : ""}
      </div>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Provider</th><th>Code</th><th>Coverage</th><th>Contact</th><th>Status</th>${isAdmin() ? "<th>Actions</th>" : ""}</tr></thead><tbody>
        ${state.providers.length ? state.providers.map((provider) => `<tr>
          <td><strong>${esc(provider.name)}</strong></td><td>${esc(provider.code || "—")}</td><td>${esc(provider.coverage_percent)}%</td>
          <td>${esc(provider.phone || provider.email || "—")}</td><td>${badge(provider.active ? "active" : "inactive")}</td>
          ${isAdmin() ? `<td><div class="clinic-row-actions"><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="edit-provider" data-id="${esc(provider.id)}">Edit</button>${provider.active ? `<button class="clinic-btn clinic-btn--danger clinic-btn--small" type="button" data-billing-action="deactivate-provider" data-id="${esc(provider.id)}">Deactivate</button>` : ""}</div></td>` : ""}
        </tr>`).join("") : `<tr><td colspan="${isAdmin() ? 6 : 5}"><div class="clinic-empty-note">No insurance providers have been added.</div></td></tr>`}
      </tbody></table></div></section>
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Claims</h2><p>${state.claims.length} insurance claim records.</p></div></div>
        <div class="clinic-patient-record-list">${state.claims.length ? state.claims.map((claim) => claimCard(claim)).join("") : `<div class="clinic-empty-note">Claims submitted for invoices will appear here.</div>`}</div>
      </section>
    </div>`;
  }

  function claimCard(claim) {
    const currency = claim.currency || "UGX";
    return `<article class="clinic-subpanel clinic-claim-card">
      <div class="clinic-section-head"><div><h3>${esc(claim.claim_number)}</h3><p>${esc(claim.invoice_number)} · ${esc(claim.patient_name || claim.patient_number || "Patient")}</p></div>${badge(claim.status)}</div>
      <div class="clinic-info-grid">
        <div class="clinic-info-item"><span>Provider</span><strong>${esc(claim.provider_name || "—")}</strong></div>
        <div class="clinic-info-item"><span>Claimed</span><strong>${money(claim.claim_amount, currency)}</strong></div>
        <div class="clinic-info-item"><span>Approved</span><strong>${money(claim.approved_amount, currency)}</strong></div>
        <div class="clinic-info-item"><span>Submitted</span><strong>${date(claim.submitted_at)}</strong></div>
      </div>
      ${claim.rejection_reason ? `<p class="clinic-form-error">${esc(claim.rejection_reason)}</p>` : ""}
      ${isAdmin() && ["submitted", "approved"].includes(claim.status) ? `<div class="clinic-actions">
        ${claim.status === "submitted" ? `<button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="claim-approve" data-id="${esc(claim.id)}">Mark approved</button>` : ""}
        ${claim.status === "approved" ? `<button class="clinic-btn clinic-btn--small" type="button" data-billing-action="claim-paid" data-id="${esc(claim.id)}">Mark paid</button>` : ""}
        <button class="clinic-btn clinic-btn--danger clinic-btn--small" type="button" data-billing-action="claim-reject" data-id="${esc(claim.id)}">Reject</button>
      </div>` : ""}
    </article>`;
  }

  function tabMarkup(tab) {
    if (state.loading) return `<section class="clinic-panel"><div class="clinic-skeleton"><span></span><span></span><span></span><span></span></div></section>`;
    if (state.error) return `<section class="clinic-panel"><div class="clinic-state clinic-error"><div class="clinic-state-mark">!</div><strong>Billing view unavailable</strong><p>${esc(state.error)}</p><button type="button" class="clinic-btn clinic-btn--quiet" data-billing-action="retry">Try again</button></div></section>`;
    if (tab === "insurance") return insurancePanel();
    return invoicesPanel();
  }

  function renderTab(tab) {
    return tabMarkup(tab);
  }

  function itemMarkup(item, index) {
    const serviceId = item.reference_id && item.item_type === "service" ? item.reference_id : "";
    return `<div class="clinic-billing-item" data-item-index="${index}">
      <label class="clinic-field"><span>Type</span><select class="clinic-control" data-item-field="item_type" data-index="${index}">
        ${["consultation", "prescription", "service"].map((type) => `<option value="${type}" ${item.item_type === type ? "selected" : ""}>${type[0].toUpperCase()}${type.slice(1)}</option>`).join("")}
      </select></label>
      <label class="clinic-field"><span>Catalog service</span><select class="clinic-control" data-item-service data-index="${index}">
        <option value="">Manual item</option>${state.services.filter((service) => service.active).map((service) => `<option value="${esc(service.id)}" ${String(serviceId) === String(service.id) ? "selected" : ""}>${esc(service.name)} · ${money(service.price)}</option>`).join("")}
      </select></label>
      <label class="clinic-field clinic-billing-item-description"><span>Description</span><input class="clinic-control" data-item-field="description" data-index="${index}" maxlength="300" required value="${esc(item.description || "")}"></label>
      <label class="clinic-field"><span>Qty</span><input class="clinic-control" data-item-field="quantity" data-index="${index}" type="number" min="0.001" step="0.001" value="${esc(item.quantity ?? 1)}"></label>
      <label class="clinic-field"><span>Unit price</span><input class="clinic-control" data-item-field="unit_price" data-index="${index}" type="number" min="0" step="0.01" value="${esc(item.unit_price || "")}"></label>
      <div class="clinic-billing-item-total"><span>Line total</span><strong data-item-total="${index}">${money(Number(item.quantity || 1) * Number(item.unit_price || 0))}</strong></div>
      <button class="clinic-btn clinic-btn--danger clinic-btn--small" type="button" data-billing-action="remove-item" data-index="${index}" aria-label="Remove item">Remove</button>
    </div>`;
  }

  function modalMarkup() {
    const modal = state.modal;
    if (!modal) return "";
    const error = state.modalError ? `<div class="clinic-form-error clinic-span-2" role="alert">${esc(state.modalError)}</div>` : "";
    if (modal.type === "portal-access") {
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">Create patient portal access</h2><p>${esc(patientName(modal.patient))} · The password is never emailed or shown again.</p></div><button type="button" class="clinic-close" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="portal-access">
          ${error}<label class="clinic-field clinic-span-2"><span>Patient login email</span><input class="clinic-control" type="email" name="email" required maxlength="254" value="${esc(modal.patient?.email || "")}"></label>
          <label class="clinic-field clinic-span-2"><span>Temporary password</span><input class="clinic-control" type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"><small class="clinic-help">Use at least 8 characters. Give it to the patient securely; the welcome email will not contain it.</small></label>
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="close-modal">Cancel</button><button class="clinic-btn" type="submit">Create portal access</button></div>
        </form>
      </section></div>`;
    }
    if (modal.type === "invoice") {
      const patients = state.patients.length ? state.patients : (modal.patient ? [modal.patient] : []);
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal clinic-billing-invoice-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">New invoice</h2><p>Amounts are split into patient and insurer portions when issued.</p></div><button type="button" class="clinic-close" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="invoice">
          ${error}
          <label class="clinic-field clinic-span-2"><span>Patient</span><select class="clinic-control" name="patient_id" required>
            <option value="">Choose a patient</option>${patients.map((patient) => `<option value="${esc(patient.id)}" ${String(modal.patientId || modal.patient?.id) === String(patient.id) ? "selected" : ""}>${esc(patient.patient_number || "")} · ${esc(patientName(patient))}</option>`).join("")}
          </select></label>
          <label class="clinic-field clinic-span-2"><span>Visit (optional)</span><select class="clinic-control" name="visit_id">
            <option value="">No visit linked</option>${state.visits.map((visit) => `<option value="${esc(visit.id)}" ${String(modal.visitId || "") === String(visit.id) ? "selected" : ""}>${esc(visit.visit_number)} · ${date(visit.visit_started_at)} · ${esc(visit.chief_complaint || "Visit")}</option>`).join("")}
          </select><small class="clinic-help">Selecting a visit can add its consultation fee and prescription items as suggestions.</small></label>
          <div class="clinic-form-section clinic-span-2">Invoice items</div>
          <div class="clinic-billing-items clinic-span-2">${state.items.map(itemMarkup).join("")}</div>
          <div class="clinic-span-2"><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="add-item">+ Add item</button></div>
          <label class="clinic-field"><span>Discount</span><input class="clinic-control" type="number" name="discount" min="0" step="0.01" value="${esc(state.formValues.discount || "0")}"></label>
          <label class="clinic-field"><span>Due date</span><input class="clinic-control" type="date" name="due_date" value="${esc(state.formValues.due_date || "")}"></label>
          <label class="clinic-field clinic-span-2"><span>Notes</span><textarea class="clinic-control" name="notes" maxlength="4000">${esc(state.formValues.notes || "")}</textarea></label>
          <div class="clinic-billing-total-preview clinic-span-2"><span>Invoice total before insurance</span><strong data-billing-total>${calculateItemsTotal()}</strong></div>
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="save-draft">Save draft</button><button class="clinic-btn" type="submit">Issue invoice</button></div>
        </form>
      </section></div>`;
    }
    if (modal.type === "invoice-detail") return invoiceDetailMarkup();
    if (modal.type === "edit-invoice") {
      const invoice = modal.invoice || {};
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">Edit ${esc(invoice.invoice_number)}</h2><p>Invoices with any payment are locked from financial edits.</p></div><button class="clinic-close" type="button" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="edit-invoice" data-id="${esc(invoice.id)}">
          ${error}
          <label class="clinic-field"><span>Discount</span><input class="clinic-control" type="number" name="discount" min="0" step="0.01" required value="${esc(invoice.discount || 0)}"></label>
          <label class="clinic-field"><span>Due date</span><input class="clinic-control" type="date" name="due_date" value="${esc(String(invoice.due_date || "").slice(0, 10))}"></label>
          <label class="clinic-field"><span>Status</span><select class="clinic-control" name="status"><option value="draft" ${invoice.status === "draft" ? "selected" : ""}>Draft</option><option value="issued" ${invoice.status === "issued" ? "selected" : ""}>Issued</option></select></label>
          <label class="clinic-field clinic-span-2"><span>Notes</span><textarea class="clinic-control" name="notes" maxlength="4000">${esc(invoice.notes || "")}</textarea></label>
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="close-modal">Cancel</button><button class="clinic-btn" type="submit">Save invoice</button></div>
        </form>
      </section></div>`;
    }
    if (modal.type === "payment") {
      const invoice = modal.invoice?.invoice || modal.invoice || {};
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">Record payment</h2><p>${esc(invoice.invoice_number)} · Remaining: ${money(invoice.balance_due, invoice.currency)}</p></div><button class="clinic-close" type="button" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="payment">
          ${error}
          <label class="clinic-field"><span>Payment amount</span><input class="clinic-control" type="number" name="amount" min="0.01" max="${esc(invoice.balance_due || 0)}" step="0.01" required value="${esc(invoice.balance_due || "")}"></label>
          <label class="clinic-field"><span>Method</span><select class="clinic-control" name="payment_method"><option value="cash">Cash · patient</option><option value="momo">Mobile money · patient</option><option value="bank">Bank · patient</option><option value="insurance">Insurance payment</option></select></label>
          <label class="clinic-field clinic-span-2"><span>Reference</span><input class="clinic-control" name="payment_reference" maxlength="200"></label>
          <label class="clinic-field clinic-span-2"><span>Notes</span><textarea class="clinic-control" name="notes" maxlength="2000"></textarea></label>
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="close-modal">Cancel</button><button class="clinic-btn" type="submit">Record payment</button></div>
        </form>
      </section></div>`;
    }
    if (modal.type === "service" || modal.type === "provider") {
      const isService = modal.type === "service";
      const record = modal.record || {};
      const fields = isService
        ? [["code", "Code"], ["name", "Service name"], ["category", "Category"], ["price", "Price"]]
        : [["code", "Code"], ["name", "Provider name"], ["contact_person", "Contact person"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"], ["coverage_percent", "Coverage percent"]];
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">${modal.record ? "Edit" : "Add"} ${isService ? "service" : "insurance provider"}</h2><p>${isService ? "Service prices are copied to new invoice line items." : "The coverage percentage is applied to the invoice subtotal."}</p></div><button class="clinic-close" type="button" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="${isService ? "service" : "provider"}" data-id="${esc(record.id || "")}">
          ${error}
          ${fields.map(([name, label]) => `<label class="clinic-field ${name === "address" ? "clinic-span-2" : ""}"><span>${label}</span><input class="clinic-control" name="${name}" ${name === "email" ? 'type="email"' : name === "price" || name === "coverage_percent" ? 'type="number" step="0.01" min="0"' : ""} ${name === "coverage_percent" ? 'max="100"' : ""} value="${esc(record[name] ?? (name === "coverage_percent" ? "80" : ""))}" ${name === "name" || (isService && name === "code") ? "required" : ""}></label>`).join("")}
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="close-modal">Cancel</button><button class="clinic-btn" type="submit">Save</button></div>
        </form>
      </section></div>`;
    }
    if (modal.type === "claim-update") {
      return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
        <div class="clinic-modal-head"><div><h2 id="billingModalTitle">${modal.status === "rejected" ? "Reject claim" : modal.status === "paid" ? "Mark claim paid" : "Approve claim"}</h2><p>${esc(modal.claim?.claim_number)} · Claimed ${money(modal.claim?.claim_amount)}</p></div><button class="clinic-close" type="button" data-billing-action="close-modal" aria-label="Close">×</button></div>
        <form class="clinic-modal-body clinic-form-grid" data-billing-form="claim-update" data-id="${esc(modal.claim?.id)}" data-status="${esc(modal.status)}">
          ${error}
          ${modal.status !== "rejected" ? `<label class="clinic-field"><span>Approved amount</span><input class="clinic-control" name="approved_amount" type="number" min="0.01" step="0.01" required value="${esc(modal.claim?.approved_amount || modal.claim?.claim_amount || "")}"></label>` : ""}
          ${modal.status === "rejected" ? `<label class="clinic-field clinic-span-2"><span>Reason</span><textarea class="clinic-control" name="rejection_reason" required minlength="5"></textarea></label>` : ""}
          <div class="clinic-span-2 clinic-modal-foot"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="close-modal">Cancel</button><button class="clinic-btn ${modal.status === "rejected" ? "clinic-btn--danger" : ""}" type="submit">${modal.status === "rejected" ? "Reject claim" : modal.status === "paid" ? "Record insurer payment" : "Approve claim"}</button></div>
        </form>
      </section></div>`;
    }
    return "";
  }

  function calculateItemsTotal() {
    const subtotal = state.items.reduce((total, item) => total + Number(item.quantity || 0) * Number(item.unit_price || 0), 0);
    const discount = Number(state.formValues.discount || 0);
    return money(Math.max(0, subtotal - (Number.isFinite(discount) ? discount : 0)));
  }

  function invoiceDetailMarkup() {
    const result = state.invoice || {};
    const invoice = result.invoice || {};
    const currency = invoice.currency || "UGX";
    const payments = result.payments || [];
    const claims = result.claims || [];
    const canCancel = isAdmin() && !["paid", "cancelled", "partial", "patient_settled", "insurance_settled"].includes(invoice.status) && Number(invoice.amount_paid || 0) === 0;
    const canClaim = isAdmin() && Number(invoice.insurance_portion || invoice.insurance_covered || 0) > Number(invoice.insurance_portion_paid || 0) && !claims.length;
    return `<div class="clinic-modal-backdrop" data-billing-backdrop><section class="clinic-modal clinic-billing-modal clinic-billing-detail-modal" role="dialog" aria-modal="true" aria-labelledby="billingModalTitle">
      <div class="clinic-modal-head"><div><p class="clinic-eyebrow">Invoice detail</p><h2 id="billingModalTitle">${esc(invoice.invoice_number || "Invoice")}</h2><p>${date(invoice.created_at)} · ${badge(invoice.status)}</p></div><button class="clinic-close" type="button" data-billing-action="close-modal" aria-label="Close">×</button></div>
      <div class="clinic-modal-body clinic-billing-detail-body">
        ${state.modalError ? `<div class="clinic-form-error" role="alert">${esc(state.modalError)}</div>` : ""}
        <section class="clinic-subpanel"><div class="clinic-section-head"><div><h3>${esc(invoice.patient_name || "Patient")}</h3><p>${esc(invoice.patient_number || "")} · ${esc(invoice.patient_phone || "")}</p></div><span>${esc(invoice.branch_name || "")}</span></div></section>
        <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>
          ${(result.items || []).map((item) => `<tr><td>${esc(item.description)}</td><td>${esc(item.quantity)}</td><td>${money(item.unit_price, currency)}</td><td>${money(item.total, currency)}</td></tr>`).join("")}
        </tbody></table></div>
        <section class="clinic-subpanel clinic-invoice-summary">
          <div class="clinic-invoice-summary-grid">
            ${[["Subtotal", invoice.subtotal], ["Discount", invoice.discount], ["Total", invoice.total], ["Insurance portion", invoice.insurance_portion ?? invoice.insurance_covered], ["Patient portion", invoice.patient_portion], ["Patient paid", invoice.patient_portion_paid], ["Insurance paid", invoice.insurance_portion_paid], ["Amount paid", invoice.amount_paid], ["Balance due", invoice.balance_due]].map(([label, value]) => `<div class="clinic-info-item"><span>${label}</span><strong>${money(value, currency)}</strong></div>`).join("")}
          </div>
        </section>
        <section class="clinic-subpanel"><div class="clinic-section-head"><div><h3>Payments</h3><p>${payments.length} recorded</p></div></div>
          ${payments.length ? `<div class="clinic-patient-record-list">${payments.map((payment) => `<div class="clinic-payment-row"><div><strong>${esc(payment.receipt_number)}</strong><span>${dateTime(payment.paid_at)} · ${esc(payment.payment_method)}${payment.payment_reference ? ` · ${esc(payment.payment_reference)}` : ""}</span></div><strong>${money(payment.applied_amount, currency)}${payment.reversed ? " · Reversed" : ""}</strong>
            ${isAdmin() && !payment.reversed ? `<button class="clinic-btn clinic-btn--danger clinic-btn--small" type="button" data-billing-action="reverse-payment" data-id="${esc(payment.id)}">Reverse</button>` : ""}
          </div>`).join("")}</div>` : `<div class="clinic-empty-note">No payments yet.</div>`}
        </section>
        <section class="clinic-subpanel"><div class="clinic-section-head"><div><h3>Insurance claims</h3><p>Claims only cover the insurance portion.</p></div></div>
          ${claims.length ? claims.map((claim) => `<div class="clinic-payment-row"><div><strong>${esc(claim.claim_number)}</strong><span>${esc(claim.provider_name || invoice.insurance_provider_name || "")} · ${date(claim.submitted_at)}</span></div><span>${badge(claim.status)}</span><strong>${money(claim.approved_amount ?? claim.claim_amount, currency)}</strong></div>`).join("") : `<div class="clinic-empty-note">No claim submitted.</div>`}
        </section>
        <div class="clinic-actions clinic-invoice-actions">
        ${canRecordPayment() && !["paid", "cancelled", "draft"].includes(invoice.status) ? `<button class="clinic-btn" type="button" data-billing-action="record-payment">Record payment</button>` : ""}
          ${canClaim ? `<button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="submit-claim">Submit claim</button>` : ""}
          ${isAdmin() && ["draft", "issued"].includes(invoice.status) && Number(invoice.amount_paid || 0) === 0 ? `<button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="edit-invoice">Edit invoice</button>` : ""}
          ${canCancel ? `<button class="clinic-btn clinic-btn--danger" type="button" data-billing-action="cancel-invoice">Cancel invoice</button>` : ""}
          ${invoice.status === "paid" ? `<button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="print-invoice">Print receipt</button>` : ""}
        </div>
      </div>
    </section></div>`;
  }

  function renderModal() {
    if (!state.modal) return "";
    if (state.modal.type === "invoice-detail") return invoiceDetailMarkup();
    return modalMarkup();
  }

  function renderShell() {
    if (!root) return;
    const modal = state.modal ? `<div class="clinic-modal-slot">${renderModal()}</div>` : "";
    const hostView = root.querySelector(".clinic-view");
    const modalHost = root.querySelector(".clinic-modal-slot");
    if (hostView) hostView.innerHTML = tabMarkup(state.tab);
    if (modalHost) modalHost.innerHTML = state.modal ? renderModal() : "";
    if (!hostView) return;
    if (!modalHost && state.modal) root.querySelector(".clinic-shell")?.insertAdjacentHTML("beforeend", modal);
  }

  async function fetchInvoice(id) {
    const result = await request(`/api/clinic/invoices/${encodeURIComponent(id)}`);
    state.invoice = result;
    state.modal = { type: "invoice-detail" };
    state.modalError = "";
    renderShell();
  }

  function openInvoiceForPatient(patient) {
    state.modal = {
      type: "invoice",
      patient,
      patientId: patient?.id || "",
      visitId: "",
    };
    state.formValues = {};
    state.items = [{ item_type: "consultation", description: "Consultation", reference_id: null, quantity: 1, unit_price: "" }];
    state.visits = [];
    state.modalError = "";
    void (async () => {
      try {
        await Promise.all([loadPatients(), loadServices()]);
        if (patient?.id) await loadVisits(patient.id);
      } catch (error) {
        state.modalError = error?.message || "Could not prepare the invoice form.";
      }
      renderShell();
    })();
    renderShell();
  }

  function openPortalAccess(patient) {
    state.modal = { type: "portal-access", patient };
    state.modalError = "";
  }

  async function loadVisits(patientId) {
    state.visits = [];
    if (!patientId) return;
    const payload = await request(`/api/clinic/visits?patient_id=${encodeURIComponent(patientId)}&limit=100`);
    state.visits = Array.isArray(payload.visits) ? payload.visits : [];
  }

  async function applyVisitSuggestions(visitId) {
    if (!visitId) return;
    try {
      const payload = await request(`/api/clinic/invoices/suggestions?visit_id=${encodeURIComponent(visitId)}`);
      const suggestion = payload.suggestions || {};
      const items = [];
      if (Number(suggestion.consultation_fee) > 0) {
        items.push({
          item_type: "consultation",
          description: "Consultation",
          reference_id: null,
          quantity: 1,
          unit_price: String(suggestion.consultation_fee),
        });
      }
      for (const item of Array.isArray(suggestion.prescriptions) ? suggestion.prescriptions : []) {
        items.push({
          item_type: "prescription",
          description: item.description || "Prescription",
          reference_id: item.reference_id || null,
          quantity: Number(item.quantity) || 1,
          unit_price: String(item.unit_price || "0"),
        });
      }
      if (items.length) state.items = items;
      renderShell();
    } catch (error) {
      state.modalError = error?.message || "Visit suggestions could not be loaded.";
      renderShell();
    }
  }

  function captureInvoiceForm(form) {
    const data = new FormData(form);
    state.formValues = {
      discount: String(data.get("discount") || "0"),
      due_date: String(data.get("due_date") || ""),
      notes: String(data.get("notes") || ""),
      status: String(data.get("status") || ""),
    };
    const patientId = String(data.get("patient_id") || "");
    if (state.modal?.type === "invoice") state.modal.patientId = patientId;
    return data;
  }

  function updateLineTotals() {
    root.querySelectorAll("[data-item-index]").forEach((row) => {
      const index = Number(row.dataset.itemIndex);
      const item = state.items[index];
      if (!item) return;
      const quantity = Number(row.querySelector('[data-item-field="quantity"]')?.value || 0);
      const price = Number(row.querySelector('[data-item-field="unit_price"]')?.value || 0);
      const total = quantity * price;
      const target = row.querySelector(`[data-item-total="${index}"]`);
      if (target) target.textContent = money(Number.isFinite(total) ? total : 0);
    });
    const totalTarget = root.querySelector("[data-billing-total]");
    if (totalTarget) totalTarget.textContent = calculateItemsTotal();
  }

  async function saveInvoice(form, status) {
    const data = captureInvoiceForm(form);
    const patientId = String(data.get("patient_id") || "");
    const visitId = String(data.get("visit_id") || "");
    const items = state.items
      .filter((item) => item.description.trim() && item.unit_price !== "")
      .map((item) => ({
        item_type: item.item_type,
        description: item.description.trim(),
        reference_id: item.reference_id || undefined,
        quantity: Number(item.quantity || 1),
        unit_price: Number(item.unit_price || 0),
      }));
    if (!items.length) {
      state.modalError = "Add at least one invoice item with a price.";
      renderShell();
      return;
    }
    try {
      const result = await request("/api/clinic/invoices", {
        method: "POST",
        body: {
          patient_id: patientId,
          ...(visitId ? { visit_id: visitId } : {}),
          items,
          discount: Number(data.get("discount") || 0),
          due_date: String(data.get("due_date") || "") || null,
          notes: String(data.get("notes") || "").trim() || null,
          status,
        },
      });
      state.modal = null;
      state.modalError = "";
      message(status === "draft" ? "Invoice saved as a draft." : `Invoice ${result.invoice?.invoice_number || ""} issued.`);
      await loadTab("billing");
      if (result.invoice?.id) await fetchInvoice(result.invoice.id);
    } catch (error) {
      state.modalError = error?.message || "The invoice could not be saved.";
      renderShell();
    }
  }

  async function savePayment(form) {
    const data = new FormData(form);
    const invoice = state.invoice?.invoice || {};
    try {
      const result = await request(`/api/clinic/invoices/${encodeURIComponent(invoice.id)}/payments`, {
        method: "POST",
        body: {
          amount: Number(data.get("amount")),
          payment_method: String(data.get("payment_method") || "cash"),
          payment_reference: String(data.get("payment_reference") || "").trim() || null,
          notes: String(data.get("notes") || "").trim() || null,
        },
      });
      state.modal = { type: "invoice-detail" };
      await fetchInvoice(invoice.id);
      message(`Payment recorded. Receipt ${result.payment?.receipt_number || ""}.`);
      await loadTab("billing");
    } catch (error) {
      state.modalError = error?.message || "Payment could not be recorded.";
      renderShell();
    }
  }

  async function saveCatalog(form, type) {
    const id = form.dataset.id;
    const data = new FormData(form);
    const fields = Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value).trim()]));
    if (type === "service") {
      fields.price = Number(fields.price || 0);
    } else {
      fields.coverage_percent = Number(fields.coverage_percent || 0);
    }
    try {
      const path = type === "service"
        ? `/api/clinic/services${id ? `/${encodeURIComponent(id)}` : ""}`
        : `/api/clinic/insurance-providers${id ? `/${encodeURIComponent(id)}` : ""}`;
      const result = await request(path, { method: id ? "PATCH" : "POST", body: fields });
      state.modal = null;
      message(type === "service"
        ? `Service ${id ? "updated" : "created"}.`
        : `Insurance provider ${id ? "updated" : "created"}.`);
      if (type === "service") await loadServices(true);
      else await loadProviders(true);
      await loadTab(type === "service" ? "billing" : "insurance");
      return result;
    } catch (error) {
      state.modalError = error?.message || "The record could not be saved.";
      renderShell();
    }
  }

  async function saveInvoiceEdit(form) {
    const invoiceId = form.dataset.id;
    const data = new FormData(form);
    try {
      await request(`/api/clinic/invoices/${encodeURIComponent(invoiceId)}`, {
        method: "PATCH",
        body: {
          discount: Number(data.get("discount") || 0),
          due_date: String(data.get("due_date") || "") || null,
          notes: String(data.get("notes") || "").trim() || null,
          status: String(data.get("status") || "issued"),
        },
      });
      state.modal = { type: "invoice-detail" };
      message("Invoice updated.");
      await loadTab("billing");
      await fetchInvoice(invoiceId);
    } catch (error) {
      state.modalError = error?.message || "Invoice could not be updated.";
      renderShell();
    }
  }

  async function savePortalAccess(form) {
    const data = new FormData(form);
    try {
      const result = await request(`/api/clinic/patients/${encodeURIComponent(state.modal.patient.id)}/create-portal-access`, {
        method: "POST",
        body: {
          email: String(data.get("email") || "").trim(),
          password: String(data.get("password") || ""),
        },
      });
      state.modal = null;
      message(result.email_sent === false
        ? "Portal access created, but the welcome email could not be sent. Share the password securely."
        : "Patient portal access created. Share the password securely.");
      await reload("patients");
    } catch (error) {
      state.modalError = error?.message || "Portal access could not be created.";
      renderShell();
    }
  }

  async function savePatientInsurance(form) {
    const patient = getPatient();
    if (!patient?.id) return;
    const data = new FormData(form);
    try {
      await request(`/api/clinic/patients/${encodeURIComponent(patient.id)}/insurance`, {
        method: "PATCH",
        body: {
          provider_id: String(data.get("provider_id") || "") || null,
          member_number: String(data.get("member_number") || "").trim() || null,
          valid_until: String(data.get("valid_until") || "") || null,
        },
      });
      message("Patient insurance details updated.");
      await reload("patients");
    } catch (error) {
      message(error?.message || "Insurance details could not be updated.", "error");
    }
  }

  async function updateClaim(form) {
    const claimId = form.dataset.id;
    const status = form.dataset.status;
    const data = new FormData(form);
    try {
      await request(`/api/clinic/claims/${encodeURIComponent(claimId)}`, {
        method: "PATCH",
        body: {
          status,
          ...(status !== "rejected" ? { approved_amount: Number(data.get("approved_amount")) } : {}),
          ...(status === "rejected" ? { rejection_reason: String(data.get("rejection_reason") || "").trim() } : {}),
        },
      });
      state.modal = null;
      message(status === "paid" ? "Insurance payment recorded." : status === "approved" ? "Insurance claim approved." : "Insurance claim rejected.");
      await loadTab("insurance");
      if (state.invoice?.invoice?.id) await fetchInvoice(state.invoice.invoice.id);
    } catch (error) {
      state.modalError = error?.message || "The claim could not be updated.";
      renderShell();
    }
  }

  async function cancelInvoice() {
    const invoice = state.invoice?.invoice;
    if (!invoice?.id) return;
    if (typeof window !== "undefined" && !window.confirm(`Cancel invoice ${invoice.invoice_number}?`)) return;
    try {
      await request(`/api/clinic/invoices/${encodeURIComponent(invoice.id)}/cancel`, { method: "POST" });
      message("Invoice cancelled.");
      await fetchInvoice(invoice.id);
      await loadTab("billing");
    } catch (error) {
      state.modalError = error?.message || "Invoice could not be cancelled.";
      renderShell();
    }
  }

  async function submitClaim() {
    const invoice = state.invoice?.invoice;
    if (!invoice?.id) return;
    try {
      const result = await request(`/api/clinic/invoices/${encodeURIComponent(invoice.id)}/claim`, {
        method: "POST",
        body: {},
      });
      message(`Claim ${result.claim?.claim_number || ""} submitted.`);
      await fetchInvoice(invoice.id);
      await loadTab("insurance");
    } catch (error) {
      state.modalError = error?.message || "Claim could not be submitted.";
      renderShell();
    }
  }

  async function reversePayment(id) {
    const reason = typeof window !== "undefined"
      ? window.prompt("Enter the reason for reversing this payment (minimum 5 characters):")
      : "";
    if (!reason) return;
    const invoiceId = state.invoice?.invoice?.id;
    try {
      await request(`/api/clinic/payments/${encodeURIComponent(id)}/reverse`, {
        method: "POST",
        body: { reason },
      });
      message("Payment reversed and invoice balances recomputed.");
      if (invoiceId) await fetchInvoice(invoiceId);
      await loadTab("billing");
    } catch (error) {
      state.modalError = error?.message || "Payment could not be reversed.";
      renderShell();
    }
  }

  async function deactivateCatalog(type, id) {
    const label = type === "service" ? "service" : "insurance provider";
    if (typeof window !== "undefined" && !window.confirm(`Deactivate this ${label}?`)) return;
    try {
      const path = type === "service" ? `/api/clinic/services/${encodeURIComponent(id)}` : `/api/clinic/insurance-providers/${encodeURIComponent(id)}`;
      await request(path, { method: "DELETE" });
      message(`${label[0].toUpperCase()}${label.slice(1)} deactivated.`);
      await loadTab(type === "service" ? "billing" : "insurance");
    } catch (error) {
      message(error?.message || `The ${label} could not be deactivated.`, "error");
    }
  }

  async function openClaimAction(id, status) {
    const claim = state.claims.find((item) => String(item.id) === String(id));
    if (!claim) return;
    state.modal = { type: "claim-update", claim, status };
    state.modalError = "";
    renderShell();
  }

  function patientInvoicesMarkup(patient, invoices) {
    return `<article class="clinic-subpanel"><div class="clinic-section-head"><div><h3>Invoices</h3><p>${invoices.length} invoices · separate patient and insurer balances.</p></div>
      ${canManageInvoices() ? `<button type="button" class="clinic-btn clinic-btn--small" data-billing-action="new-invoice-for-patient">New invoice</button>` : ""}
    </div>
    ${invoices.length ? `<div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Invoice</th><th>Total</th><th>Patient balance</th><th>Insurance claim</th><th>Status</th><th></th></tr></thead><tbody>
      ${invoices.map((invoice) => `<tr><td><strong>${esc(invoice.invoice_number)}</strong><span>${date(invoice.created_at)}</span></td><td>${money(invoice.total, invoice.currency)}</td><td>${money(Math.max(0, Number(invoice.patient_portion) - Number(invoice.patient_portion_paid)), invoice.currency)}</td><td>${esc(statusLabel(invoice.claim_status || "not submitted"))}</td><td>${badge(invoice.status)}</td><td><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-billing-action="view-invoice" data-id="${esc(invoice.id)}">Details</button></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="clinic-empty-note">No invoices have been issued to this patient.</div>`}
    </article>`;
  }

  function patientInsuranceMarkup(patient, insurancePayload) {
    const insurance = insurancePayload?.insurance || {};
    if (!state.providersLoaded) {
      void loadProviders().then(() => reload("patients")).catch(() => {});
    }
    const editable = ["clinic_admin", "nurse", "receptionist"].includes(role());
    return `<article class="clinic-subpanel"><div class="clinic-section-head"><div><h3>Insurance details</h3><p>Coverage applies to new invoices when the provider and policy are active.</p></div></div>
      ${editable ? `<form class="clinic-form-grid" data-billing-form="patient-insurance">
        <label class="clinic-field"><span>Provider</span><select class="clinic-control" name="provider_id"><option value="">No insurance</option>
          ${state.providers.filter((provider) => provider.active).map((provider) => `<option value="${esc(provider.id)}" ${String(insurance.insurance_provider_id || "") === String(provider.id) ? "selected" : ""}>${esc(provider.name)} · ${esc(provider.coverage_percent)}%</option>`).join("")}
        </select></label>
        <label class="clinic-field"><span>Member number</span><input class="clinic-control" name="member_number" value="${esc(insurance.insurance_member_number || "")}" maxlength="120"></label>
        <label class="clinic-field"><span>Valid until</span><input class="clinic-control" name="valid_until" type="date" value="${esc(String(insurance.insurance_valid_until || "").slice(0, 10))}"></label>
        <div class="clinic-field clinic-actions"><button class="clinic-btn" type="submit">Save insurance</button></div>
      </form>` : `<div class="clinic-info-grid">
        <div class="clinic-info-item"><span>Provider</span><strong>${esc(insurance.provider_name || "None")}</strong></div>
        <div class="clinic-info-item"><span>Member number</span><strong>${esc(insurance.insurance_member_number || "—")}</strong></div>
        <div class="clinic-info-item"><span>Valid until</span><strong>${date(insurance.insurance_valid_until)}</strong></div>
      </div>`}
      ${isAdmin() || role() === "receptionist" ? `<div class="clinic-actions clinic-patient-portal-action"><button class="clinic-btn clinic-btn--quiet" type="button" data-billing-action="create-portal-access" data-id="${esc(patient.id)}">Create portal access</button></div>` : ""}
    </article>`;
  }

  function renderPatientInvoices(patient, invoices = []) {
    if (!patient) return "";
    return patientInvoicesMarkup(patient, invoices);
  }

  function renderPatientInsurance(patient, insurancePayload) {
    if (!patient) return "";
    return patientInsuranceMarkup(patient, insurancePayload);
  }

  function openPatientInvoice() {
    const patient = getPatient();
    if (patient) openInvoiceForPatient(patient);
  }

  root?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-billing-action]");
    if (!action) {
      if (event.target.matches("[data-billing-backdrop]")) {
        state.modal = null;
        state.modalError = "";
        renderShell();
      }
      return;
    }
    const kind = action.dataset.billingAction;
    const id = action.dataset.id;
    if (kind === "close-modal") {
      state.modal = null;
      state.modalError = "";
      renderShell();
    } else if (kind === "retry") {
      await loadTab(state.tab);
    } else if (kind === "new-invoice") {
      openInvoiceForPatient(null);
    } else if (kind === "new-invoice-for-patient") {
      openPatientInvoice();
    } else if (kind === "view-invoice" && id) {
      try { await fetchInvoice(id); } catch (error) { message(error?.message || "Invoice details could not be loaded.", "error"); }
    } else if (kind === "record-payment") {
      state.modal = { type: "payment", invoice: state.invoice };
      state.modalError = "";
      renderShell();
    } else if (kind === "submit-claim") {
      await submitClaim();
    } else if (kind === "cancel-invoice") {
      await cancelInvoice();
    } else if (kind === "reverse-payment") {
      await reversePayment(id);
    } else if (kind === "print-invoice") {
      if (typeof window !== "undefined") window.print();
    } else if (kind === "edit-invoice") {
      const invoice = state.invoice?.invoice;
      if (invoice) {
        state.modal = { type: "edit-invoice", invoice };
        renderShell();
      }
    } else if (kind === "new-service") {
      state.modal = { type: "service" };
      renderShell();
    } else if (kind === "edit-service") {
      const record = state.services.find((item) => String(item.id) === String(id));
      if (record) { state.modal = { type: "service", record }; renderShell(); }
    } else if (kind === "deactivate-service") {
      await deactivateCatalog("service", id);
    } else if (kind === "new-provider") {
      state.modal = { type: "provider" };
      renderShell();
    } else if (kind === "edit-provider") {
      const record = state.providers.find((item) => String(item.id) === String(id));
      if (record) { state.modal = { type: "provider", record }; renderShell(); }
    } else if (kind === "deactivate-provider") {
      await deactivateCatalog("provider", id);
    } else if (kind === "claim-approve") {
      await openClaimAction(id, "approved");
    } else if (kind === "claim-paid") {
      await openClaimAction(id, "paid");
    } else if (kind === "claim-reject") {
      await openClaimAction(id, "rejected");
    } else if (kind === "add-item") {
      state.items.push({ item_type: "service", description: "", reference_id: null, quantity: 1, unit_price: "" });
      renderShell();
    } else if (kind === "remove-item") {
      state.items.splice(Number(action.dataset.index), 1);
      renderShell();
    } else if (kind === "create-portal-access") {
      const patient = getPatient();
      if (patient) {
        state.modal = { type: "portal-access", patient };
        state.modalError = "";
        renderShell();
      }
    }
  });

  root?.addEventListener("input", (event) => {
    const field = event.target.closest("[data-item-field]");
    if (!field) return;
    const index = Number(field.dataset.index);
    const item = state.items[index];
    if (!item) return;
    const key = field.dataset.itemField;
    if (key === "quantity") item.quantity = Number(field.value || 0);
    else if (key === "unit_price") item.unit_price = field.value;
    else if (key === "description") item.description = field.value;
    else if (key === "item_type") item.item_type = field.value;
    updateLineTotals();
  });

  root?.addEventListener("change", async (event) => {
    const form = event.target.closest('[data-billing-form="invoice"]');
    if (form) {
      const data = captureInvoiceForm(form);
      if (event.target.name === "patient_id") {
        const patientId = String(data.get("patient_id") || "");
        state.modal.patientId = patientId;
        state.modal.patient = state.patients.find((patient) => String(patient.id) === patientId) || state.modal.patient;
        try { await loadVisits(patientId); } catch {}
        renderShell();
      } else if (event.target.name === "visit_id") {
        state.modal.visitId = String(data.get("visit_id") || "");
        await applyVisitSuggestions(state.modal.visitId);
      }
      return;
    }
    const service = event.target.closest("[data-item-service]");
    if (service) {
      const index = Number(service.dataset.index);
      const item = state.items[index];
      const record = state.services.find((candidate) => String(candidate.id) === String(service.value));
      if (!item) return;
      if (record) {
        item.item_type = "service";
        item.reference_id = record.id;
        item.description = record.name;
        item.unit_price = String(record.price);
        renderShell();
      } else {
        item.reference_id = null;
      }
      return;
    }
    if (event.target.matches('[data-billing-form="invoice"] [name="discount"]')) {
      const formNode = event.target.closest("form");
      if (formNode) {
        state.formValues.discount = String(event.target.value || 0);
        updateLineTotals();
      }
    }
  });

  root?.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-billing-form]");
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.billingForm;
    if (type === "filters") {
      const data = new FormData(form);
      state.filters = {
        status: String(data.get("status") || ""),
        patient_id: String(data.get("patient_id") || ""),
        from: String(data.get("from") || ""),
        to: String(data.get("to") || ""),
      };
      await loadTab("billing");
    } else if (type === "invoice") {
      await saveInvoice(form, "issued");
    } else if (type === "payment") {
      await savePayment(form);
    } else if (type === "service" || type === "provider") {
      await saveCatalog(form, type);
    } else if (type === "edit-invoice") {
      await saveInvoiceEdit(form);
    } else if (type === "portal-access") {
      await savePortalAccess(form);
    } else if (type === "patient-insurance") {
      await savePatientInsurance(form);
    } else if (type === "claim-update") {
      await updateClaim(form);
    }
  });

  root?.addEventListener("click", (event) => {
    const draft = event.target.closest('[data-billing-action="save-draft"]');
    if (!draft) return;
    event.preventDefault();
    const form = draft.closest("form[data-billing-form='invoice']");
    if (form) void saveInvoice(form, "draft");
  });

  return {
    loadTab,
    renderTab,
    renderModal,
    renderPatientInvoices,
    renderPatientInsurance,
    openInvoiceForPatient,
    openPortalAccess,
    reset() {
      state.modal = null;
      state.invoice = null;
      state.items = [];
      state.modalError = "";
      state.stats = {};
      state.invoices = [];
      state.services = [];
      state.providers = [];
      state.claims = [];
      state.patients = [];
      state.visits = [];
      state.filters = { status: "", patient_id: "", from: "", to: "" };
      state.servicesLoaded = false;
      state.providersLoaded = false;
    },
  };
}

export default initClinicBillingUI;
