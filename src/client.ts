// Orchestrates a single slim-lint run for a document: resolve, spawn, interpret.
//
// Lives outside src/slimLint because it touches vscode (workspace folders, documents, tokens).
// Everything it decides is delegated to the pure modules there; what is left is request coalescing,
// the back-off bookkeeping and the logging.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from './logger';
import { buildLintArgs } from './slimLint/args';
import { type BackOffUpdate, backOffUpdateFor, shouldSkipForBackOff, type TimeoutRecord } from './slimLint/backOff';
import { applyCmdWrapper } from './slimLint/cmdWrapper';
import { classifyDocument } from './slimLint/eligibility';
import { buildEnv } from './slimLint/env';
import { type Invocation, type ResolveDeps, resolveConfigPath, resolveInvocation, stdinPathFor } from './slimLint/executable';
import { failure, interpretResult, isSkip, looksLikeMissingGem, type RunFailureReason, type RunResult } from './slimLint/outcome';
import type { ProcessRunner, SpawnResult } from './slimLint/process';
import type { SlimConfig } from './types';

const SLOW_RUN_MS = 3000;

export type { RunOutcome, RunResult } from './slimLint/outcome';

/** The slice of SlimLintClient the diagnostics layer needs. Narrow so it can be faked in tests. */
export interface LintRunner {
  resolve(document: vscode.TextDocument, config: SlimConfig): Invocation;
  run(document: vscode.TextDocument, config: SlimConfig, token?: vscode.CancellationToken, force?: boolean): Promise<RunResult>;
  forget(uri: vscode.Uri): void;
}

/** `null` for a buffer with no path of its own, which is what stdinPathFor expects. */
function fsPathOf(uri: vscode.Uri): string | null {
  return uri.scheme === 'file' ? uri.fsPath : null;
}

/**
 * getWorkspaceFolder matches by uri prefix, so it never matches `untitled:` - which would make the
 * eligibility rule "untitled needs a workspace folder" unsatisfiable and untitled linting dead code.
 * An untitled buffer belongs to the window, and the window's first folder is the conventional home.
 */
function workspaceFolderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder !== undefined) {
    return folder;
  }
  return uri.scheme === 'untitled' ? vscode.workspace.workspaceFolders?.[0] : undefined;
}

export class SlimLintClient {
  private readonly inFlight = new Map<string, Promise<RunResult>>();
  private readonly slowWarned = new Set<string>();
  /** Documents a run has already timed out on. See src/slimLint/backOff.ts for why. */
  private readonly timedOut = new Map<string, TimeoutRecord>();

  constructor(
    private readonly runner: ProcessRunner,
    private readonly logger: Logger,
    private readonly deps: ResolveDeps
  ) {}

  /** Resolves how slim-lint would be invoked for this document, without running it. */
  resolve(document: vscode.TextDocument, config: SlimConfig): Invocation {
    const folder = workspaceFolderFor(document.uri);
    // Not stdinPathFor: that one needs the cwd this call is about to derive, so it cannot be used
    // to derive it. The fallback differs for the same reason - there is no cwd yet to fall back to.
    const documentPath = fsPathOf(document.uri) ?? path.join(folder?.uri.fsPath ?? process.cwd(), 'untitled.slim');
    return resolveInvocation(
      {
        documentPath,
        workspaceFolderPath: folder?.uri.fsPath,
        executablePath: config.executablePath,
        useBundler: config.useBundler
      },
      this.deps
    );
  }

