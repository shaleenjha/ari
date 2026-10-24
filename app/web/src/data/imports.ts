// The import card's two calls, behind one seam like data/client.ts. main.tsx sets the resolver per data mode:
//   mock and legacy  fixtures/importPlans.ts (synthetic plans, no network)
//   live             not set yet. import_resolve is a POST to the ari-ai function, and the no-client-writes rule refuses
//                    every non-GET outside the sign-in path, with no allow escape. Wiring it needs that rule to name the
//                    ari-ai read actions first (Owner's call, Bastion review). Until then the card says checking is off.
import type { Choices, ImportPlan, ImportRow } from './importPlan';

/** Why a check failed, from the function's error codes (400 bad_request, 413 too_large, 429 spend_limit, 401). */
export type ResolveError = 'bad_request' | 'too_large' | 'spend_limit' | 'unauthorized' | 'failed';
export class ImportResolveError extends Error { constructor(public code: ResolveError) { super(code); } }
export type ImportResolver = (rows: ImportRow[]) => Promise<ImportPlan>;

let resolver: ImportResolver | null = null;
export const setImportResolver = (r: ImportResolver | null): void => { resolver = r; };
export const importResolver = (): ImportResolver | null => resolver;

/** Map an HTTP status and body from import_resolve to a ResolveError. Pure, for the live caller and its tests. */
export function resolveErrorOf(status: number, body: unknown): ResolveError {
  const e = (body as { error?: string } | null)?.error;
  if (status === 413 || e === 'too_large') return 'too_large';
  if (status === 429 || e === 'spend_limit') return 'spend_limit';
  if (status === 401 || e === 'unauthorized') return 'unauthorized';
  if (status === 400 || e === 'bad_request') return 'bad_request';
  return 'failed';
}

/** One plain line per failure, for the card. */
export const RESOLVE_ERROR_LINE: Record<ResolveError, string> = {
  bad_request: 'Some rows could not be read. Each row needs a name and a company.',
  too_large: 'This file is too big to check at once. Split it into smaller files.',
  spend_limit: 'Ari reached its spend limit for today. Nothing was checked.',
  unauthorized: 'Sign in again to check this file.',
  failed: 'Could not check this file. Nothing was added. Pick it again to retry.',
};

export type ApplyResult = { applied: false; reason: 'not_built' };
/**
 * Apply the Owner's choices. A write, so it belongs to stage S3 Diamond (the import job applies the plan with its 24 h
 * undo). Not built: this sends nothing and saves nothing.
 * TODO(Diamond S3): hand { plan, choices } to the import job command once Diamond's write path exists.
 */
export async function applyImportPlan(_plan: ImportPlan, _choices: Choices): Promise<ApplyResult> {
  return { applied: false, reason: 'not_built' };
}
