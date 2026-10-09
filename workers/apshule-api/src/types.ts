export interface Env {
  DATABASE_URL?: string;
  DOCS_BUCKET?: R2Bucket;
  JWT_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_FROM_NAME?: string;
  APP_URL?: string;
  PIXABAY_API_KEY?: string;
  YO_API_USERNAME?: string;
  YO_API_PASSWORD?: string;
  YO_BASE_URL?: string;
  YO_API_URL?: string;
  YO_IPN_URL?: string;
  SETTINGS_ENCRYPTION_KEY?: string;
}

export type UserRole =
  | "individual"
  | "teacher"
  | "school"
  | "superadmin"
  | "mfi_admin"
  | "loan_officer"
  | "loan_manager"
  | "loan_director"
  | "borrower"
  | "clinic_admin"
  | "doctor"
  | "nurse"
  | "receptionist"
  | "pharmacist"
  | "patient"
  | "farm_admin"
  | "farm_manager"
  | "farm_worker";

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
  gender: string | null;
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
  session_version?: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthenticatedUser;
  };
};