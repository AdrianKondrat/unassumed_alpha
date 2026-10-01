import { SUPABASE_URL, SUPABASE_KEY } from "astro:env/server";

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
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
