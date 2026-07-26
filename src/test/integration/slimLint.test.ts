import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { activateExtension, FIXTURE_VIEWS, fixturePath, openView, skipWithoutSlimLint } from '../support/host';
import { waitFor } from '../support/timing';

// These only run where the gem is installed. CI installs it across a version matrix; locally they
// skip rather than fail so `yarn test` stays useful without Ruby.
suite('slim-lint round trip Test Suite', () => {
  suiteSetup(async function () {
    skipWithoutSlimLint(this);
    await activateExtension();
  });

  test('should report diagnostics for a file with offenses', async () => {
    const document = await openView('offenses.slim');
    await vscode.commands.executeCommand('slim.lintFile', document.uri);

    // The lint runs asynchronously behind the command; poll rather than sleep a fixed amount.
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).some((d) => d.source === 'slim-lint'), 'a slim-lint diagnostic', 15000);

    const diagnostics = vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === 'slim-lint');
    // The fixture .slim-lint.yml sets LineLength.max to 40, so finding it proves cwd resolution
    // reached the config: slim-lint only searches upward from the process cwd.
    assert.ok(
      diagnostics.some((d) => (typeof d.code === 'object' && d.code !== null ? String(d.code.value) : String(d.code)) === 'LineLength'),
      'expected LineLength, which only fires when the fixture .slim-lint.yml was discovered'
    );
  });

  // A broken document is a lint result, not a crash: slim-lint reports the parse error as a
  // severity "error" offense with `linter: null` and exits 65.
  test('should report a parse error as an error diagnostic', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'slim', content: 'p(((\n  div oops\n' });
    await vscode.commands.executeCommand('slim.lintFile', document.uri);
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).some((d) => d.source === 'slim-lint'), 'a slim-lint diagnostic', 15000);
    assert.ok(
      vscode.languages.getDiagnostics(document.uri).some((d) => d.source === 'slim-lint' && d.severity === vscode.DiagnosticSeverity.Error),
      'a parse error must surface as an error diagnostic'
    );
  });

  // The regression net for the --stdin-file-path invariant: linting reads the buffer through
  // stdin, so the file on disk must come through a full round trip untouched.
  test('should never write to the file on disk while linting', async () => {
    const target = fixturePath(FIXTURE_VIEWS, 'offenses.slim');
    const before = fs.readFileSync(target);
    const document = await openView('offenses.slim');
    await vscode.commands.executeCommand('slim.lintFile', document.uri);
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).some((d) => d.source === 'slim-lint'), 'a slim-lint diagnostic', 15000);
    assert.deepStrictEqual(fs.readFileSync(target), before, 'linting must read the buffer through stdin, never the file');
  });
});
