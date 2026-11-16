/**
 * Shared ambient type definitions for backend Workers / Pages Functions / Hono modules.
 */

interface AppBindings {
  DB: D1Database;
  BASEBALL_DB: D1Database;
  CHAT_DB: D1Database;
  COMMUNITY_PRESET?: string;
  COMMUNITY_NAME?: string;
  APP_NAME?: string;
  PUBLIC_ORIGIN?: string;
  LOCK_PREVIEW_ORIGIN?: string | number | boolean;
  FROM_EMAIL?: string;
  REPLY_TO_EMAIL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_NAME?: string;
  HANDBOOK_URL?: string;
  MAIL_PROVIDER?: string;
  STORAGE_PROVIDER?: string;
  TURN_ICE_SERVERS_JSON?: string;
  WAIVER_SIGNING_SECRET?: string;
  WAIVER_RETENTION_YEARS?: string | number;
  FEATURE_BATTING_PRACTICE?: string | number | boolean;
  FEATURE_CERTIFIED_SHIFTS?: string | number | boolean;
  FEATURE_SUNDAY_PRIORITY?: string | number | boolean;
  BREVO_API_KEY?: string;
  NODE_ENV?: string;
  RATE_LIMIT_SECRET?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  GDRIVE_CLIENT_ID?: string;
  GDRIVE_CLIENT_SECRET?: string;
  GDRIVE_REFRESH_TOKEN?: string;
  GDRIVE_FOLDER_ID?: string;
  GDRIVE_GIFS_FOLDER_ID?: string;
  APPSCRIPT_UPLOAD_URL?: string;
  [key: string]: any;
}

interface ResolvedBootConfig {
  COMMUNITY_PRESET: 'generic-community' | 'pickup-baseball';
  COMMUNITY_NAME: string;
  PUBLIC_ORIGIN: string;
  LOCK_PREVIEW_ORIGIN: boolean;
  ADMIN_EMAIL: string;
  FROM_EMAIL: string;
  REPLY_TO_EMAIL: string;
  HANDBOOK_URL: string;
  MAIL_PROVIDER: 'resend' | 'brevo' | 'mock';
  STORAGE_PROVIDER: 'r2' | 'gdrive' | 'local';
  TURN_ICE_SERVERS: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  TURN_CONFIGURED: boolean;
  WAIVER_SIGNING_SECRET: string;
  WAIVER_RETENTION_YEARS: number;
  FEATURE_BATTING_PRACTICE: boolean;
  FEATURE_CERTIFIED_SHIFTS: boolean;
  FEATURE_SUNDAY_PRIORITY: boolean;
}

interface AppUser {
  id: number;
  name: string;
  email: string;
  bio: string;
  avatarUrl: string;
  avatar_url: string;
  role: string;
  isAdmin: boolean;
  is_admin: number;
  isModerator: boolean;
  is_moderator: number;
  canModerateChat: boolean;
  canModerate: boolean;
  chatMuted: boolean;
  chat_muted: number;
  chatMutedReason: string | null;
  chat_muted_reason: string | null;
  chatMutedAt: string | null;
  chat_muted_at: string | null;
  canManageEvents: boolean;
  can_manage_events: boolean;
  machineBadge: boolean;
  machine_badge: number;
  fieldBadge: boolean;
  field_badge: number;
  heroCredits: number;
  hero_credits: number;
  waiverStatus: string;
  waiver_status: string;
  waiverSigned: boolean;
  waiver_signed: boolean;
  waiverSignedAt: string | null;
  waiver_signed_at: string | null;
  playingSunday: boolean;
  playing_sunday: boolean;
  isGameFacilitator: boolean;
  is_game_facilitator: boolean;
  hasKeys: boolean;
  has_keys: boolean;
  privacyRelayMode: number;
  privacy_relay_mode: number;
  clubhouseOptedIn: boolean;
  clubhouse_opted_in: number;
  calendarToken: string | null;
  calendar_token: string | null;
  sessionIsTemporary: boolean;
  session_is_temporary: number;
  [key: string]: any;
}

interface AppVariables {
  user: AppUser | null;
  [key: string]: any;
}

interface AppEnv {
  Bindings: AppBindings;
  Variables: AppVariables;
}

type AppHono = import('hono').Hono<AppEnv>;
type AppContext = import('hono').Context<AppEnv>;
type AppNext = import('hono').Next;

declare module 'node:dns/promises' {
  export function lookup(hostname: string, options: { all: true }): Promise<Array<{ address: string; family: number }>>;
}
