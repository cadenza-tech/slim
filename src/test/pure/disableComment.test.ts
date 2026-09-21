import * as assert from 'node:assert';
import { DIAGNOSTIC_SOURCE } from '../../pure/diagnosticMapper';
import {
  buildDisableComment,
  type DiagnosticFacts,
  disableActionTitle,
  findBlockEnd,
  type InsertionSpec,
  linterNameOf,
  planDisableActions
} from '../../pure/disableComment';
import type { Eol } from '../../pure/textModel';
import { offsetOf, snapshotOfLines } from '../support/snapshot';

/** Applies both insertions so the tests assert the resulting Slim, not the coordinates. */
function apply(lines: string[], insertions: readonly InsertionSpec[], eol: Eol = '\n'): string[] {
  let text = lines.join(eol);
  // Apply from the bottom up so earlier offsets stay valid.
  for (const insertion of [...insertions].sort((a, b) => b.line - a.line || b.character - a.character)) {
    const offset = offsetOf(lines, insertion.line, insertion.character, eol);
    text = text.slice(0, offset) + insertion.text + text.slice(offset);
  }
  return text.split(eol);
}

suite('pure/disableComment Test Suite', () => {
  suite('findBlockEnd', () => {
    test('should return the line itself for a leaf', () => {
      assert.strictEqual(findBlockEnd(1, snapshotOfLines(['div', '  p text', '  span'])), 1);
    });

    test('should include nested children', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', '  img', '  span', 'footer'])), 2);
    });

    test('should include children across a blank line', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', '  img', '', '  span', 'footer'])), 3);
    });

    test('should not swallow trailing blank lines', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', '  img', '', ''])), 1);
    });

    test('should stop at a sibling with the same indent', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', 'span'])), 0);
    });

    test('should run to the end of the document', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', '  a', '  b'])), 2);
    });

    test('should handle the last line', () => {
      assert.strictEqual(findBlockEnd(1, snapshotOfLines(['div', '  a'])), 1);
    });

    test('should treat deeper tab indentation as nesting', () => {
      assert.strictEqual(findBlockEnd(0, snapshotOfLines(['div', '\timg', 'footer'])), 1);
    });
  });

  suite('buildDisableComment', () => {
    // The regression this whole module exists for: children must survive the edit.
    test('should place enable after the block so nested lines are not swallowed', () => {
      const lines = ['section', '  div class="x"', '    img src="a.gif"', '    span Hello', '  footer'];
      const result = apply(lines, buildDisableComment(1, 'AltText', snapshotOfLines(lines), '\n'));
      assert.deepStrictEqual(result, [
        'section',
        '  / slim-lint:disable AltText',
        '  div class="x"',
        '    img src="a.gif"',
        '    span Hello',
        '  / slim-lint:enable AltText',
        '  footer'
      ]);
    });

    test('should wrap a leaf line tightly', () => {
      const lines = ['div', '  img', 'footer'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'AltText', snapshotOfLines(lines), '\n')), [
        'div',
        '  / slim-lint:disable AltText',
        '  img',
        '  / slim-lint:enable AltText',
        'footer'
      ]);
    });

    // A blank target - the shape TrailingWhitespace reports - has no indent of its own. Writing the
    // pair at column 0 would let the enable comment swallow `  p b` out of the rendered output,
    // which is the exact failure this module's header describes.
    test('should indent the pair of a blank target so the following line is not swallowed', () => {
      const lines = ['div', '  p a', '  ', '  p b'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
        'div',
        '  p a',
        '  / slim-lint:disable TrailingWhitespace',
        '  ',
        '  / slim-lint:enable TrailingWhitespace',
        '  p b'
      ]);
    });

    test('should fall back to the preceding indent for a trailing blank target', () => {
      const lines = ['div', '  p a', '   '];
      assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
        'div',
        '  p a',
        '  / slim-lint:disable TrailingWhitespace',
        '   ',
        '  / slim-lint:enable TrailingWhitespace'
      ]);
    });

    // A comment written among the lines something else consumes is not a comment: Slim 5.2.2
    // renders the first three of these shapes into the page and refuses to compile the last two.
    // slim-lint reads directives off the raw source lines, so the pair around the owner still
    // silences the line it was asked about.
    suite('around a line that something else consumes', () => {
      test('should go around the text block, not into it', () => {
        const lines = ['p', '  | short text', '    a very long continuation', 'footer'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'LineLength', snapshotOfLines(lines), '\n')), [
          'p',
          '  / slim-lint:disable LineLength',
          '  | short text',
          '    a very long continuation',
          '  / slim-lint:enable LineLength',
          'footer'
        ]);
      });

      test('should go around the tag whose inline text the line continues', () => {
        const lines = ['div', '  p hello', '    world', '  span'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'LineLength', snapshotOfLines(lines), '\n')), [
          'div',
          '  / slim-lint:disable LineLength',
          '  p hello',
          '    world',
          '  / slim-lint:enable LineLength',
          '  span'
        ]);
      });

      test('should go around the filter, not into its body', () => {
        const lines = ['javascript:', '  const a = 1;   ', 'p after'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
          '/ slim-lint:disable TrailingWhitespace',
          'javascript:',
          '  const a = 1;   ',
          '/ slim-lint:enable TrailingWhitespace',
          'p after'
        ]);
      });

      test('should go around the tag whose attribute wrapper is still open', () => {
        const lines = ['a(href="/x"', '  class="a very long class list")', '  span child', 'footer'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'LineLength', snapshotOfLines(lines), '\n')), [
          '/ slim-lint:disable LineLength',
          'a(href="/x"',
          '  class="a very long class list")',
          '  span child',
          '/ slim-lint:enable LineLength',
          'footer'
        ]);
      });

      test('should go around the whole of a Ruby expression broken across lines', () => {
        const lines = ['= link_to "x",', '  a_very_long_path,', '  class: "y"', 'p after'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'LineLength', snapshotOfLines(lines), '\n')), [
          '/ slim-lint:disable LineLength',
          '= link_to "x",',
          '  a_very_long_path,',
          '  class: "y"',
          '/ slim-lint:enable LineLength',
          'p after'
        ]);
      });

      // Indentation alone cannot see that these lines belong to the first one.
      test('should keep a Ruby expression continued at its own indent in one piece', () => {
        const lines = ['= link_to "x",', 'a_very_long_path', 'p after'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(0, 'LineLength', snapshotOfLines(lines), '\n')), [
          '/ slim-lint:disable LineLength',
          '= link_to "x",',
          'a_very_long_path',
          '/ slim-lint:enable LineLength',
          'p after'
        ]);
      });

      // Prose ends in commas all the time. Reading one as a broken line would push the end of the
      // block onto the next - shallower - line, and the enable comment written beneath that line at
      // the deeper indent is its inline text: Slim renders it into the page.
      test('should not read a comma that ends inline text as a broken line', () => {
        const lines = ['div', '  span Hello,', 'p World'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'LineLength', snapshotOfLines(lines), '\n')), [
          'div',
          '  / slim-lint:disable LineLength',
          '  span Hello,',
          '  / slim-lint:enable LineLength',
          'p World'
        ]);
      });

      test('should not read a comma that ends a line of a text block or a filter as a broken line', () => {
        const prose = ['address', '  | 1 Main St', '    Springfield,', 'p Next'];
        assert.deepStrictEqual(apply(prose, buildDisableComment(2, 'LineLength', snapshotOfLines(prose), '\n')), [
          'address',
          '  / slim-lint:disable LineLength',
          '  | 1 Main St',
          '    Springfield,',
          '  / slim-lint:enable LineLength',
          'p Next'
        ]);
        const script = ['div', '  javascript:', '    foo(1,', 'p World'];
        assert.deepStrictEqual(apply(script, buildDisableComment(2, 'LineLength', snapshotOfLines(script), '\n')), [
          'div',
          '  / slim-lint:disable LineLength',
          '  javascript:',
          '    foo(1,',
          '  / slim-lint:enable LineLength',
          'p World'
        ]);
        // The line after the filter is nobody's continuation, however open the script above it looks.
        assert.deepStrictEqual(apply(script, buildDisableComment(3, 'LineLength', snapshotOfLines(script), '\n')), [
          'div',
          '  javascript:',
          '    foo(1,',
          '/ slim-lint:disable LineLength',
          'p World',
          '/ slim-lint:enable LineLength'
        ]);
      });

      // An open wrapper takes the lines that follow whatever their indent, and the usual style
      // closes it on a line of its own at the tag's indent.
      test('should follow an open attribute wrapper down to the line that closes it', () => {
        const lines = ['div', '  a(href="x"', '    class="y"', '  ) Txt', 'p after'];
        const expected = ['div', '  / slim-lint:disable X', '  a(href="x"', '    class="y"', '  ) Txt', '  / slim-lint:enable X', 'p after'];
        for (const target of [1, 2, 3]) {
          assert.deepStrictEqual(apply(lines, buildDisableComment(target, 'X', snapshotOfLines(lines), '\n')), expected, `target ${target}`);
        }
        const flat = ['a(href="x"', 'class="y") Txt', 'p after'];
        assert.deepStrictEqual(apply(flat, buildDisableComment(1, 'X', snapshotOfLines(flat), '\n')), [
          '/ slim-lint:disable X',
          'a(href="x"',
          'class="y") Txt',
          '/ slim-lint:enable X',
          'p after'
        ]);
      });

      test('should keep every line of a Ruby expression continued at its own indent', () => {
        const lines = ['= foo a,', 'b,', 'c', 'p after'];
        const expected = ['/ slim-lint:disable X', '= foo a,', 'b,', 'c', '/ slim-lint:enable X', 'p after'];
        for (const target of [0, 1, 2]) {
          assert.deepStrictEqual(apply(lines, buildDisableComment(target, 'X', snapshotOfLines(lines), '\n')), expected, `target ${target}`);
        }
      });

      // Slim's embedded engine pattern lets attributes sit between the name and its colon.
      test('should recognise a filter that carries attributes', () => {
        const lines = ['javascript type="module":', '  import x from "y";', '  x();', 'p after'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'X', snapshotOfLines(lines), '\n')), [
          '/ slim-lint:disable X',
          'javascript type="module":',
          '  import x from "y";',
          '  x();',
          '/ slim-lint:enable X',
          'p after'
        ]);
      });

      // Children of a block opened by a broken line are lines of their own.
      test('should wrap a child of a broken block opener tightly', () => {
        const lines = ['= form_with model: @post,', '    url: posts_path do |f|', '  = f.text_field :title', 'p after'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'X', snapshotOfLines(lines), '\n')), [
          '= form_with model: @post,',
          '    url: posts_path do |f|',
          '  / slim-lint:disable X',
          '  = f.text_field :title',
          '  / slim-lint:enable X',
          'p after'
        ]);
      });

      test('should go around the text block for a blank line inside it', () => {
        const lines = ['p', '  | first', '   ', '    second', 'footer'];
        assert.deepStrictEqual(apply(lines, buildDisableComment(2, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
          'p',
          '  / slim-lint:disable TrailingWhitespace',
          '  | first',
          '   ',
          '    second',
          '  / slim-lint:enable TrailingWhitespace',
          'footer'
        ]);
      });

      test('should still cover a blank target that trails the block consuming its anchor', () => {
        const lines = ['p', '  | first', '    second', '   '];
        assert.deepStrictEqual(apply(lines, buildDisableComment(3, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
          'p',
          '  / slim-lint:disable TrailingWhitespace',
          '  | first',
          '    second',
          '   ',
          '  / slim-lint:enable TrailingWhitespace'
        ]);
      });
    });

    // Slim expands a tab to the next multiple of four columns, so a file may mix the two. Counted in
    // characters, the tab-indented child measures shallower than its parent and the enable comment
    // lands between them - where, being a comment, it swallows the child out of the page.
    test('should measure nesting in columns when tabs and spaces are mixed', () => {
      const lines = ['div', '    section', '\t\timg src="a"', 'footer'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(1, 'X', snapshotOfLines(lines), '\n')), [
        'div',
        '    / slim-lint:disable X',
        '    section',
        '\t\timg src="a"',
        '    / slim-lint:enable X',
        'footer'
      ]);
    });

    test('should write at column zero in a document of nothing but blank lines', () => {
      const lines = ['  ', ''];
      assert.deepStrictEqual(apply(lines, buildDisableComment(0, 'TrailingWhitespace', snapshotOfLines(lines), '\n')), [
        '/ slim-lint:disable TrailingWhitespace',
        '  ',
        '/ slim-lint:enable TrailingWhitespace',
        ''
      ]);
    });

    test('should keep children separated by a blank line inside the block', () => {
      const lines = ['div', '  a', '', '  b', 'footer'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(0, 'X', snapshotOfLines(lines), '\n')), [
        '/ slim-lint:disable X',
        'div',
        '  a',
        '',
        '  b',
        '/ slim-lint:enable X',
        'footer'
      ]);
    });

    test('should append after the final line', () => {
      const lines = ['div', '  img'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(0, 'X', snapshotOfLines(lines), '\n')), [
        '/ slim-lint:disable X',
        'div',
        '  img',
        '/ slim-lint:enable X'
      ]);
    });

    test('should handle the first line of the document', () => {
      const lines = ['div', 'span'];
      assert.deepStrictEqual(apply(lines, buildDisableComment(0, 'X', snapshotOfLines(lines), '\n')), [
        '/ slim-lint:disable X',
        'div',
        '/ slim-lint:enable X',
        'span'
      ]);
    });

    test('should match the indentation of the target line', () => {
      const lines = ['a', '    deep', 'b'];
      const [disable, enable] = buildDisableComment(1, 'X', snapshotOfLines(lines), '\n');
      assert.ok(disable.text.startsWith('    /'));
      assert.ok(enable.text.startsWith('    /'));
    });

    test('should reuse tab indentation verbatim', () => {
      const lines = ['a', '\tdeep', 'b'];
      const [disable] = buildDisableComment(1, 'X', snapshotOfLines(lines), '\n');
      assert.ok(disable.text.startsWith('\t/'));
    });

    test('should use the document line ending', () => {
      const lines = ['div', 'span'];
      const [disable] = buildDisableComment(0, 'X', snapshotOfLines(lines), '\r\n');
      assert.ok(disable.text.endsWith('\r\n'));
    });

    test('should put the separator first when appending past the last line', () => {
      const lines = ['div'];
      const [, enable] = buildDisableComment(0, 'X', snapshotOfLines(lines), '\n');
      assert.ok(enable.text.startsWith('\n'));
      assert.strictEqual(enable.line, 0);
      assert.strictEqual(enable.character, 3);
    });
  });

  suite('disableActionTitle', () => {
    // slim-lint has no per-cop inline disable, so this must not claim to silence one cop.
    test('should say all cops for RuboCop', () => {
      assert.strictEqual(disableActionTitle('RuboCop'), 'Disable RuboCop (all cops) for this block');
    });

    test('should name the linter otherwise', () => {
      assert.strictEqual(disableActionTitle('LineLength'), 'Disable LineLength for this block');
    });
  });

  suite('linterNameOf', () => {
    test('should take a plain string code as the linter name', () => {
      assert.strictEqual(linterNameOf('LineLength'), 'LineLength');
    });

    // The shape diagnostics.ts actually produces: a code with a documentation target.
    test('should read the value out of a code object', () => {
      assert.strictEqual(linterNameOf({ value: 'AltText', target: 'https://example.test' }), 'AltText');
    });

    // Syntax and parse errors carry no linter, so nothing can be disabled for them.
    test('should return undefined when there is no linter to name', () => {
      for (const code of [undefined, null, 42, {}, []]) {
        assert.strictEqual(linterNameOf(code), undefined, JSON.stringify(code) ?? 'undefined');
      }
    });

    // The name is process output, and this is the one place any of it is written into a document.
    // slim-lint names its linters after Ruby classes; a report naming one any other way gets no
    // quick fix rather than a line of its own choosing in the buffer.
    test('should refuse a name that is not a Ruby class name', () => {
      for (const code of ['X\n= system("id")', 'Line Length', 'RuboCop/Style', '', { value: 'A\r\nB' }]) {
        assert.strictEqual(linterNameOf(code), undefined, JSON.stringify(code));
      }
    });
  });

  suite('planDisableActions', () => {
    const facts = (overrides: Partial<DiagnosticFacts> = {}): DiagnosticFacts => ({
      source: DIAGNOSTIC_SOURCE,
      code: 'LineLength',
      line: 3,
      ...overrides
    });

    test('should plan one action per diagnostic, keeping the input index', () => {
      const plans = planDisableActions([facts(), facts({ line: 9, code: 'AltText' })]);
      assert.deepStrictEqual(plans, [
        { index: 0, line: 3, linterName: 'LineLength' },
        { index: 1, line: 9, linterName: 'AltText' }
      ]);
    });

    // slim-lint reports no column, so two offenses of one linter on one line are indistinguishable
    // and would offer the same comment twice.
    test('should offer one action per line and linter', () => {
      const plans = planDisableActions([facts(), facts()]);
      assert.strictEqual(plans.length, 1);
    });

    test('should keep the same linter on a different line', () => {
      const plans = planDisableActions([facts(), facts({ line: 4 })]);
      assert.strictEqual(plans.length, 2);
    });

    test('should keep a different linter on the same line', () => {
      const plans = planDisableActions([facts(), facts({ code: 'AltText' })]);
      assert.strictEqual(plans.length, 2);
    });

    // Writing a slim-lint directive for another extension's finding would silence nothing.
    test('should ignore diagnostics from anything but slim-lint', () => {
      assert.deepStrictEqual(planDisableActions([facts({ source: 'eslint' }), facts({ source: undefined })]), []);
    });

    test('should ignore diagnostics with no linter to disable', () => {
      assert.deepStrictEqual(planDisableActions([facts({ code: undefined })]), []);
    });
  });
});