  /**
   * Runs slim-lint for a document, coalescing identical concurrent requests.
   *
   * The key includes the document version, so an explicit `Slim: Lint File` racing the save that
   * queued it shares one Ruby process instead of starting two. The parts are joined with a NUL byte
   * because it cannot appear in either of them, so no combination of values can collide.
   *
   * `force` skips the lookup: the settings or rule files just changed, so a run already in flight
   * was spawned under the old ones and its answer must not be handed to the request that exists to
   * replace it. The fresh promise overwrites the map entry, so later same-key callers join the run
   * that reflects the new state.
   */
  run(document: vscode.TextDocument, config: SlimConfig, token?: vscode.CancellationToken, force = false): Promise<RunResult> {
    const key = `${document.uri.toString()}\u0000${document.version}`;
    if (!force) {
      const existing = this.inFlight.get(key);
      if (existing !== undefined) {
        return existing;
      }
    }
    const promise = this.execute(document, config, token).finally(() => {
      // Only the entry this promise owns: a forced run may have overwritten it, and the abandoned
      // run finishing later must not delete the fresh entry out from under its coalesced callers.
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Drops what the client remembers about a document: the timeout back-off, so an explicit user
   * action always runs, and any in-flight coalescing entries. Evicting those matters on close: a
   * reopened document restarts its versions at 1, so a cancelled run still draining out of the
   * process queue holds the exact key the reopened document's first lint would otherwise join -
   * and inherit `cancelled` from, leaving the file undiagnosed until its next edit. The abandoned
   * promise still settles for its own callers; its identity-checked cleanup in run() cannot touch
   * entries created after this.
   */
  forget(uri: vscode.Uri): void {
    this.timedOut.delete(uri.toString());
    const prefix = `${uri.toString()}\u0000`;
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
  }

  /** Settings changed, so advice keyed on the previous ones is worth giving again. */
  resetNotices(): void {
    this.slowWarned.clear();
  }

  private async execute(document: vscode.TextDocument, config: SlimConfig, token?: vscode.CancellationToken): Promise<RunResult> {
    const source = document.getText();
    const folder = workspaceFolderFor(document.uri);
    const eligibility = classifyDocument({
      scheme: document.uri.scheme,
      languageId: document.languageId,
      isClosed: document.isClosed,
      textLength: source.length,
      hasWorkspaceFolder: folder !== undefined
    });
    if (!eligibility.ok) {
      return failure('not-eligible', eligibility.reason);
    }

    const documentKey = document.uri.toString();
    if (shouldSkipForBackOff(this.timedOut.get(documentKey), source.length, config.timeoutMs)) {
      return failure('timed-out-before', 'a previous run timed out on this document');
    }

    const workspaceFolderPath = folder?.uri.fsPath;
    let invocation = this.resolve(document, config);
    const args = this.buildArgs(invocation.cwd, document, config, workspaceFolderPath);
    let result = await this.spawn(invocation, args, source, config, token);

    // `bundle exec slim-lint` when the gem is not in the bundle fails with a non-zero exit and a
    // message on stderr, not ENOENT, so it never reaches the missing-executable path.
    if (invocation.usesBundler && looksLikeMissingGem(result)) {
      this.logger.warn(`bundle exec could not find slim_lint; retrying with the executable on PATH. ${result.ok ? result.stderr.trim() : ''}`);
      invocation = this.resolve(document, { ...config, useBundler: 'never' });
      const retryArgs = this.buildArgs(invocation.cwd, document, config, workspaceFolderPath);
      result = await this.spawn(invocation, retryArgs, source, config, token);
    }

    this.applyBackOff(documentKey, document, backOffUpdateFor(result, source.length, config.timeoutMs), config.timeoutMs);

    // `invocation` is the retried one when the missing-gem path ran, which is the command an exit
    // 127 has to be reported against.
    const interpreted = interpretResult(result, invocation.command);
    if (!interpreted.ok) {
      this.logFailure(interpreted.reason, interpreted.detail, result);
    }
    return interpreted;
  }

  private applyBackOff(documentKey: string, document: vscode.TextDocument, update: BackOffUpdate, timeoutMs: number): void {
    if (update.kind === 'clear') {
      this.timedOut.delete(documentKey);
      return;
    }
    if (update.kind === 'keep') {
      return;
    }
    this.timedOut.set(documentKey, update.record);
    this.logger.warn(
      `slim-lint timed out after ${timeoutMs}ms on ${path.basename(document.uri.path)} (${Math.round(update.record.bytes / 1024)} KB). ` +
        'Automatic runs for it are paused until it is smaller, "slim.slimLint.timeoutMs" is raised, or "Slim: Lint File" is run. ' +
        'slim-lint costs disproportionately more on a large file, so retrying on every save would only burn the same time again.'
    );
  }

  /**
   * Interpretation says what happened; this decides how loudly to say it.
   *
   * A skip is the extension's own decision and gets nothing: `cancelled` alone would otherwise put
   * a line in the output channel on most keystrokes under onType.
   */
  private logFailure(reason: RunFailureReason, detail: string | undefined, result: SpawnResult): void {
    if (isSkip(reason)) {
      return;
    }
    if (reason === 'unparseable-report') {
      this.logger.warn(detail ?? 'could not parse the slim-lint report; keeping the previous diagnostics');
      this.logger.detail('raw output', result.ok ? result.stdout || result.stderr : result.stderr);
      return;
    }
    if (reason !== 'timeout') {
      // applyBackOff already explains a timeout, remedy included. Everything else that went wrong
      // logs its detail here: for a spawn EACCES or an overflow this line is the only explanation
      // there is, since neither produces any stderr.
      this.logger.error(detail ?? `slim-lint failed (${reason})`);
    }
    if (reason === 'exit' && result.ok) {
      // bin/slim-lint builds its logger on $stdout, so the sentence that explains a 64, 70 or 78 -
      // the YAML error, the rejected flag, the backtrace - arrives there and stderr stays empty.
      this.logger.detail('stdout', result.stdout);
    }
    if (result.stderr.trim() !== '') {
      this.logger.detail('stderr', result.stderr);
    }
  }

  private buildArgs(cwd: string, document: vscode.TextDocument, config: SlimConfig, workspaceFolderPath: string | undefined): string[] {
    const configPath = resolveConfigPath(config.configPath, workspaceFolderPath, this.deps.platform);
    const stdinPath = stdinPathFor(fsPathOf(document.uri), cwd, this.deps.platform);
    return buildLintArgs({ stdinPath, configPath });
  }

  private async spawn(
    invocation: Invocation,
    args: readonly string[],
    stdin: string,
    config: SlimConfig,
    token?: vscode.CancellationToken
  ): Promise<SpawnResult> {
    const fullArgs = [...invocation.argsPrefix, ...args];
    const wrapped = applyCmdWrapper(invocation.command, fullArgs, invocation.needsCmdWrapper, process.env.ComSpec, process.env.SystemRoot);
    this.logger.command(wrapped.command, wrapped.args, invocation.cwd);

    const result = await this.runner.run(
      {
        command: wrapped.command,
        args: wrapped.args,
        cwd: invocation.cwd,
        stdin,
        env: buildEnv(process.env, { bundleGemfile: invocation.bundleGemfile }),
        timeoutMs: config.timeoutMs,
        windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
        // The runner answers ENOENT for this without spawning, after its trust and cancellation
        // checks - so an unresolved command in an untrusted workspace stays a silent skip.
        commandMissing: invocation.commandMissing
      },
      token
    );

    if (result.ok && result.durationMs > SLOW_RUN_MS && !this.slowWarned.has(invocation.command)) {
      this.slowWarned.add(invocation.command);
      this.logger.warn(
        `slim-lint took ${result.durationMs}ms. If this is slow for you, a globally installed slim-lint is usually 3-5x faster than bundle exec; set "slim.slimLint.useBundler": "never".`
      );
    }
    return result;
  }
}
