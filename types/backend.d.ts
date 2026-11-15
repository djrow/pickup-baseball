/**
 * Shared ambient type definitions for backend Workers / Pages Functions / Hono modules.
 */

interface AppBindings {
  DB: D1Database;
  BASEBALL_DB: D1Database;
  CHAT_DB: D1Database;
  APP_NAME?: string;
  FROM_EMAIL?: string;
  REPLY_TO_EMAIL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_NAME?: string;
  PUBLIC_ORIGIN?: string;
  NODE_ENV?: string;
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
