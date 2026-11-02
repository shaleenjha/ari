// Fixture. The command half of the REST layer, for the synthetic MockPostgrest only (mock mode, unit tests, e2e).
// It takes a MockPostgrest, never a URL or a fetch, so it cannot be pointed at a real backend. The live app is read-only
// (lint rule no-client-writes keeps writes out of app/web/src outside tests and fixtures).
import type { CommandResult, HygieneAction, MarkField, Task } from '../types';
import { RestData, RestError } from '../rest';
import type { MockPostgrest } from './pgmock';

export class SyntheticRestData extends RestData {
  constructor(m: MockPostgrest, ws: string, jwt: string) { super(m.fetch, '', ws, jwt); }
  private async command<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.f(`/rest/v1/rpc/${fn}`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ p_ws: this.ws, ...args }) });
    if (!r.ok) throw new RestError(r.status, `${fn}: ${r.status}`);
    return (await r.json()) as T;
  }
  override async mark(personId: string, field: MarkField, opId: string): Promise<CommandResult> {
    return this.command<CommandResult>('person_mark', { p_person: personId, p_field: field, p_op: opId });
  }
  override async transition(taskId: string, to: Task['status'], expectedVersion: number, opId: string): Promise<CommandResult> {
    return this.command<CommandResult>('task_transition', { p_task: taskId, p_to: to, p_expected_version: expectedVersion, p_op: opId });
  }
  override async resolveHygiene(findingId: string, action: HygieneAction, opId: string, keepId?: string): Promise<CommandResult> {
    return this.command<CommandResult>('hygiene_resolve', { p_finding: findingId, p_action: action, p_keep: keepId ?? null, p_op: opId });
  }
  override async confirmWho(eventId: string, personId: string | null, opId: string): Promise<CommandResult> {
    return this.command<CommandResult>('ingest_confirm_match', { p_event: eventId, p_person: personId, p_op: opId });
  }
}
