// Diagnostic collection, listeners and debouncing.

import * as vscode from 'vscode';
import type { LintRunner } from './client';
import { snapshotOf } from './documentSnapshot';
import type { Logger } from './logger';
import type { MissingExecutableNotice } from './missingExecutableNotice';
import { DIAGNOSTIC_SOURCE, mapOffenses } from './pure/diagnosticMapper';
import { digestOf, isStale, shouldReuseReport } from './pure/publishDecision';
import { SLIM_LANGUAGE_ID } from './slimLint/eligibility';
import type { SlimConfig } from './types';

function toSeverity(severity: 'error' | 'warning'): vscode.DiagnosticSeverity {
  return severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
}

/**
 * slim-lint's own top-level `exclude:` never applies to a --stdin-file-path run: the piped document
 * bypasses the file finder that would apply it. This setting is the honest replacement.
 *
 * A string pattern in a DocumentFilter is matched against the absolute path, so on its own only a
 * `**`-led glob ever matches - and the globs a user brings over from `exclude:` are relative to the
 * project. Each pattern is therefore tried against the workspace folder as well.
 */
function isExcluded(document: vscode.TextDocument, patterns: readonly string[]): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return patterns.some(
    (pattern) =>
      vscode.languages.match({ pattern }, document) > 0 ||
      (folder !== undefined && vscode.languages.match({ pattern: new vscode.RelativePattern(folder, pattern) }, document) > 0)
  );
}

