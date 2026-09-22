// Extension entry point: registration, wiring, and disposal.

import * as vscode from 'vscode';
import { DataAttributeCompletionProvider } from './attributeCompletions';
import { SlimLintClient } from './client';
import { SlimCodeActionProvider } from './codeActions';
import { registerCommands } from './commands';
import { RailsDetectionCache, SnippetCompletionProvider } from './completions';
import { CONFIG_SECTION, loadConfig } from './config';
import { DiagnosticsController } from './diagnostics';
import { Logger } from './logger';
import { MissingExecutableNotice } from './missingExecutableNotice';
import { nodeResolveDeps } from './nodeDeps';
import { PartialCompletionProvider, PartialDefinitionProvider } from './partials';
import { GEMFILE_LOCK_NAME } from './pure/fsWalk';
import { APPLICATION_RB_SEGMENTS } from './pure/railsDetection';
import { registerRefactorCommands } from './refactorCommands';
import { isSlimDocument, openSlimDocuments } from './slimDocuments';
import { SLIM_LANGUAGE_ID } from './slimLint/eligibility';
import { CONFIG_FILE_NAME } from './slimLint/executable';
import { createProcessRunner, type DisposableProcessRunner } from './slimLint/process';

/** Code actions and partial navigation only apply where a local process can see the file. */
const SLIM_SELECTOR: vscode.DocumentSelector = [
  { language: SLIM_LANGUAGE_ID, scheme: 'file' },
  { language: SLIM_LANGUAGE_ID, scheme: 'untitled' }
];

/**
 * Held outside activate() so deactivate() can reach it. Cancellation is cooperative and arrives
 * token by token, so shutdown needs one explicit kill for whatever is still running. The runner is
 * *also* a subscription, so a second activate() cannot orphan the first runner's children;
 * dispose() is idempotent.
 */
let runnerToDispose: DisposableProcessRunner | undefined;

function watchFiles(pattern: string, onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  return watcher;
}

/**
 * `bundle install` fires create+change per lock in a burst, and a branch switch can touch
 * Gemfile.lock, .slim-lint.yml and .rubocop.yml together; one forced sweep at the end is enough.
 * Un-debounced, each event cancelled the previous event's in-flight runs and respawned Ruby for
 * every open document.
 */
const RULE_SWEEP_DELAY_MS = 500;

