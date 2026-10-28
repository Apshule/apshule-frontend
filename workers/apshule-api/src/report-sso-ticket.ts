import { SignJWT } from "jose";

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
