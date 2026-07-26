// Command palette entries.

import * as vscode from 'vscode';
import type { DiagnosticsController } from './diagnostics';
import type { Logger } from './logger';
import { resolveSlimDocument } from './slimDocuments';
import type { SlimConfig } from './types';

export interface CommandDeps {
  readonly diagnostics: DiagnosticsController;
  readonly logger: Logger;
  readonly getConfig: (resource: vscode.Uri) => SlimConfig;
  /**
   * Re-lints every open Slim document.
   *
   * Injected rather than built here: the action needs diagnostics and the logger at once, so it can
   * only be assembled in activate(), and commands.ts cannot import extension.ts.
   */
  readonly sweep: (reason: string, force: boolean) => void;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('slim.lintFile', async (uri?: vscode.Uri) => {
      const document = await resolveSlimDocument(uri);
      if (document === undefined) {
        return;
      }
      // Forced: an explicit Lint File that reused an existing report, or declined to run because an
      // earlier run timed out, would look like the command did nothing.
      await deps.diagnostics.lint(document, deps.getConfig(document.uri), true);
    }),

    vscode.commands.registerCommand('slim.restartLinter', () => {
      // Forced, because "restart" has to mean every conclusion is dropped, including the report
      // already published and the back-off from a run that timed out.
      deps.sweep('linter state cleared', true);
    }),

    vscode.commands.registerCommand('slim.showOutput', () => {
      deps.logger.show();
    })
  ];
}
