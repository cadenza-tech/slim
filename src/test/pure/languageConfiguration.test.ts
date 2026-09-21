import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// VS Code evaluates onEnterRules synchronously in the renderer on every Enter, against the text left
// of the cursor. Nothing else exercises these regexes - the extension host tests never press Enter -
// so a rule that misfires, or one that backtracks, is only ever found by a user.
const ROOT = path.join(__dirname, '..', '..', '..');

interface OnEnterRule {
  readonly beforeText: string;
}

const rules = (
  JSON.parse(fs.readFileSync(path.join(ROOT, 'language-configuration.json'), 'utf8')) as { onEnterRules: OnEnterRule[] }
).onEnterRules.map((rule) => new RegExp(rule.beforeText));

function indentsAfter(line: string): boolean {
  return rules.some((rule) => rule.test(line));
}

suite('language configuration Test Suite', () => {
  test('should indent after a line that opens a block', () => {
    for (const line of [
      'div',
      '.card',
      'ul.nav#main',
      '  section.hero',
      'a(href="/")',
      'a[href="/"]',
      'p class="lead"',
      '- if user',
      '- else',
      '= form_with model: @post do |f|',
      '=> link_to root_path do',
      'javascript:',
      '|',
      "'"
    ]) {
      assert.strictEqual(indentsAfter(line), true, line);
    }
  });

  test('should not indent after a line that carries its own content', () => {
    for (const line of ['p Hello', '| text', '/ comment', 'doctype html', '= link_to "x", root_path', 'a href="/" Home']) {
      assert.strictEqual(indentsAfter(line), false, line);
    }
  });

  // `(\(.*\)|\[.*\]|\{.*\})*` - a `.*` inside a starred group - tried every way of splitting a run
  // of adjacent groups before giving up: 28 of them took nine seconds, doubling with every two more,
  // with the whole window frozen for the duration.
  test('should give up quickly on a line that cannot match', () => {
    const started = Date.now();
    for (const line of [`a${'()'.repeat(200)}!`, `f${'(x){y}'.repeat(200)};`, `a ${'b="c" '.repeat(2000)}!`, `- if ${'x '.repeat(20000)}`]) {
      indentsAfter(line);
    }
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  });
});
