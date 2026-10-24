// Which data the app runs on, and whether writes are allowed. Pure, so it is unit tested.
//   live    production, read-only, signed in with Google (build with VITE_ARI_DATA=live plus the three VITE_ARI_* values)
//   mock    synthetic rows through the in-memory PostgREST fixture, writes work (default; e2e and design lint run here)
//   legacy  the older in-memory synthetic layer
// URL overrides: ?data=mock or ?data=legacy (any build, for UI tests on a live build), ?ro=1 (read-only UI over synthetic rows).
export type DataMode = 'live' | 'mock' | 'legacy';
export interface Mode { data: DataMode; readOnly: boolean }
export interface LiveEnv { url: string; apikey: string; googleClientId: string; workspaceId?: string }

export function resolveMode(env: Record<string, string | undefined>, search: string): Mode {
  const p = new URLSearchParams(search);
  const asked = p.get('data');
  const data: DataMode = asked === 'mock' || asked === 'legacy' ? asked : env.VITE_ARI_DATA === 'live' ? 'live' : 'mock';
  return { data, readOnly: data === 'live' || p.get('ro') === '1' };
}

/** The live config, or the names of the missing build values. */
export function liveEnv(env: Record<string, string | undefined>): LiveEnv | string[] {
  const need = { url: 'VITE_ARI_SUPABASE_URL', apikey: 'VITE_ARI_SUPABASE_KEY', googleClientId: 'VITE_ARI_GOOGLE_CLIENT_ID' } as const;
  const missing = Object.values(need).filter((k) => !env[k]?.trim());
  if (missing.length) return missing;
  return { url: env[need.url]!.replace(/\/+$/, ''), apikey: env[need.apikey]!, googleClientId: env[need.googleClientId]!, workspaceId: env.VITE_ARI_WORKSPACE_ID || undefined };
}
