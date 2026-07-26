import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { SlimCodeActionProvider } from '../../codeActions';
import { DIAGNOSTIC_SOURCE } from '../../pure/diagnosticMapper';
import { disableActionTitle } from '../../pure/disableComment';
import { activateExtension, openView, viewUri } from '../support/host';

function context(overrides: Partial<vscode.CodeActionContext> = {}): vscode.CodeActionContext {
  return { diagnostics: [], triggerKind: vscode.CodeActionTriggerKind.Automatic, only: undefined, ...overrides };
}

function slimLintDiagnostic(line: number, code: string | { value: string; target: vscode.Uri } | undefined): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 5), 'Line is too long', vscode.DiagnosticSeverity.Warning);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  if (code !== undefined) {
    diagnostic.code = code;
  }
  return diagnostic;
}

suite('code action provider Test Suite', () => {
  let document: vscode.TextDocument;

  suiteSetup(async () => {
    await activateExtension();
    document = await openView('clean.slim');
  });

  const range = new vscode.Range(0, 0, 0, 0);

  suite('disable quick fixes', () => {
    test('should attach the diagnostic the action answers', () => {
      // Line 0: clean.slim is a single line, and buildDisableComment reads the line it is given.
      const diagnostic = slimLintDiagnostic(0, 'AltText');
      const actions = new SlimCodeActionProvider().provideCodeActions(document, range, context({ diagnostics: [diagnostic] }));

      const quickFix = actions.find((action) => action.kind?.value === vscode.CodeActionKind.QuickFix.value);
      assert.ok(quickFix !== undefined);
      assert.deepStrictEqual(quickFix.diagnostics, [diagnostic]);
      assert.ok(quickFix.edit !== undefined, 'the comment pair is a plain edit, so it is offered directly');
    });

    // Offering to write a slim-lint directive for someone else's finding would do nothing.
    test('should offer nothing for diagnostics from other sources', () => {
      const foreign = slimLintDiagnostic(0, 'LineLength');
      foreign.source = 'rubocop';
      const actions = new SlimCodeActionProvider().provideCodeActions(document, range, context({ diagnostics: [foreign] }));

      assert.deepStrictEqual(actions, []);
    });
  });

  // The one thing constructing the provider directly cannot show: that it is wired to .slim files.
  // The provider only answers per diagnostic, so the registration question needs one at the range;
  // a collection created here stands in for a slim-lint run without needing Ruby.
  test('should be registered for slim documents', async () => {
    const collection = vscode.languages.createDiagnosticCollection('code-action-registration-test');
    const uri = viewUri('clean.slim');
    collection.set(uri, [slimLintDiagnostic(0, 'AltText')]);
    try {
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        new vscode.Range(0, 0, 0, 5)
      );
      assert.ok(actions !== undefined, 'executeCodeActionProvider found no provider at all');
      assert.ok(
        actions.some((action) => action.title === disableActionTitle('AltText')),
        'the provider must be registered against SLIM_SELECTOR'
      );
    } finally {
      collection.dispose();
    }
  });
});
