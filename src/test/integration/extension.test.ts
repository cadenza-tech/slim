import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../../config';
import { CONFIG_KEYS, normalizeConfig } from '../../configSchema';
import type { SlimConfig } from '../../types';
import { activateExtension, EXTENSION_ID, FIXTURE_VIEWS, fixtureUri, openView } from '../support/host';

suite('extension integration Test Suite', () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  // Without this the whole point of the fixture is lost: cwd resolution, bundler detection and
  // .slim-lint.yml discovery all key off the workspace folder.
  test('should open with a workspace folder', () => {
    assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
  });

  test('should register the extension', () => {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} is not installed in the test host`);
  });

  test('should recognise .slim as the slim language', async () => {
    const document = await openView('clean.slim');
    assert.strictEqual(document.languageId, 'slim');
  });

  test('should register every contributed command', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'slim.lintFile',
      'slim.restartLinter',
      'slim.showOutput',
      'slim.wrapInConditional',
      'slim.wrapInBlock',
      'slim.splitToPartial'
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  // src/test/pure/manifest checks package.json's declared defaults against normalizeConfig. What it
  // cannot check is that VS Code *resolves* those ids - a wrong key in CONFIG_KEYS returns undefined
  // and normalizeConfig quietly substitutes the default, so only asking the real API catches it.
  test('should resolve every setting the extension reads to its normalized default', () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, fixtureUri(FIXTURE_VIEWS, 'clean.slim'));
    const defaults = normalizeConfig({});
    for (const [field, key] of Object.entries(CONFIG_KEYS)) {
      assert.deepStrictEqual(config.get(key), defaults[field as keyof SlimConfig], `slim.${key}`);
    }
  });

  // Shipped through contributes.configurationDefaults, because Slim's own manual says two spaces.
  test('should default [slim] to two-space indentation', () => {
    const editor = vscode.workspace.getConfiguration('editor', { languageId: 'slim', uri: fixtureUri(FIXTURE_VIEWS, 'clean.slim') });
    assert.strictEqual(editor.get('tabSize'), 2);
    assert.strictEqual(editor.get('insertSpaces'), true);
  });

  test('should run the lint command without throwing when slim-lint is unavailable', async () => {
    const document = await openView('offenses.slim');
    await vscode.commands.executeCommand('slim.lintFile', document.uri);
  });

  // The commands are registered by the real extension, so registerCommands cannot be called again -
  // a duplicate id throws. Driving them the way a user does is the only entry point left.
  //
  // Be honest about the ceiling: commands.ts is outside the c8 scope so this shows in no number, and
  // showInformationMessage is not queryable at the 1.57 API floor, so "did not throw" is the whole
  // observable contract. Anything beyond these three would be theatre.
  suite('commands with no document to act on', () => {
    setup(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    for (const command of ['slim.lintFile', 'slim.restartLinter', 'slim.showOutput']) {
      test(`should not throw for ${command} with no active editor`, async () => {
        await vscode.commands.executeCommand(command);
      });
    }
  });
});
