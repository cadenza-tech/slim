import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { RailsDetectionCache, SnippetCompletionProvider } from '../../completions';
import { nodeResolveDeps } from '../../nodeDeps';
import { config } from '../support/doubles';
import { completionsAt, labelOf, labelsOf, positionAfter } from '../support/editor';
import { activateExtension, openView } from '../support/host';

/** The snippets this extension supplies under `label`, told apart from anyone else's by the marker they open with. */
function suppliedAs(items: readonly vscode.CompletionItem[], label: string): vscode.CompletionItem[] {
  return items.filter((item) => labelOf(item) === label && item.insertText instanceof vscode.SnippetString && /^[-=] /.test(item.insertText.value));
}

suite('completions integration Test Suite', () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  // The settings are left at their defaults on purpose. Writing slim.snippets.rails would either
  // create .vscode/settings.json inside the fixture (which .gitignore does not cover) or land in
  // the developer's real user settings, since .vscode-test.mjs only isolates the user data
  // directory when VSCODE_TEST_ID is set. The three modes are pinned by the unit tests for
  // shouldOfferRailsSnippets instead.
  // completion.slim is the single line `= link`, so the prefix puts the cursor at its end.
  test('should offer Rails helpers in a Rails workspace at a script position', async () => {
    const document = await openView('completion.slim');

    const labels = labelsOf(await completionsAt(document, '= link'));
    assert.ok(labels.includes('link_to'), `link_to is missing from ${labels.length} items`);
    assert.ok(labels.includes('link_to_block'), 'link_to_block is missing');
  });

  test('should replace the script marker so the body does not double it', async () => {
    const document = await openView('completion.slim');

    const item = (await completionsAt(document, '= link')).find((candidate) => candidate.label === 'link_to');
    assert.ok(item !== undefined, 'link_to is missing');
    assert.ok(item.range instanceof vscode.Range, 'the range must be set explicitly, not left to the default word');
    assert.strictEqual(item.range.start.character, 0, 'the range must start at the "=" so it is replaced, not repeated');
  });

  // control.slim opens with the line `- if`. A contributed snippet replaces only the word matching its
  // prefix, so this was `- - if condition` - and once the line was highlighted the position counted as
  // Ruby, where the Slim snippets were not offered at all.
  test('should offer a control snippet after the marker and have it replace the marker', async () => {
    const document = await openView('control.slim');

    const items = suppliedAs(await completionsAt(document, '- if'), 'if');
    assert.strictEqual(items.length, 1, 'exactly one `if`: the contributed copy has to be gone');
    const [item] = items as [vscode.CompletionItem];
    assert.ok(item.range instanceof vscode.Range, 'the range must be set explicitly, not left to the default word');
    assert.strictEqual(item.range.start.character, 0, 'the range must start at the "-" so it is replaced, not repeated');
    // The filter word runs from the start of the range, so without this the item never shows.
    assert.strictEqual(item.filterText, '- if');
  });

  // Line 3 of control.slim is `  if` inside a javascript: filter, where `- if` is not Slim.
  test('should keep the control snippets out of a filter body', async () => {
    const document = await openView('control.slim');

    assert.deepStrictEqual(suppliedAs(await completionsAt(document, '  if'), 'if'), []);
  });

  // The provider is built here rather than reached through the host, for the reason given above:
  // the setting cannot be written from a test.
  suite('with slim.snippets.rails off', () => {
    function provider(): SnippetCompletionProvider {
      return new SnippetCompletionProvider(new RailsDetectionCache(nodeResolveDeps()), () => config({ snippetsRails: 'off' }));
    }

    // They are Slim, not Rails: nothing about the workspace decides whether `- if` is wanted.
    test('should still offer the control snippets', async () => {
      const document = await openView('control.slim');

      const labels = labelsOf(provider().provideCompletionItems(document, positionAfter(document, '- if')) ?? []);
      assert.deepStrictEqual(labels.sort(), ['if', 'ifelse']);
    });

    // Any item returned here stops VS Code from asking the providers ranked below this one, which
    // is where the word-based suggestions come from.
    test('should answer with nothing at all when no control snippet matches', async () => {
      const document = await openView('completion.slim');

      assert.strictEqual(provider().provideCompletionItems(document, positionAfter(document, '= link')), undefined);
    });
  });

  // clean.slim is `p Clean`: plain text, where a line beginning with "= " could never be right.
  test('should offer nothing in plain text', async () => {
    const document = await openView('clean.slim');

    const labels = labelsOf(await completionsAt(document, 'p Clean'));
    assert.ok(!labels.includes('link_to'), 'Rails helpers must not appear in plain text');
  });
});