function trailingDebounce(action: () => void, delayMs: number): vscode.Disposable & { schedule(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    schedule(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        action();
      }, delayMs);
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  context.subscriptions.push(logger);

  // Trust is injected rather than read inside the process layer, so src/slimLint stays free of the
  // vscode module and the gate cannot be bypassed by a call site.
  const runner = createProcessRunner({ isTrusted: () => vscode.workspace.isTrusted });
  const fsDeps = nodeResolveDeps();
  const client = new SlimLintClient(runner, logger, fsDeps);
  context.subscriptions.push(runner);
  runnerToDispose = runner;

  const getConfig = (resource: vscode.Uri) => loadConfig(resource);
  const missingExecutable = new MissingExecutableNotice(logger, context.workspaceState);
  const diagnostics = new DiagnosticsController(client, logger, getConfig, missingExecutable);
  context.subscriptions.push(diagnostics);

  const codeActions = new SlimCodeActionProvider();
  // Snippets are declared as working everywhere, including virtual and untrusted workspaces, so
  // this one selector is broader than SLIM_SELECTOR: no process is ever started for a completion.
  const railsCache = new RailsDetectionCache(fsDeps);
  const completions = new SnippetCompletionProvider(railsCache, getConfig);
  // Partial navigation reads file names off the disk, so it needs the narrower selector even though
  // it starts no process: SLIM_SELECTOR is the line between "resolves a real path" and "does not".
  const partialDefinitions = new PartialDefinitionProvider(fsDeps);
  const partialCompletions = new PartialCompletionProvider(getConfig, fsDeps.platform);
  const attributeCompletions = new DataAttributeCompletionProvider(getConfig);

  /** Every path that has to reconsider open documents goes through here. */
  const sweep = (reason: string, force: boolean): void => {
    logger.info(`${reason}; re-linting open Slim documents`);
    for (const document of openSlimDocuments()) {
      diagnostics.refreshNow(document, force);
    }
  };

  const ruleSweep = trailingDebounce(() => sweep('lint rules or the bundle changed', true), RULE_SWEEP_DELAY_MS);

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(SLIM_SELECTOR, codeActions, SlimCodeActionProvider.metadata),
    vscode.languages.registerCompletionItemProvider(SLIM_LANGUAGE_ID, completions),
    vscode.languages.registerDefinitionProvider(SLIM_SELECTOR, partialDefinitions),
    // Trigger characters are per registration, which is why this cannot join the snippet provider
    // above. They are needed at all because the grammar hands `= render '...'` to source.ruby, so the
    // name is a Ruby string token and editor.quickSuggestions.strings defaults to off.
    vscode.languages.registerCompletionItemProvider(SLIM_SELECTOR, partialCompletions, "'", '"'),
    // No trigger characters here: an attribute name is not a string token, so the default
    // editor.quickSuggestions.other already opens the widget. Declaring '-' would also drag the
    // contributed Slim snippets in on every `- if`, since the trigger path always includes them.
    vscode.languages.registerCompletionItemProvider(SLIM_LANGUAGE_ID, attributeCompletions),
    ...registerCommands({ diagnostics, logger, getConfig, sweep }),
    ...registerRefactorCommands({ logger, fs: fsDeps })
  );

  /**
   * Re-lints every open Slim document, forced.
   *
   * Forced because the report already published for a document is keyed on its content, which a
   * changed rule does not alter, and because a document that timed out deserves another chance under
   * rules that may well be cheaper.
   */
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isSlimDocument(document)) {
        diagnostics.refreshNow(document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isSlimDocument(document)) {
        diagnostics.refreshNow(document);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isSlimDocument(event.document)) {
        diagnostics.refreshDebounced(event.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isSlimDocument(document)) {
        diagnostics.forget(document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        missingExecutable.reset();
        // The slow-run advice names a setting the user may have just changed, so it is worth giving
        // again rather than staying silenced for the rest of the session.
        client.resetNotices();
        // Forced: both the report already published for a document and the back-off recorded for one
        // that timed out were formed under the settings that just changed.
        sweep('settings changed', true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      railsCache.invalidate();
      // Forced for the same reason the config watchers force: the folder set moves cwd boundaries
      // and lock discovery, which change the answer without changing any text - and the report
      // reuse below is keyed on text alone.
      sweep('workspace folders changed', true);
    }),
    ruleSweep,
    // A changed lock file can flip the extension between bundle exec and the executable on PATH,
    // and can add or remove rails, which is what the Rails snippet detection looks for. The cache
    // drops immediately; only the re-lint is debounced.
    watchFiles(`**/${GEMFILE_LOCK_NAME}`, () => {
      railsCache.invalidate();
      ruleSweep.schedule();
    }),
    // The other Rails signal. `rails new --skip-bundle` writes this and no lock file, so without
    // watching it the "not a Rails project" verdict would stick for the rest of the session.
    watchFiles(`**/${APPLICATION_RB_SEGMENTS.join('/')}`, () => railsCache.invalidate()),
    // Neither of these is a VS Code setting, so onDidChangeConfiguration never fires for them.
    // .rubocop.yml counts because slim-lint delegates its Ruby cops to RuboCop, so a rule changed
    // there changes the offenses reported for a Slim file just as much. Debounced through the same
    // sweep as the lock file: a branch switch delivers these events together, and every forced
    // sweep bypasses the content-digest reuse by design, so back-to-back sweeps are pure respawn.
    watchFiles(`**/${CONFIG_FILE_NAME}`, () => ruleSweep.schedule()),
    watchFiles('**/.rubocop.yml', () => ruleSweep.schedule())
  );

  // Granting trust mid-session must not require a reload.
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(
      // Not forced: nothing already concluded was wrong, there simply was not a run before.
      vscode.workspace.onDidGrantWorkspaceTrust(() => sweep('workspace trust granted', false))
    );
  }

  sweep('extension activated', false);
}

export function deactivate(): void {
  // VS Code awaits this, which is the one chance to stop children that no token covers.
  runnerToDispose?.dispose();
  runnerToDispose = undefined;
}
