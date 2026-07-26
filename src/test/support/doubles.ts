// Test doubles shared by the suites that drive the lint pipeline.
//
// `import type * as vscode` is deliberate: it is erased at emit, so this module stays loadable by
// the plain-Node runner even though it names vscode.Memento. Anything needing the real API belongs
// in host.ts instead.

import type * as vscode from 'vscode';
import type { LintRunner, RunResult } from '../../client';
import { normalizeConfig } from '../../configSchema';
import type { Invocation } from '../../slimLint/executable';
import type { SlimConfig } from '../../types';

/** A resolved invocation that never runs: every consumer stubs the runner. */
export const INVOCATION: Invocation = {
  command: '/usr/bin/slim-lint',
  argsPrefix: [],
  cwd: '/repo',
  usesBundler: false,
  needsCmdWrapper: false,
  commandMissing: false
};

export function config(overrides: Partial<SlimConfig> = {}): SlimConfig {
  return { ...normalizeConfig({}), ...overrides };
}

/** An in-memory Memento so a test never writes to the real workspace state. */
export function memento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: (<T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback)) as vscode.Memento['get'],
    async update(key: string, value: unknown) {
      store.set(key, value);
    }
  };
}

export interface StubLintRunner extends LintRunner {
  /** One entry per run that reached the client, which is what "one Ruby process per save" means. */
  runs: number;
  forgotten: number;
}

/** Counts the runs that reach the client and answers each with whatever `outcome` decides. */
export function stubLintRunner(outcome: () => RunResult, invocation: Invocation = INVOCATION): StubLintRunner {
  const runner: StubLintRunner = {
    runs: 0,
    forgotten: 0,
    resolve: (): Invocation => invocation,
    async run(): Promise<RunResult> {
      runner.runs++;
      return outcome();
    },
    forget(): void {
      runner.forgotten++;
    }
  };
  return runner;
}