export class DiagnosticsController implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  /**
   * One entry per document, tagged with the version it belongs to.
   *
   * Cancelling on every request would be wrong: SlimLintClient coalesces requests that share a
   * document version, so a second request for the same version receives the first one's promise -
   * after having cancelled it. Opening a file and immediately running `Slim: Lint File` would then
   * silently produce no diagnostics at all. Only a genuinely superseded run is cancelled.
   */
  private readonly cancellations = new Map<string, { version: number; source: vscode.CancellationTokenSource }>();
  /** Guards against a killed process resolving after a newer request already published. */
  private readonly generations = new Map<string, number>();
  /**
   * The text each document's published diagnostics were produced from.
   *
   * Under onType the save that ends a burst of keystrokes asks about text the debounced run already
   * reported on: same content, new version, so the client cannot coalesce them - but the answer is
   * the same, and a Ruby boot is the entire cost of a run. Keyed on content rather than on the
   * version for exactly that reason: an undo or a no-op save moves the version, not the answer.
   */
  private readonly publishedFor = new Map<string, string>();

  constructor(
    private readonly client: LintRunner,
    private readonly logger: Logger,
    private readonly getConfig: (resource: vscode.Uri) => SlimConfig,
    private readonly notice: MissingExecutableNotice
  ) {
    this.collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  }

  /**
   * Called when a document is opened or saved.
   *
   * `force` is for the paths that invalidate what has already been concluded - a settings change, or
   * the user asking for a restart - since the reuse below is keyed on content, which a settings
   * change does not alter.
   */
  refreshNow(document: vscode.TextDocument, force = false): void {
    const config = this.getConfig(document.uri);
    if (config.lintRun === 'off') {
      // Disarming matters: lint() deliberately does not re-check lintRun, because `Slim: Lint File`
      // has to run whatever the setting says. A timer left armed here would fire a moment later and
      // repopulate the panel the user just switched off - and so would a run already in flight,
      // whose staleness check has nothing to trip on (same version, same generation). forget()
      // cancels that run and drops its generation, so its result can never publish.
      this.forget(document);
      return;
    }
    this.detached('lint', this.lint(document, config, force));
  }

  /** Called on every keystroke; only acts when the user opted into onType. */
  refreshDebounced(document: vscode.TextDocument): void {
    const config = this.getConfig(document.uri);
    const key = document.uri.toString();
    // Before the guard, so switching away from onType also disarms whatever is already pending.
    this.cancelDebounce(key);
    if (config.lintRun !== 'onType') {
      return;
    }
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.detached('lint', this.lint(document, this.getConfig(document.uri)));
      }, config.lintDebounceMs)
    );
  }

  private cancelDebounce(key: string): void {
    const timer = this.debounceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
  }

  /**
   * Runs background work whose failure would otherwise be invisible.
   *
   * lint() builds vscode.Diagnostic, Range and Uri.parse from a report a workspace executable
   * produced, so a throw here is an unhandled rejection: a "the extension crashed" notification with
   * nothing in the output channel to explain it.
   */
  private detached(what: string, work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      this.logger.error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Publishes diagnostics from a report.
   *
   * `source` is the document text the report describes, and is not optional: recording its digest is
   * what lets the next request for identical text reuse this report instead of starting a second
   * Ruby process.
   */
  publish(document: vscode.TextDocument, offenses: Parameters<typeof mapOffenses>[0], source: string): void {
    if (document.isClosed) {
      return;
    }
    // Re-checked here rather than trusted from lint()'s entry: the run awaited in between, and
    // `slim.lint.exclude` may have changed while it was in flight.
    if (isExcluded(document, this.getConfig(document.uri).lintExclude)) {
      return;
    }
    const specs = mapOffenses(offenses, snapshotOf(document));
    this.collection.set(
      document.uri,
      specs.map((spec) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(spec.start.line, spec.start.character, spec.end.line, spec.end.character),
          spec.message,
          toSeverity(spec.severity)
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        if (spec.code !== undefined) {
          diagnostic.code = { value: spec.code.value, target: vscode.Uri.parse(spec.code.target) };
        }
        return diagnostic;
      })
    );
    // After the collection, not before: the digest asserts "the panel shows this text's report", and
    // recording it first would let a throw above pin an empty panel as published forever.
    this.publishedFor.set(document.uri.toString(), digestOf(source));
  }

  clear(document: vscode.TextDocument): void {
    // Diagnostics that are gone are not a report anyone can reuse.
    this.publishedFor.delete(document.uri.toString());
    this.collection.delete(document.uri);
  }

  /** Cancels any in-flight run for a document and forgets its state. */
  forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.publishedFor.delete(key);
    this.client.forget(document.uri);
    this.cancelDebounce(key);
    const inFlight = this.cancellations.get(key);
    if (inFlight !== undefined) {
      inFlight.source.cancel();
      inFlight.source.dispose();
      this.cancellations.delete(key);
    }
    this.generations.delete(key);
    this.collection.delete(document.uri);
  }

  async lint(document: vscode.TextDocument, config: SlimConfig, force = false): Promise<void> {
    if (document.languageId !== SLIM_LANGUAGE_ID) {
      return;
    }
    if (isExcluded(document, config.lintExclude)) {
      this.clear(document);
      return;
    }

    const key = document.uri.toString();
    const source = document.getText();
    if (force) {
      // The digest goes now, not when the forced run publishes: it may never get to. A run dropped
      // as stale or answered with an unparseable report leaves the panel as it was, and a digest
      // left beside it would let the next save reuse a report formed under the old rules.
      this.publishedFor.delete(key);
      this.client.forget(document.uri);
    } else if (shouldReuseReport(this.publishedFor.get(key), source, force)) {
      // The diagnostics on screen were produced by slim-lint from exactly this text, under settings
      // that have not changed since - every path that changes them forces. Running again would spend
      // a Ruby boot to arrive at what is already displayed.
      return;
    }

    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);

    const version = document.version;
    const previous = this.cancellations.get(key);
    // A forced request also abandons a same-version run: it was started under settings or rule files
    // that just changed. Sharing its token source instead would leave whichever run finishes second
    // uncancellable, because the first one to return disposes the shared source.
    if (previous !== undefined && (previous.version !== version || force)) {
      previous.source.cancel();
      previous.source.dispose();
      this.cancellations.delete(key);
    }
    let entry = this.cancellations.get(key);
    if (entry === undefined) {
      entry = { version, source: new vscode.CancellationTokenSource() };
      this.cancellations.set(key, entry);
    }

    const result = await this.client.run(document, config, entry.source.token, force);

    if (this.cancellations.get(key) === entry) {
      entry.source.dispose();
      this.cancellations.delete(key);
    }

    const stale = isStale({
      superseded: this.generations.get(key) !== generation,
      isClosed: document.isClosed,
      versionBefore: version,
      versionNow: document.version
    });
    if (stale) {
      // A newer request already owns this document, or the buffer moved on.
      return;
    }

    if (result.ok) {
      // `source` rather than a fresh getText(): it is the exact text handed to slim-lint, and the
      // version guard above has already established that the buffer still holds it.
      this.publish(document, result.outcome.report?.offenses ?? [], source);
      return;
    }

    if (result.reason === 'unparseable-report') {
      // Deliberately leaves the previous diagnostics in place: silently emptying the panel turns a
      // polluted stream into an unexplainable bug report.
      return;
    }
    if (result.reason === 'enoent') {
      // The run itself says which command it could not find: after the missing-gem retry that is
      // the PATH executable, which re-resolving under the original config would never name - it
      // answers the bundle command that ran fine. The resolve() fallback covers a result built
      // without one; resolve() only reads the filesystem, so it costs no more here than it did
      // inside the notice.
      this.detached('the missing-executable notice', this.notice.show(result.command ?? this.client.resolve(document, config).command));
    }
    this.clear(document);
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const entry of this.cancellations.values()) {
      entry.source.cancel();
      entry.source.dispose();
    }
    this.cancellations.clear();
    this.generations.clear();
    this.publishedFor.clear();
    this.collection.dispose();
  }
}
