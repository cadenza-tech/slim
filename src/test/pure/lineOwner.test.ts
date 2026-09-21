import * as assert from 'node:assert';
import { consumesDeeperLines, owningLine, statementEnd } from '../../pure/lineOwner';
import { snapshotOfLines } from '../support/snapshot';

suite('pure/lineOwner Test Suite', () => {
  // Each verdict was measured, not reasoned: the line was rendered through Slim 5.2.2 with a
  // `/ MARK` comment indented beneath it, and "consumes" is MARK reaching the page or the template
  // no longer compiling. `/ note` is the one exception: its body is dropped rather than rendered,
  // and it counts because that body must not be read as Slim.
  suite('consumesDeeperLines', () => {
    const CONSUMES = [
      'p hello',
      'p> hello',
      'p Text #{foo}',
      '.foo#bar text',
      'li: a href="/" Home',
      'a(href="/x") text',
      'a href=url_for(1) text',
      'a *{class: "k"} text',
      'input type="text" disabled',
      'svg:path d="M0" t',
      '| text',
      "' text",
      '/! note',
      '/ note',
      'javascript:',
      'css:',
      'ruby:',
      '  markdown:',
      'javascript type="module":',
      'css(media="print"):'
    ];
    const PARSES_CHILDREN = [
      'p',
      'p>',
      'p<>',
      '.foo#bar',
      'p class="x"',
      'p = foo',
      'p == foo',
      'a href="/" = foo',
      'li: a href="/"',
      'a(href="/x")',
      'a [href="/x"]',
      'a href=url_for(1)',
      'a href=url_for(1, 2)',
      'a data-x="1" class=["a", "b"]',
      'a *{class: "k"}',
      'a@click="x"',
      'svg:path d="M0"',
      '= foo',
      '- if x',
      '<div>',
      ''
    ];

    for (const line of CONSUMES) {
      test(`should say ${JSON.stringify(line)} consumes the lines beneath it`, () => {
        assert.strictEqual(consumesDeeperLines(line), true);
      });
    }

    for (const line of PARSES_CHILDREN) {
      test(`should say ${JSON.stringify(line)} parses the lines beneath it`, () => {
        assert.strictEqual(consumesDeeperLines(line), false);
      });
    }

    // The attribute list carries on below, so what follows is not a child either.
    test('should treat a wrapper left open as consuming', () => {
      assert.strictEqual(consumesDeeperLines('a(href="/x"'), true);
      assert.strictEqual(consumesDeeperLines('a href="/x'), true);
      assert.strictEqual(consumesDeeperLines('a href=url_for(1,'), true);
    });

    test('should read a Ruby attribute value through its literals and brackets', () => {
      assert.strictEqual(consumesDeeperLines('a class=base+"-x" title=t("a b")'), false);
      assert.strictEqual(consumesDeeperLines('a class=base+"-x" text'), true);
      assert.strictEqual(consumesDeeperLines('a title=t("a b'), true);
      assert.strictEqual(consumesDeeperLines('a class=base+"-x'), true);
    });

    // A line of somebody else's text block, which is what most ancestors of prose are.
    test('should not take a line that opens with no tag for one', () => {
      assert.strictEqual(consumesDeeperLines('日本語のテキスト'), false);
      assert.strictEqual(consumesDeeperLines('& more'), false);
    });

    test('should treat output broken across lines as consuming', () => {
      assert.strictEqual(consumesDeeperLines('p = link_to "x",'), true);
    });

    test('should stay linear on a line holding an inline data URI', () => {
      const line = `img src="data:image/png;base64,${'A'.repeat(1024 * 1024)}" alt="x"`;
      const started = Date.now();
      assert.strictEqual(consumesDeeperLines(line), false);
      assert.ok(Date.now() - started < 1000);
    });
  });

  suite('owningLine', () => {
    test('should own itself under a parent that parses its children', () => {
      assert.strictEqual(owningLine(2, snapshotOfLines(['div', '  - if x', '    p text'])), 2);
    });

    test('should climb to the text block a line belongs to', () => {
      assert.strictEqual(owningLine(2, snapshotOfLines(['p', '  | short', '    a long continuation'])), 1);
    });

    test('should climb to the outermost consumer, not the nearest', () => {
      assert.strictEqual(owningLine(3, snapshotOfLines(['div', '  /! kept', '    | inner', '      deepest'])), 1);
    });

    test('should climb to the tag whose inline text a line continues', () => {
      assert.strictEqual(owningLine(1, snapshotOfLines(['p hello', '  world'])), 0);
    });

    test('should climb to the filter a line is the body of', () => {
      assert.strictEqual(owningLine(2, snapshotOfLines(['javascript:', '  if (a) {', '    b();'])), 0);
    });

    test('should climb to the tag whose wrapper is still open', () => {
      assert.strictEqual(owningLine(1, snapshotOfLines(['a(href="/x"', '  class="y")'])), 0);
    });

    test('should walk back over a broken line, whatever its indent', () => {
      assert.strictEqual(owningLine(2, snapshotOfLines(['= link_to "x",', '  path,', '  class: "y"'])), 0);
      assert.strictEqual(owningLine(1, snapshotOfLines(['= [1,', '2].inspect'])), 0);
    });

    // Tab-indented children of a space-indented parent: two characters, but eight columns.
    test('should measure indentation in columns, as Slim does', () => {
      assert.strictEqual(owningLine(2, snapshotOfLines(['div', '    | text', '\t\tmore text'])), 1);
    });

    // The closing bracket usually sits at the tag's own indent, where indentation says "sibling".
    test('should find the tag whose open wrapper reaches the line, whatever the indent', () => {
      const document = snapshotOfLines(['div', '  a(href="x"', '    class="y"', '  ) Txt', 'p after']);
      assert.strictEqual(owningLine(2, document), 1);
      assert.strictEqual(owningLine(3, document), 1);
      assert.strictEqual(owningLine(4, document), 4);
    });

    // A filter body is full of brackets left open, and none of them is Slim's.
    test('should not believe an open bracket inside a filter body', () => {
      const document = snapshotOfLines(['div', '  javascript:', '    foo(1,', 'p World']);
      assert.strictEqual(owningLine(2, document), 1);
      assert.strictEqual(owningLine(3, document), 3);
    });

    test('should leave the children of a block opened by a broken line to themselves', () => {
      const document = snapshotOfLines(['= form_with model: @post,', '    url: posts_path do |f|', '  = f.text_field :title']);
      assert.strictEqual(owningLine(1, document), 0);
      assert.strictEqual(owningLine(2, document), 2);
    });

    test('should skip blank lines on the way up', () => {
      assert.strictEqual(owningLine(3, snapshotOfLines(['p', '  | short', '', '    continuation'])), 1);
    });
  });

  suite('statementEnd', () => {
    test('should follow a broken line of Ruby down to where it ends, whatever the indent', () => {
      const document = snapshotOfLines(['= link_to "x",', 'path, \t', 'class: "y"', 'p next']);
      assert.strictEqual(statementEnd(0, document), 2);
      assert.strictEqual(statementEnd(3, document), 3);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['- total = 1 + \\', '  2', 'p next'])), 1);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['p = link_to "x",', '  path', 'p next'])), 1);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['a href=url_for(1,', '  2) Home', 'p next'])), 1);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['a href=root_path,', '  anchor: "top"', 'p next'])), 1);
    });

    // Slim::Parser#parse_broken_line is only reached from code and output lines: prose ends in
    // commas all the time, and neither inline text nor a verbatim line is ever continued by one.
    test('should not follow a comma or a backslash that ends text', () => {
      for (const line of ['span Hello,', '| Hello,', "' Hello,", '/ note,', 'p C:\\dir\\', 'Springfield,']) {
        assert.strictEqual(statementEnd(0, snapshotOfLines([line, 'p next'])), 0, line);
      }
    });

    test('should follow an open wrapper or literal down to the line that closes it', () => {
      assert.strictEqual(statementEnd(0, snapshotOfLines(['a(href="x"', '  class="y"', ') Txt', 'p next'])), 2);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['a title="two', '  lines" href="/"', 'p next'])), 1);
    });

    test('should stop at the end of the document', () => {
      assert.strictEqual(statementEnd(0, snapshotOfLines(['= foo,'])), 0);
      assert.strictEqual(statementEnd(0, snapshotOfLines(['a(href="x"', '  class="y"'])), 1);
    });

    // A file where every line opens a bracket must not turn one question into a scan of the rest.
    test('should give up on a statement nobody would write', () => {
      const lines = Array.from({ length: 500 }, () => 'a(');
      assert.strictEqual(statementEnd(0, snapshotOfLines(lines)), 50);
    });
  });
});
