import * as assert from 'node:assert';
import { type CompletionWord, computeCompletionWord, computeReplaceLength, isScriptPosition } from '../../pure/completionWord';
import { FAST_ENOUGH_MS, fastestOf } from '../support/timing';

const OUTPUT_BODY = "= link_to('${1:name}')";
const SILENT_BODY = '- cache ${1:name} do\n  $2';
const BLOCK_BODY = '= form_with model: ${1:record} do |${2:form}|\n  $3';
/** One of the eight upstream helpers meant to sit inside an existing expression. */
const BARE_BODY = "image_alt('$1')";

function word(linePrefix: string): CompletionWord | null {
  return computeCompletionWord(linePrefix);
}

function accepted(linePrefix: string): CompletionWord {
  const result = word(linePrefix);
  assert.ok(result !== null, `${JSON.stringify(linePrefix)} was rejected`);
  return result;
}

/** What the line becomes once the item is accepted, so expectations read as Slim. */
function applied(linePrefix: string, body: string): string | null {
  const found = word(linePrefix);
  if (found === null) {
    return null;
  }
  const length = computeReplaceLength(found, body);
  return length === null ? null : linePrefix.slice(0, linePrefix.length - length) + body;
}

suite('pure/completionWord Test Suite', () => {
  suite('positions that accept a helper', () => {
    test('should take the identifier at the start of a line', () => {
      assert.strictEqual(accepted('link').identifierLength, 4);
      assert.strictEqual(accepted('  link').identifierLength, 4);
    });

    // Without the dot the replace range would cover only `te`, and accepting f.text_field would
    // leave f.f.text_field behind.
    test('should include a dot so the f.* prefixes replace themselves', () => {
      assert.strictEqual(accepted('f.te').identifierLength, 4);
      assert.strictEqual(accepted('f.').identifierLength, 2);
      assert.strictEqual(accepted('tag.di').identifierLength, 6);
    });

    test('should include a trailing question mark', () => {
      assert.strictEqual(accepted('content_for?').identifierLength, 12);
      assert.strictEqual(accepted('current_page?').identifierLength, 13);
    });

    test('should take an output marker at the start of a line', () => {
      for (const line of ['= link', '  = link', '=link']) {
        assert.ok(accepted(line).markerAtLineStart, line);
      }
    });

    test('should take a control code marker', () => {
      const found = accepted('  - cache');
      assert.strictEqual(found.marker, '- ');
      assert.ok(found.markerAtLineStart);
    });

    // The most common way to output a helper in Slim.
    test('should take the marker when a tag precedes it', () => {
      for (const line of ['p= link', 'td= link_to', 'p(x="1")= link', 'p.a.b= link', '#id= link', 'a href="a=b" = link', 'fb:like= link']) {
        const found = accepted(line);
        assert.strictEqual(found.marker, '= ', line);
        assert.strictEqual(found.markerAtLineStart, false, line);
      }
    });

    // Slim's inline tag shortcut - `li: a` - starts a fresh tag after the colon; the space is what
    // tells it apart from an XML namespace tag like fb:like, the same way attributePosition does.
    test('should take the marker on an inline tag chain', () => {
      for (const line of ['li: span= t', 'ul: li: a= link', 'li: a href="/" = link', 'li: .card= link']) {
        const found = accepted(line);
        assert.strictEqual(found.marker, '= ', line);
        assert.strictEqual(found.markerAtLineStart, false, line);
      }
    });

    // A bare word before the marker is a tag in Slim, so `x = lin` is a tag with an output marker
    // and the helper belongs there.
    test('should take a bare word before the marker as a tag', () => {
      const found = accepted('x = lin');
      assert.strictEqual(found.marker, '= ');
      assert.strictEqual(found.markerAtLineStart, false);
      assert.strictEqual(applied('span = lin', OUTPUT_BODY), `span ${OUTPUT_BODY}`);
    });

    // A quoted value is opaque to the header walk: a bracket or space inside it is string content,
    // not structure, and must not disqualify the line.
    test('should take the marker when a quoted attribute value holds a bracket or space', () => {
      for (const line of ['a(title=":)")= link', 'p title="a}b" = link', 'p title="a c" = link']) {
        assert.strictEqual(accepted(line).marker, '= ', line);
      }
    });

    // The converse: while the literal is unterminated, an `=` after it is still string content.
    test('should reject a marker inside an unterminated string', () => {
      assert.strictEqual(word('p title="abc = lin'), null);
    });

    // Only the last '=' is taken, so the first half of `==` stays outside the range and keeps the
    // unescaped meaning the user typed.
    test('should keep the first half of an unescaped marker intact', () => {
      assert.strictEqual(applied('== link', OUTPUT_BODY), `=${OUTPUT_BODY}`);
      assert.strictEqual(applied('p== link', OUTPUT_BODY), `p=${OUTPUT_BODY}`);
    });

    // Replacing `=' ` with a body's plain `= ` would silently drop the modifier the user typed.
    test('should leave whitespace-modified markers alone', () => {
      for (const line of ["=' link", '=< link', '=> link', "==' link"]) {
        assert.strictEqual(word(line), null, line);
      }
    });
  });

  suite('positions that reject a helper', () => {
    // The identifier scan has no left anchor, so `.f` finds `f`; the head test is what rejects it.
    // Without that, all 37 dotted prefixes would surface every time a class name is typed.
    test('should reject class and id shorthand', () => {
      for (const line of ['.f', '.foo', '#id_f', '@user.f']) {
        assert.strictEqual(word(line), null, line);
      }
    });

    // Everything here ends in '=' and would pass a test that only looked at the last character.
    test('should reject text and code that merely ends in an equals sign', () => {
      for (const line of ['p Price = tot', 'a href=lin', '  var u = lin', '/ TODO: x = link', '\\= lin', 'p "quoted words" = lin']) {
        assert.strictEqual(word(line), null, line);
      }
    });

    test('should reject plain text and unbalanced attribute wrappers', () => {
      for (const line of ['p Hello link', 'a(href=link', '  Some prose about link', 'p)= link']) {
        assert.strictEqual(word(line), null, line);
      }
    });

    // The chain restarts a header, not a free pass: what follows the colon is judged like any line.
    test('should still reject prose and attribute positions on an inline tag chain', () => {
      for (const line of ['li: span Price = tot', 'li: a href= lin', 'li: "quoted" = lin', 'li:= lin']) {
        assert.strictEqual(word(line), null, line);
      }
    });

    test('should reject positions with no identifier', () => {
      for (const line of ['', '   ', '= ', '- ', 'p ']) {
        assert.strictEqual(word(line), null, JSON.stringify(line));
      }
    });

    // These belong to the partial and data attribute completions, and stay theirs only because the
    // head test rejects them here. Loosening classifyHead would have two providers answer at once.
    test('should reject the positions the partial and attribute completions own', () => {
      for (const line of ["= render 'sha", '= render "sha', 'div(data-tur', 'a href="/" data-tur']) {
        assert.strictEqual(word(line), null, line);
      }
    });

    // A quadratic scan here froze the extension host for seconds on a line holding a data URI,
    // once per keystroke, whether or not any helper was offered.
    test('should stay fast on a very long line', () => {
      const dataUri = `img src="data:image/png;base64,${'A'.repeat(100000)}" = lin`;
      const plainText = `${'a'.repeat(100000)} `;
      const elapsed = fastestOf(() => {
        computeCompletionWord(dataUri);
        computeCompletionWord(plainText);
      });
      assert.ok(elapsed < FAST_ENOUGH_MS, `took ${elapsed}ms`);
    });
  });

  suite('computeReplaceLength', () => {
    test('should swallow the marker only for a body that brings its own', () => {
      assert.strictEqual(applied('= link', OUTPUT_BODY), OUTPUT_BODY);
      assert.strictEqual(applied('p= link', OUTPUT_BODY), `p${OUTPUT_BODY}`);
      assert.strictEqual(applied('= cache', SILENT_BODY), SILENT_BODY);
    });

    // Losing the '=' would turn `= image_alt(...)` into a line of literal text.
    test('should leave the marker alone for a body without one', () => {
      assert.strictEqual(applied('= image_al', BARE_BODY), `= ${BARE_BODY}`);
      assert.strictEqual(applied('  = image_al', BARE_BODY), `  = ${BARE_BODY}`);
    });

    // A bare identifier plus a markerless body is just a line of text, so it is not offered.
    test('should not offer a markerless body where there is no marker', () => {
      assert.strictEqual(applied('image_al', BARE_BODY), null);
      assert.strictEqual(applied('link', OUTPUT_BODY), OUTPUT_BODY);
    });

    // Slim tag names admit '-', so `p- cache` would silently become a tag called `p-` rather than
    // failing to compile.
    test('should not offer a control code body after a tag', () => {
      assert.strictEqual(applied('p= cache', SILENT_BODY), null);
      assert.strictEqual(applied('td= cache', SILENT_BODY), null);
      assert.strictEqual(applied('== cache', SILENT_BODY), null);
      assert.strictEqual(applied('= cache', SILENT_BODY), SILENT_BODY);
    });

    // "Illegal nesting: content can't be both given on the same line as a tag and nested within it."
    test('should not offer a block body after a tag', () => {
      assert.strictEqual(applied('p= form_w', BLOCK_BODY), null);
      assert.strictEqual(applied('= form_w', BLOCK_BODY), BLOCK_BODY);
    });
  });

  // The question partial navigation asks: is this identifier Ruby? Unlike computeCompletionWord it
  // has no body to protect, so a marker carrying a whitespace modifier is as good as a plain one.
  suite('isScriptPosition', () => {
    test('should accept an identifier after any script marker', () => {
      for (const prefix of ['= render', '== render', '- render', '=> render', '=<> render', "==' render", 'p= render', 'td => render']) {
        assert.strictEqual(isScriptPosition(prefix), true, prefix);
      }
    });

    test('should reject an identifier in text, after a tag modifier, or missing altogether', () => {
      for (const prefix of ['render', 'p Please render', "' render", 'p> render', '= ', '']) {
        assert.strictEqual(isScriptPosition(prefix), false, prefix);
      }
    });
  });
});
