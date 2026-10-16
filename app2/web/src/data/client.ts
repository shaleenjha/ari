// The data layer every screen talks to. Two implementations: MockData (synthetic, used now and in e2e)
// and, later, SupabaseData calling the app2 command RPCs (app.task_create, app.task_transition, app.person_mark ...).
import type { Account, Activity, Brief, CommandResult, Draft, MarkField, Person, Reply, Task, TaskStatus, Uuid, WeekReport } from './types';

export interface DataLayer {
  queue(): Promise<Task[]>;
  today15(): Promise<Person[]>;
  replies(): Promise<Reply[]>;
  account(id: Uuid): Promise<{ account: Account; people: Person[]; brief?: Brief; tasks: Task[]; activity: Activity[] } | null>;
  accounts(): Promise<Account[]>;
  person(id: Uuid): Promise<Person | null>;
  draft(personId: Uuid, kind: Draft['kind']): Promise<Draft | null>;
  week(): Promise<WeekReport>;
  mark(personId: Uuid, field: MarkField, opId: string): Promise<CommandResult>;
  transition(taskId: Uuid, to: TaskStatus, expectedVersion: number, opId: string): Promise<CommandResult>;
}

let current: DataLayer | null = null;
export const setData = (d: DataLayer): void => { current = d; };
export const data = (): DataLayer => {
  if (!current) throw new Error('data layer not set');
  return current;
};
export const opId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
