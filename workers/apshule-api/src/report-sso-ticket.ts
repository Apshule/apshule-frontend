import { SignJWT } from "jose";

export function canUseReportCardsSSO(user: {
  role: string;
  sector: string;
  schoolId: string | null;
}): boolean {
  return ["school", "school_admin", "teacher"].includes(user.role) &&
    user.sector === "education" &&
    user.schoolId !== null;
}

export async function createReportCardsTicket(
  user: { id: string; role: string; schoolId: string | null },
  secret: Uint8Array,
): Promise<string> {
  return new SignJWT({
    user_id: user.id,
    role: user.role,
    school_id: user.schoolId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(secret);
}
