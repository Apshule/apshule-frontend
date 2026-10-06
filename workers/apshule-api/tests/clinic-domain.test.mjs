import assert from "node:assert/strict";
import test from "node:test";
import {
  CLINIC_STAFF_ROLES,
  formatClinicPatientNumber,
  isClinicDate,
  isClinicImageDataUrl,
  isClinicStaffRole,
} from "../src/clinic-domain.ts";

test("Clinic staff roles include only the four provisioned staff types", () => {
  assert.deepEqual(CLINIC_STAFF_ROLES, ["doctor", "nurse", "receptionist", "pharmacist"]);
  for (const role of CLINIC_STAFF_ROLES) assert.equal(isClinicStaffRole(role), true);
  assert.equal(isClinicStaffRole("clinic_admin"), false);
  assert.equal(isClinicStaffRole("superadmin"), false);
});

test("Clinic patient numbers use the monthly PAT format and enforce the sequence range", () => {
  assert.equal(formatClinicPatientNumber("202610", 1), "PAT-202610-0001");
  assert.equal(formatClinicPatientNumber("202610", 9999), "PAT-202610-9999");
  assert.throws(() => formatClinicPatientNumber("2026-10", 1), RangeError);
  assert.throws(() => formatClinicPatientNumber("202610", 10000), RangeError);
});

test("Clinic date validation rejects impossible calendar dates", () => {
  assert.equal(isClinicDate("2000-02-29"), true);
  assert.equal(isClinicDate("2026-02-29"), false);
  assert.equal(isClinicDate("2026-13-01"), false);
  assert.equal(isClinicDate("not-a-date"), false);
});

test("Clinic photo validation accepts only JPEG, PNG, and WebP data URLs up to 200 KiB", () => {
  const atLimit = `data:image/jpeg;base64,${"A".repeat(4 * Math.floor((200 * 1024) / 3))}AAA=`;
  const overLimit = `data:image/png;base64,${"A".repeat(4 * (Math.ceil((200 * 1024 + 1) / 3)))}`;
  assert.equal(isClinicImageDataUrl(atLimit), true);
  assert.equal(isClinicImageDataUrl(overLimit), false);
  assert.equal(isClinicImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isClinicImageDataUrl("data:image/jpeg;base64,not-base64"), false);
});
