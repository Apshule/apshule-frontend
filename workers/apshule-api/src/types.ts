export interface Env {
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  YO_API_USERNAME?: string;
  YO_API_PASSWORD?: string;
  YO_API_URL?: string;
  YO_IPN_URL?: string;
}

export type UserRole = "individual" | "teacher" | "school" | "superadmin";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  schoolId: string | null;
  sector: string;
  tokenId: string;
  tokenExpiresAt: number;
  impersonatedBy?: string;
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  sector: string;
  waitlist: boolean;
  school_id: string | null;
  education_level: string | null;
  class_level: string | null;
  subjects_taught: string[] | null;
  assigned_classes: string[] | null;
  lin: string | null;
  school_verified: boolean | null;
  address: string | null;
  profile_pic: string | null;
  subscription: string | null;
  subscription_active: boolean;
  subscription_date: string | null;
  login_count: number;
  last_login: string | null;
  detected_location: string | null;
  created_at: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthenticatedUser;
  };
};