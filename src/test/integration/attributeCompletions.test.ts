import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { completionsAt, labelsOf } from '../support/editor';
import { activateExtension, fixtureUri } from '../support/host';

const FIXTURE = 'app/views/attributes.slim';

async function labelsAfter(document: vscode.TextDocument, prefix: string): Promise<string[]> {
  return labelsOf(await completionsAt(document, prefix));
}

suite('data attribute completion integration Test Suite', () => {
  let document: vscode.TextDocument;

  suiteSetup(async () => {
    await activateExtension();
    document = await vscode.workspace.openTextDocument(fixtureUri(FIXTURE));
    await vscode.window.showTextDocument(document);
  });

  test('should complete bare attribute names after the tag', async () => {
    const labels = await labelsAfter(document, 'div data-c');
    assert.ok(labels.includes('data-controller'), labels.join(' '));
  });

  test('should complete names inside a paren wrapper', async () => {
    const labels = await labelsAfter(document, 'a(data-tur');
    assert.ok(labels.includes('data-turbo-frame'), labels.join(' '));
  });

  test('should complete names inside a bracket wrapper', async () => {
    const labels = await labelsAfter(document, 'span[data-turbo-a');
    assert.ok(labels.includes('data-turbo-action'), labels.join(' '));
  });

  // Offering an attribute name where a value belongs would be worse than offering nothing. The list is
  // never empty - the built-in snippet provider answers everywhere - so this asserts by label.
  test('should not complete attribute names in a value position', async () => {
    const labels = await labelsAfter(document, 'a(data-turbo-frame="mo');
    assert.ok(!labels.some((label) => label.startsWith('data-')), labels.join(' '));
  });

  // The text fence: a completed bare token with no '=' means inline text has begun.
  test('should not complete attribute names after inline text has begun', async () => {
    const labels = await labelsAfter(document, 'p.plain Text about da');
    assert.ok(!labels.some((label) => label.startsWith('data-')), labels.join(' '));
  });

  // Both completion providers are registered for slim; only one may answer in an attribute list.
  test('should not offer Rails snippets in an attribute list', async () => {
    const labels = await labelsAfter(document, 'a(data-tur');
    assert.ok(!labels.includes('link_to'), labels.join(' '));
  });
});
