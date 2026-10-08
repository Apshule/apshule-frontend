export type GuideSection = {
  title: string;
  icon: string;
  steps: string[];
};

const common = (title: string, icon: string, steps: string[]): GuideSection => ({
  title,
  icon,
  steps,
});

const roleGuides: Record<string, GuideSection[]> = {
  individual: [
    common("Find learning materials", "fa-book-open", ["Open your subject or class.", "Choose a lesson or document.", "Use the save option when you want it available offline."]),
    common("Track your learning", "fa-chart-line", ["Open your dashboard to see your activity.", "Review feedback attached to completed work.", "Ask your teacher if an item is missing."]),
    common("Keep your account safe", "fa-user-shield", ["Use Settings to choose your language and theme.", "Report a problem if a page or lesson does not work.", "Sign out when you finish on a shared device."]),
  ],
  teacher: [
    common("Prepare class resources", "fa-book", ["Open your assigned classes.", "Add or review the materials for your learners.", "Check that titles and class assignments are correct before sharing."]),
    common("Record class activity", "fa-clipboard-check", ["Choose the correct class and learner.", "Save attendance or assessment changes while online.", "Review sync history if a saved change is still pending."]),
    common("Get help", "fa-life-ring", ["Use the Help Center for role-specific guidance.", "Send a bug report with the affected page and optional screenshot.", "Never include passwords in a report."]),
  ],
  school: [
    common("Manage your school", "fa-school", ["Review the school profile and assigned staff.", "Confirm each staff member has the correct role.", "Use the school dashboard to review current activity."]),
    common("Support teaching", "fa-chalkboard-teacher", ["Check class and curriculum information.", "Ask staff to report missing or incorrect content.", "Review sync history when offline changes need attention."]),
    common("Account support", "fa-life-ring", ["Open Settings to choose defaults for this account.", "Use Report a problem for technical issues.", "Keep learner information out of screenshots where possible."]),
  ],
  superadmin: [
    common("Operate the platform", "fa-sliders-h", ["Use the Command Center to review platform activity.", "Check organization and account details before making changes.", "Do not use an impersonated session for privileged administration."]),
    common("Process bug reports", "fa-bug", ["Filter the inbox by status, severity, or sector.", "Open a report to review its description and screenshot.", "Record admin notes and set the correct status."]),
    common("Protect user data", "fa-user-shield", ["Treat screenshots and device details as private.", "Use only the minimum information needed to resolve a report.", "Do not copy secrets or credentials into admin notes."]),
  ],
  mfi_admin: [
    common("Review MFI operations", "fa-landmark", ["Open the MFI workspace and review assigned operations.", "Check member and lending records before approving changes.", "Use the appropriate reporting view for period summaries."]),
    common("Support staff", "fa-users", ["Confirm staff roles match their assigned duties.", "Direct repayment or borrower questions to the responsible officer.", "Review sync history when a saved item is delayed."]),
    common("Report an issue", "fa-life-ring", ["Include the affected MFI page and a short description.", "Attach a screenshot only when it contains no unnecessary personal data.", "Track progress in My reports."]),
  ],
  loan_officer: [
    common("Work with borrower records", "fa-user-tie", ["Open the borrower assigned to you.", "Confirm identity and account details before recording activity.", "Keep notes factual and relevant to the lending work."]),
    common("Record lending activity", "fa-file-invoice-dollar", ["Use the correct borrower and loan record.", "Check amounts and dates before saving.", "Review the confirmation before leaving the page."]),
    common("Get support", "fa-life-ring", ["Use Help for the officer workflow.", "Report technical errors with the affected page.", "Use Sync history to check whether offline work was sent."]),
  ],
  loan_manager: [
    common("Review lending work", "fa-tasks", ["Review assigned applications and servicing work.", "Check supporting records before making a decision.", "Follow your institution's approval process."]),
    common("Monitor team activity", "fa-users-cog", ["Review the records assigned to your team.", "Return incomplete work with a clear explanation.", "Use the available reports to monitor operations."]),
    common("Resolve platform issues", "fa-life-ring", ["Open Help for role-specific guidance.", "Report the page and steps that caused the issue.", "Check Sync history before asking staff to repeat work."]),
  ],
  loan_director: [
    common("Review portfolio information", "fa-chart-pie", ["Open MFI summaries for the reporting period.", "Check totals against the underlying lending records.", "Keep internal summaries distinct from statutory returns."]),
    common("Oversee approvals", "fa-user-shield", ["Review decisions requiring director oversight.", "Confirm supporting information before approval.", "Use admin notes for clear, factual follow-up."]),
    common("Get platform help", "fa-life-ring", ["Open Help for the director workflow.", "Report technical issues with page context.", "Check the status of your own reports in Settings."]),
  ],
  borrower: [
    common("Review your account", "fa-wallet", ["Open your borrower portal.", "Check the details and status shown for your account.", "Contact your MFI for questions about a lending decision."]),
    common("Keep records clear", "fa-file-alt", ["Review any repayment information before confirming it.", "Save or download documents offered in your portal.", "Do not share your password with anyone."]),
    common("Ask for help", "fa-life-ring", ["Use Report a problem for a technical issue.", "Describe the page without including private credentials.", "Follow your report status in Settings."]),
  ],
  clinic_admin: [
    common("Manage clinic operations", "fa-clinic-medical", ["Review the clinic workspace and staff access.", "Keep patient, appointment, and pharmacy records accurate.", "Use reports to monitor clinic activity."]),
    common("Support the care team", "fa-user-md", ["Confirm each team member has an appropriate role.", "Direct clinical decisions to authorized clinicians.", "Review pharmacy activity with the responsible staff."]),
    common("Report a platform issue", "fa-life-ring", ["Include the affected clinic page and steps to reproduce.", "Avoid unnecessary patient details in screenshots.", "Track progress in My reports."]),
  ],
  doctor: [
    common("Review patient care", "fa-user-md", ["Open the correct patient record before documenting care.", "Confirm details before saving a visit or prescription.", "Follow clinic policy for clinical decisions."]),
    common("Coordinate care", "fa-notes-medical", ["Review visit information and assigned follow-up.", "Use the prescription workflow for authorized orders.", "Contact clinic staff when a record needs correction."]),
    common("Get technical help", "fa-life-ring", ["Use the role guide for the clinic workflow.", "Report technical issues without unnecessary patient data.", "Check Sync history if a change is pending."]),
  ],
  nurse: [
    common("Prepare for a visit", "fa-user-nurse", ["Open the correct patient and appointment.", "Confirm the patient details before recording observations.", "Save the visit information in the correct record."]),
    common("Coordinate with clinicians", "fa-clipboard-list", ["Review the care team's instructions.", "Record only information within your role.", "Escalate urgent clinical concerns through clinic procedures."]),
    common("Report an issue", "fa-life-ring", ["Describe the affected clinic page.", "Avoid patient details that are not needed to explain the issue.", "Check My reports for updates."]),
  ],
  receptionist: [
    common("Manage appointments", "fa-calendar-check", ["Use the appointment workspace to find or register a patient.", "Confirm dates and contact details before saving.", "Tell the care team when an appointment changes."]),
    common("Support check-in", "fa-clipboard", ["Select the right patient record.", "Check the appointment status before completing check-in.", "Do not edit clinical notes or prescriptions."]),
    common("Get help", "fa-life-ring", ["Use Help for the receptionist workflow.", "Report technical issues with the affected page.", "Review Sync history if an offline update is pending."]),
  ],
  pharmacist: [
    common("Manage medicine stock", "fa-pills", ["Review the medicine and its unit before editing stock.", "Record stock adjustments with the correct quantity.", "Check the movement history after saving."]),
    common("Handle prescriptions", "fa-prescription-bottle-alt", ["Open the correct prescription.", "Confirm the medicine and quantity before dispensing.", "Follow clinic policy for any prescription concern."]),
    common("Report an issue", "fa-life-ring", ["Include the medicine page and action that failed.", "Do not include unnecessary patient information.", "Track the report in Settings."]),
  ],
  patient: [
    common("Review your clinic information", "fa-notes-medical", ["Open your patient portal.", "Check your appointments and information shown to you.", "Contact the clinic if a detail needs correction."]),
    common("Prepare for appointments", "fa-calendar-check", ["Review the date and time shown in your portal.", "Save any clinic documents offered to you.", "Ask clinic staff if you need help accessing your account."]),
    common("Get technical support", "fa-life-ring", ["Report a technical issue from Settings.", "Do not enter medical emergencies in a bug report.", "Follow the status of your report in My reports."]),
  ],
  farm_admin: [
    common("Set up farm operations", "fa-tractor", ["Review farms, workers, and assigned access.", "Confirm product and stock information before daily use.", "Keep authorization roles limited to the correct staff."]),
    common("Review sales and stock", "fa-chart-line", ["Review sale status before authorizing release.", "Check stock after goods are marked released.", "Use reports for confirmed farm activity."]),
    common("Support workers", "fa-users", ["Confirm worker assignments are current.", "Review sync history if an offline action is delayed.", "Use bug reports for platform problems."]),
  ],
  farm_manager: [
    common("Coordinate farm work", "fa-tractor", ["Review worker assignments and daily activity.", "Confirm produce quantities are recorded against the correct item.", "Check stock movement after a release."]),
    common("Review sale releases", "fa-box-open", ["Confirm payment before authorizing release.", "Record the release decision in the sale workflow.", "Close the sale after the release is complete."]),
    common("Get support", "fa-life-ring", ["Use Help for farm workflow guidance.", "Report technical issues with the affected page.", "Check Sync history before repeating an action."]),
  ],
  farm_worker: [
    common("Record farm work", "fa-seedling", ["Choose the correct farm and produce item.", "Enter the quantity carefully.", "Review the record before saving."]),
    common("Complete an authorized sale", "fa-box", ["Create the sale after agreeing with the buyer.", "Wait for the owner or manager to authorize release.", "Mark goods released only after authorization and handover."]),
    common("Check your updates", "fa-sync-alt", ["Open My Sales to review sale status.", "Use Sync history when a change is still pending.", "Report a technical problem without including private credentials."]),
  ],
};

export function getRoleGuide(role: string): GuideSection[] {
  return roleGuides[role] ?? [
    common("Use your workspace", "fa-home", ["Open the workspace assigned to your account.", "Review the information before saving changes.", "Ask your organization administrator about access."]),
    common("Keep your account safe", "fa-user-shield", ["Choose a secure password.", "Sign out on shared devices.", "Never include passwords in a support report."]),
    common("Get help", "fa-life-ring", ["Open the Help Center for guidance.", "Report the affected page and what happened.", "Review My reports for updates."]),
  ];
}
