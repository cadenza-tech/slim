import * as assert from 'node:assert';
import { classifyAttributePosition } from '../../pure/attributePosition';
import type { AttributeSyntax } from '../../types';
import { FAST_ENOUGH_MS, fastestOf } from '../support/timing';

function syntaxAt(linePrefix: string): AttributeSyntax | null {
  return classifyAttributePosition(linePrefix)?.syntax ?? null;
}

/** What the line becomes once an item is accepted, so expectations read as Slim. */
function applied(linePrefix: string, body: string): string | null {
  const position = classifyAttributePosition(linePrefix);
  if (position === null) {
    return null;
  }
  return linePrefix.slice(0, linePrefix.length - position.identifierLength) + body;
}

suite('pure/attributePosition Test Suite', () => {
  suite('positions that take an attribute name', () => {
    test('should classify a name inside a wrapper', () => {
      assert.strictEqual(syntaxAt('a(data-tur'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('a('), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('a[data-tur'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('a{data-tur'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('a(href="/" data-tur'), 'wrappedAttributes');
    });

    // Slim writes its whitespace modifiers between the tag and the attributes: `a> href="/"`.
    test('should classify past a whitespace modifier on the tag', () => {
      assert.strictEqual(syntaxAt('a> href="/" da'), 'htmlAttributes');
      assert.strictEqual(syntaxAt('a< da'), 'htmlAttributes');
      assert.strictEqual(syntaxAt('a<>(da'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('li: a> da'), 'htmlAttributes');
    });

    // A bare name inside a wrapper is a boolean attribute, so the next word is a name again.
    test('should classify after a boolean attribute inside a wrapper', () => {
      assert.strictEqual(syntaxAt('input(disabled '), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('input(disabled data-tur'), 'wrappedAttributes');
    });

    test('should classify a bare name after the tag', () => {
      assert.strictEqual(syntaxAt('a href="/" data-tur'), 'htmlAttributes');
      assert.strictEqual(syntaxAt("a title='Home' da"), 'htmlAttributes');
      assert.strictEqual(syntaxAt('input type="text" '), 'htmlAttributes');
      assert.strictEqual(syntaxAt('span data-count=items.count da'), 'htmlAttributes');
    });

    // The first token is indistinguishable from the first word of inline text; the fence only has
    // evidence once a token completes without '='. Offering here is the deliberate trade-off.
    test('should classify the first bare token while it is still being typed', () => {
      assert.strictEqual(syntaxAt('a da'), 'htmlAttributes');
      assert.strictEqual(syntaxAt('a hre'), 'htmlAttributes');
    });

    test('should classify after class and id shorthand', () => {
      assert.strictEqual(syntaxAt('.card(data-tur'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('#main.card{da'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('div.card#main da'), 'htmlAttributes');
      assert.strictEqual(syntaxAt('.card da'), 'htmlAttributes');
    });

    test('should classify past an inline tag chain', () => {
      assert.strictEqual(syntaxAt('li: a(data-tur'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt('li: a href="/" da'), 'htmlAttributes');
    });

    // Slim's tag pattern admits XML namespaces, where the colon runs straight into a name.
    test('should classify after an XML namespace tag', () => {
      assert.strictEqual(syntaxAt('fb:like href="/" da'), 'htmlAttributes');
    });

    test('should classify after a splat', () => {
      assert.strictEqual(syntaxAt("div *{id: 'x'} da"), 'htmlAttributes');
      assert.strictEqual(syntaxAt('div(*splat da'), 'wrappedAttributes');
    });

    // Interpolation braces inside a value string must not be read as brackets.
    test('should step over interpolation inside a quoted value', () => {
      assert.strictEqual(syntaxAt('a title="a#{b}c" da'), 'htmlAttributes');
      assert.strictEqual(syntaxAt('a(title="a{" da'), 'wrappedAttributes');
      assert.strictEqual(syntaxAt("a title='it\\'s' da"), 'htmlAttributes');
    });

    // The identifier has to reach back over the dashes, or accepting data-turbo-frame at `data-tur`
    // would leave `data-data-turbo-frame` behind - the f.f.text_field bug in another guise.
    test('should replace the whole attribute name including dashes', () => {
      assert.strictEqual(applied('a(data-tur', 'data-turbo-frame="$1"'), 'a(data-turbo-frame="$1"');
      assert.strictEqual(applied('a href="/" data-tur', 'data-turbo-frame="$1"'), 'a href="/" data-turbo-frame="$1"');
    });
  });

  suite('positions that do not', () => {
    // Offering an attribute name where a value belongs is worse than offering nothing.
    test('should reject a value position', () => {
      assert.strictEqual(syntaxAt('a href='), null);
      assert.strictEqual(syntaxAt('a href="x'), null);
      assert.strictEqual(syntaxAt('a href=dat'), null);
      assert.strictEqual(syntaxAt('a(href='), null);
      assert.strictEqual(syntaxAt('a(href="x'), null);
      assert.strictEqual(syntaxAt('a(data-turbo-frame='), null);
    });

    // Slim's attribute regexes allow whitespace after the `=`, so the value has not started yet and
    // the position is still its own - `a href= data-turbo` would assign a name to href.
    test('should stay in the value position across the space after an equals sign', () => {
      assert.strictEqual(syntaxAt('a href= '), null);
      assert.strictEqual(syntaxAt('a href= da'), null);
      assert.strictEqual(syntaxAt('a href=  \tda'), null);
      assert.strictEqual(syntaxAt('a(href= da'), null);
      assert.strictEqual(syntaxAt('a href= "/" da'), 'htmlAttributes');
    });

    // `doctype` reads like a tag and is not one: what follows it is a doctype name.
    test('should reject everything after doctype', () => {
      assert.strictEqual(syntaxAt('doctype '), null);
      assert.strictEqual(syntaxAt('doctype ht'), null);
      assert.strictEqual(syntaxAt('doctype-switch da'), 'htmlAttributes');
    });

    // The fence: a completed bare token with no '=' is inline text, and so is everything after it.
    test('should reject bare names after inline text has begun', () => {
      assert.strictEqual(syntaxAt('p Hello da'), null);
      assert.strictEqual(syntaxAt('p Price is high da'), null);
      assert.strictEqual(syntaxAt('doctype html str'), null);
    });

    // A literal is inline text too: Slim never quotes attribute names.
    test('should reject bare names after a literal began the inline text', () => {
      assert.strictEqual(syntaxAt('p "hello" wo'), null);
      assert.strictEqual(syntaxAt('a href="/" "q" da'), null);
    });

    test('should reject once the wrapper is closed', () => {
      assert.strictEqual(syntaxAt('a(href="/") da'), null);
      assert.strictEqual(syntaxAt('a(href="/")'), null);
      assert.strictEqual(syntaxAt('a[href="/"] da'), null);
    });

    test('should reject code, verbatim, comment, escape and HTML lines', () => {
      for (const line of ['- if dat', '= render dat', '| some dat', "' quoted dat", '/ comment dat', '\\= dat', '<div dat', '', '   ']) {
        assert.strictEqual(syntaxAt(line), null, JSON.stringify(line));
      }
    });

    test('should reject the tag header itself', () => {
      assert.strictEqual(syntaxAt('a'), null);
      assert.strictEqual(syntaxAt('div.card'), null);
      assert.strictEqual(syntaxAt('li: '), null);
    });

    // A name typed against a closing quote would fuse with the value it follows.
    test('should reject the position directly after a closing value quote', () => {
      assert.strictEqual(syntaxAt('a href="/"'), null);
      assert.strictEqual(syntaxAt('a href="/"da'), null);
    });

    test('should reject inside a Ruby expression value', () => {
      assert.strictEqual(syntaxAt('span data-count=items.count(da'), null);
      assert.strictEqual(syntaxAt('a(href=path(da'), null);
      assert.strictEqual(syntaxAt('a(data-x={a: 1, da'), null);
    });

    test('should reject an unfinished splat', () => {
      assert.strictEqual(syntaxAt('div *'), null);
      assert.strictEqual(syntaxAt("div *{id: 'x"), null);
    });

    // A bracket where a bare name belongs starts inline text, not an attribute wrapper.
    test('should reject a wrapper that is not attached to the tag header', () => {
      assert.strictEqual(syntaxAt('a href="/" (da'), null);
      assert.strictEqual(syntaxAt('p (da'), null);
    });
  });

  // The same constraint completionWord documents: this runs on every keystroke.
  test('should stay fast on a very long line', () => {
    const dataUri = `img src="data:image/png;base64,${'A'.repeat(100000)}" da`;
    const plainText = `p ${'a'.repeat(100000)} da`;
    const elapsed = fastestOf(() => {
      classifyAttributePosition(dataUri);
      classifyAttributePosition(plainText);
    });
    assert.ok(elapsed < FAST_ENOUGH_MS, `took ${elapsed}ms`);
  });
});
