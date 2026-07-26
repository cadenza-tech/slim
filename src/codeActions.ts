// Code actions.
//
// slim-lint reports no column, so a quick fix cannot honestly target anything narrower than the
// line. What it can offer per line are the disable comments, which need no subprocess at all.

import * as vscode from 'vscode';
import { eolOf, snapshotOf } from './documentSnapshot';
import { buildDisableComment, disableActionTitle, planDisableActions } from './pure/disableComment';

export class SlimCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  };

  /** Pure text edits, so these cost nothing to offer. Which ones is decided in src/pure. */
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const snapshot = snapshotOf(document);
    const eol = eolOf(document);

    return planDisableActions(
      context.diagnostics.map((diagnostic) => ({
        source: diagnostic.source,
        code: diagnostic.code,
        line: diagnostic.range.start.line
      }))
    ).map((plan) => {
      const action = new vscode.CodeAction(disableActionTitle(plan.linterName), vscode.CodeActionKind.QuickFix);
      action.diagnostics = [context.diagnostics[plan.index] as vscode.Diagnostic];
      action.edit = new vscode.WorkspaceEdit();
      for (const insertion of buildDisableComment(plan.line, plan.linterName, snapshot, eol)) {
        action.edit.insert(document.uri, new vscode.Position(insertion.line, insertion.character), insertion.text);
      }
      return action;
    });
  }
}
