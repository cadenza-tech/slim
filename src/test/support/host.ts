// Extension host helpers. Imports vscode for real, so only src/test/integration may use it.

import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'cadenza-tech.vscode-slim';
export const FIXTURE_VIEWS = 'app/views';

/** Absolute path inside src/test/fixtures/rails-like, which .vscode-test.mjs opens as the folder. */
export function fixturePath(...segments: string[]): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder !== undefined, 'the test workspace folder is missing; check workspaceFolder in .vscode-test.mjs');
  return path.join(folder.uri.fsPath, ...segments);
}

export function fixtureUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.file(fixturePath(...segments));
}

export function viewUri(name: string): vscode.Uri {
  return fixtureUri(FIXTURE_VIEWS, name);
}

/** Opens a view without showing it. Most tests only need the document. */
export function openView(name: string): Thenable<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(viewUri(name));
}

/** Opens a view *and* makes it active, for the tests that read window.activeTextEditor. */
export async function showView(name: string): Promise<vscode.TextEditor> {
  return vscode.window.showTextDocument(await openView(name), { preview: false });
}

/** Asserts the extension exists rather than silently doing nothing, which `?.activate()` did. */
export async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension !== undefined, `${EXTENSION_ID} is not installed in the test host`);
  await extension.activate();
}

let probe: boolean | undefined;

/** One `slim-lint --version` per host rather than one per suite. */
export function slimLintAvailable(): boolean {
  if (probe === undefined) {
    try {
      execFileSync('slim-lint', ['--version'], { encoding: 'utf8' });
      probe = true;
    } catch {
      probe = false;
    }
  }
  return probe;
}

/** Call from suiteSetup with `this`: skips the suite when the gem is absent. */
export function skipWithoutSlimLint(context: Mocha.Context): void {
  if (!slimLintAvailable()) {
    context.skip();
  }
}
