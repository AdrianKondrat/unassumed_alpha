import { SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server";

export interface ConfigStatus {
  name: string;
  configured: boolean;
  message: string;
}

export const configStatuses: ConfigStatus[] = [
  {
    name: "Supabase",
    configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    message: "Supabase is not configured, so sign-in and all founder features are disabled. See the README.",
  },
  {
    name: "Supabase service role",
    configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    message: "SUPABASE_SERVICE_ROLE_KEY is not set, so rehearsal sessions cannot start. See the README.",
  },
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
