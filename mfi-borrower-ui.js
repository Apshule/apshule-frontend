export function createMfiBorrowerUI({ request, escapeHtml, money, formattedDate, announce, onRender }) {
  const state = {
    customer: null,
    organization: null,
    loans: [],
    profileLoading: true,
    loansLoading: true,
    profileError: "",
    loansError: "",
    profileSaving: false,
    profileErrorSave: "",
    editingProfile: false,
    profileDraft: null,
    loanId: "",
    loan: null,
    statement: null,
    statementError: "",
    loanLoading: false,
    loanError: "",
  };
  const esc = (value) => {
    if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  };
  const fmtMoney = (value) => {
    try {
      return typeof money === "function" ? money(Number(value || 0)) : `UGX ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
    } catch {
      return `UGX ${Number(value || 0).toLocaleString("en-UG")}`;
    }
  };
  const fmtDate = (value) => {
    if (!value) return "—";
    try {
      return typeof formattedDate === "function" ? formattedDate(value) : new Date(value).toLocaleDateString("en-UG");
    } catch {
      return String(value);
    }
  };
  const rerender = () => {
    if (typeof onRender === "function") onRender();
  };
  const say = (text, type = "success") => {
    if (typeof announce === "function") announce(text, type);
  };
  const errorState = (heading, message, action) => `<div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>${esc(heading)}</strong><p>${esc(message)}</p>${action ? `<button type="button" class="mfi-btn mfi-btn--quiet" data-borrower-action="${action}">Try again</button>` : ""}</div>`;
  const loadingState = (label) => `<div class="mfi-state mfi-borrower-loading" role="status"><div class="mfi-report-skeleton"><span></span><span></span><span></span></div><strong>${esc(label)}</strong><p>Loading your account records.</p></div>`;
  const emptyState = (title, detail) => `<div class="mfi-report-empty"><span class="mfi-report-empty-mark">—</span><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
  const table = (headers, rows, emptyMessage) => `<div class="mfi-table-wrap"><table class="mfi-table"><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}" class="mfi-report-empty-cell">${esc(emptyMessage)}</td></tr>`}</tbody></table></div>`;
  const fullName = (customer) => `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || "Borrower";
  async function load() {
    state.profileLoading = true;
    state.loansLoading = true;
    state.profileError = "";
    state.loansError = "";
    rerender();
    const [profileResult, loansResult] = await Promise.allSettled([
      request("/api/borrower/me"),
      request("/api/borrower/me/loans"),
    ]);
    if (profileResult.status === "fulfilled") {
      state.customer = profileResult.value?.customer || null;
      state.organization = profileResult.value?.organization || null;
    } else {
      state.profileError = profileResult.reason?.message || "Your profile could not be loaded.";
    }
    if (loansResult.status === "fulfilled") {
      state.loans = Array.isArray(loansResult.value?.loans) ? loansResult.value.loans : [];
    } else {
      state.loansError = loansResult.reason?.message || "Your loan accounts could not be loaded.";
    }
    state.profileLoading = false;
    state.loansLoading = false;
    rerender();
  }
  async function openLoan(id) {
    state.loanId = String(id || "");
    state.loan = null;
    state.statement = null;
    state.statementError = "";
    state.loanError = "";
    state.loanLoading = true;
    rerender();
    const encoded = encodeURIComponent(state.loanId);
    const [detail, statement] = await Promise.allSettled([
      request(`/api/borrower/me/loans/${encoded}`),
      request(`/api/borrower/me/loans/${encoded}/statement`),
    ]);
    if (detail.status === "fulfilled") state.loan = detail.value?.loan || null;
    if (statement.status === "fulfilled") state.statement = statement.value || null;
    if (detail.status === "rejected") state.loanError = detail.reason?.message || "This loan could not be opened.";
    if (statement.status === "rejected") state.statementError = statement.reason?.message || "The transaction statement could not be loaded.";
    state.loanLoading = false;
    rerender();
  }
  async function reloadStatement() {
    if (!state.loanId) return;
    state.statementError = "";
    state.statement = null;
    rerender();
    try {
      state.statement = await request(`/api/borrower/me/loans/${encodeURIComponent(state.loanId)}/statement`);
    } catch (error) {
      state.statementError = error?.message || "The transaction statement could not be loaded.";
    } finally {
      rerender();
    }
  }
  function profileView() {
    if (state.profileLoading) return loadingState("Loading your profile");
    if (state.profileError) return errorState("Profile unavailable", state.profileError, "retry-profile");
    const person = state.customer || {};
    if (!state.editingProfile) {
      return `<div class="mfi-borrower-profile-read">
        <div class="mfi-borrower-profile-intro"><div class="mfi-borrower-initials">${esc(fullName(person).split(/\s+/).map((part) => part[0] || "").slice(0, 2).join("").toUpperCase())}</div>
          <div><span class="mfi-eyebrow">Borrower profile</span><h3>${esc(fullName(person))}</h3><p>${esc(state.organization?.name || "APSHULE MFI")}</p></div>
          <button type="button" class="mfi-btn mfi-btn--quiet" data-borrower-action="edit-profile">Edit contact details</button></div>
        <div class="mfi-info-grid">
          ${info("Phone", person.phone)}${info("Email", person.email)}${info("Address", person.address)}${info("Village", person.village)}${info("District", person.district)}${info("Occupation", person.occupation)}${info("Gender", person.gender)}
        </div>
        <p class="mfi-borrower-permission-note">You may update your phone, address, and village. Other identity and account details are maintained by your MFI.</p>
      </div>`;
    }
    const draft = state.profileDraft || {};
    return `<form class="mfi-borrower-profile-form" data-borrower-form="profile">
      ${state.profileErrorSave ? `<div class="mfi-form-error">${esc(state.profileErrorSave)}</div>` : ""}
      <div class="mfi-form-grid">
        <label class="mfi-field"><span>Phone</span><input class="mfi-control" name="phone" maxlength="40" value="${esc(draft.phone ?? person.phone ?? "")}" autocomplete="tel"></label>
        <label class="mfi-field"><span>Address</span><input class="mfi-control" name="address" maxlength="200" value="${esc(draft.address ?? person.address ?? "")}" autocomplete="street-address"></label>
        <label class="mfi-field"><span>Village</span><input class="mfi-control" name="village" maxlength="200" value="${esc(draft.village ?? person.village ?? "")}"></label>
      </div>
      <div class="mfi-borrower-readonly-note">Only these three contact fields can be changed from the borrower portal.</div>
      <div class="mfi-action-row"><button class="mfi-btn mfi-btn--quiet" type="button" data-borrower-action="cancel-profile">Cancel</button><button class="mfi-btn" type="submit" ${state.profileSaving ? "disabled" : ""}>${state.profileSaving ? "Saving…" : "Save contact details"}</button></div>
    </form>`;
  }
  function info(label, value) {
    return `<div class="mfi-info-item"><span>${esc(label)}</span><strong>${esc(value || "—")}</strong></div>`;
  }
  function loansView() {
    if (state.loansLoading) return loadingState("Loading your loans");
    if (state.loansError) return errorState("Loan accounts unavailable", state.loansError, "retry-loans");
    if (!state.loans.length) return emptyState("No loan accounts yet", "When your MFI links a loan to your account, its balance and repayment schedule will appear here.");
    const rows = state.loans.map((loan) => `<tr>
      <td class="mfi-primary-cell"><strong>${esc(loan.loan_number || "Loan account")}</strong><span>${esc(loan.repayment_frequency || "Repayment schedule")}</span></td>
      <td><span class="mfi-status">${esc(loan.status || "—")}</span></td><td>${esc(fmtDate(loan.disbursed_at))}</td>
      <td>${esc(fmtDate(loan.maturity_date))}</td><td class="mfi-report-number">${esc(fmtMoney(loan.outstanding_balance))}</td>
      <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-borrower-action="open-loan" data-loan-id="${esc(loan.id)}">View account</button></td>
    </tr>`);
    return table(["Loan account", "Status", "Disbursed", "Maturity", "Outstanding", "Details"], rows, "");
  }
  function loanDetail() {
    if (state.loanLoading) return loadingState("Loading loan account");
    if (state.loanError && !state.loan) return errorState("Loan account unavailable", state.loanError);
    const loan = state.loan;
    if (!loan) return "";
    const schedules = Array.isArray(loan.schedules) ? loan.schedules : [];
    const scheduleRows = schedules.map((item) => `<tr><td>${esc(number(item.installment_number))}</td><td>${esc(fmtDate(item.due_date))}</td><td>${esc(fmtMoney(item.principal_due))}</td><td>${esc(fmtMoney(item.interest_due))}</td><td>${esc(fmtMoney(Number(item.fees_due || 0) + Number(item.late_fee_due || 0)))}</td><td>${esc(fmtMoney(item.total_due))}</td><td>${esc(fmtMoney(item.total_paid))}</td><td><span class="mfi-status ${item.status === "paid" ? "" : "mfi-status--attention"}">${esc(item.status || "—")}</span></td></tr>`);
    const transactions = Array.isArray(state.statement?.transactions) ? state.statement.transactions : [];
    const transactionRows = transactions.map((entry) => `<tr><td>${esc(fmtDate(entry.event_at))}</td><td>${esc(entry.description || entry.event_type || "Account event")}</td><td>${esc(entry.reference || "—")}</td><td class="mfi-report-number">${esc(fmtMoney(entry.signed_amount))}</td></tr>`);
    return `<div class="mfi-borrower-loan-detail"><div class="mfi-section-head">
        <div><p class="mfi-eyebrow">Account record · read only</p><h2>${esc(loan.loan_number || "Loan account")}</h2><p>All loan terms and repayment information are read-only.</p></div>
        <button type="button" class="mfi-btn mfi-btn--quiet" data-borrower-action="back-to-loans">Back to my loans</button>
      </div>
      ${state.loanError ? `<div class="mfi-form-error">${esc(state.loanError)}</div>` : ""}
      <div class="mfi-report-kpis mfi-borrower-loan-kpis">
        <div><span>Original principal</span><strong>${esc(fmtMoney(loan.principal))}</strong></div><div><span>Total repayable</span><strong>${esc(fmtMoney(loan.total_repayable))}</strong></div>
        <div><span>Paid to date</span><strong>${esc(fmtMoney(loan.total_paid))}</strong></div><div><span>Outstanding</span><strong>${esc(fmtMoney(loan.outstanding_balance))}</strong></div>
      </div>
      <div class="mfi-info-grid mfi-borrower-loan-meta">${info("Interest rate", `${loan.interest_rate ?? "—"}%`)}${info("Interest method", loan.interest_method)}${info("Term", loan.term_months ? `${loan.term_months} months` : "")}${info("Frequency", loan.repayment_frequency)}${info("First installment", fmtDate(loan.first_installment_date))}${info("Maturity", fmtDate(loan.maturity_date))}${info("Days overdue", loan.days_overdue == null ? "—" : `${loan.days_overdue} days`)}${info("Disbursement method", loan.disbursement_method)}</div>
      <section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Repayment schedule</h3><span>${esc(number(schedules.length))} installments</span></div>
        ${schedules.length ? table(["No.", "Due date", "Principal", "Interest", "Fees", "Total due", "Paid", "Status"], scheduleRows, "") : emptyState("Schedule not available", "Your MFI has not provided an installment schedule for this loan.")}</section>
      <section class="mfi-report-inset mfi-report-table-section"><div class="mfi-report-subhead"><h3>Account transactions</h3><span>Statement · read only</span></div>
        ${state.statement ? (transactions.length ? table(["Date", "Description", "Reference", "Amount"], transactionRows, "") : emptyState("No transactions yet", "No account events are recorded for this loan.")) : state.statementError ? errorState("Statement unavailable", state.statementError, "retry-statement") : loadingState("Loading statement")}</section>
    </div>`;
  }
  const number = (value) => Number(value || 0).toLocaleString("en-UG");
  function render() {
    const org = state.organization || {};
    const color = /^#[0-9a-f]{6}$/i.test(String(org.brand_color || "")) ? org.brand_color : "";
    return `<section class="mfi-borrower-ui" ${color ? `style="--mfi-primary:${esc(color)}"` : ""}>
      <div class="mfi-borrower-banner"><div><span class="mfi-eyebrow">APSHULE MFI · Borrower access</span><h1>Your account, clearly.</h1><p>Check your repayment record and keep contact details current.</p></div>
        <div class="mfi-borrower-banner-meta"><span>Account holder</span><strong>${esc(fullName(state.customer))}</strong><small>${esc(org.name || "Microfinance account")}</small></div></div>
      <div class="mfi-borrower-grid"><section class="mfi-panel mfi-borrower-profile-panel"><div class="mfi-section-head"><div><h2>Your details</h2><p>Contact details and identity on file with your MFI.</p></div></div>${profileView()}</section>
        <section class="mfi-panel mfi-borrower-loans-panel"><div class="mfi-section-head"><div><h2>Your loans</h2><p>Read-only balances, schedules, and account transactions.</p></div><span class="mfi-borrower-count">${state.loansLoading ? "…" : esc(state.loans.length)} accounts</span></div>
          ${state.loanId ? loanDetail() : loansView()}</section></div>
      <p class="mfi-borrower-footer">Need help with a payment or account entry? Contact your MFI officer. Loan terms cannot be changed in borrower self-service.</p>
    </section>`;
  }
  async function saveProfile(form) {
    const values = new FormData(form);
    const body = {
      phone: String(values.get("phone") || "").trim() || null,
      address: String(values.get("address") || "").trim() || null,
      village: String(values.get("village") || "").trim() || null,
    };
    state.profileDraft = body;
    state.profileSaving = true;
    state.profileErrorSave = "";
    rerender();
    try {
      const result = await request("/api/borrower/me/profile", { method: "PATCH", body });
      state.customer = result?.customer || { ...state.customer, ...body };
      state.editingProfile = false;
      state.profileDraft = null;
      say("Your contact details were updated.");
    } catch (error) {
      state.profileErrorSave = error?.message || "Your contact details could not be saved.";
      say(state.profileErrorSave, "error");
    } finally {
      state.profileSaving = false;
      rerender();
    }
  }
  function bind(root) {
    if (!root || root.dataset.mfiBorrowerBound === "true") return;
    root.dataset.mfiBorrowerBound = "true";
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-borrower-action]");
      if (!button || !root.contains(button)) return;
      const action = button.dataset.borrowerAction;
      if (action === "retry-profile" || action === "retry-loans") load();
      if (action === "edit-profile") {
        state.editingProfile = true;
        state.profileErrorSave = "";
        state.profileDraft = null;
        rerender();
      }
      if (action === "cancel-profile") {
        state.editingProfile = false;
        state.profileErrorSave = "";
        state.profileDraft = null;
        rerender();
      }
      if (action === "open-loan") openLoan(button.dataset.loanId);
      if (action === "retry-statement") reloadStatement();
      if (action === "back-to-loans") {
        state.loanId = "";
        state.loan = null;
        state.statement = null;
        state.loanError = "";
        rerender();
      }
    });
    root.addEventListener("submit", (event) => {
      const form = event.target.closest('[data-borrower-form="profile"]');
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      saveProfile(form);
    });
  }
  function reset() {
    state.customer = null;
    state.organization = null;
    state.loans = [];
    state.profileLoading = true;
    state.loansLoading = true;
    state.profileError = "";
    state.loansError = "";
    state.profileSaving = false;
    state.profileErrorSave = "";
    state.editingProfile = false;
    state.profileDraft = null;
    state.loanId = "";
    state.loan = null;
    state.statement = null;
    state.statementError = "";
    state.loanLoading = false;
    state.loanError = "";
  }
  return { render, load, bind, reset };
}
