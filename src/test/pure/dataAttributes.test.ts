import * as assert from 'node:assert';
import { DATA_ATTRIBUTE_COMPLETIONS, DATA_ATTRIBUTES } from '../../pure/dataAttributes';
import type { AttributeSyntax, DataAttributeCompletion } from '../../types';

function find(syntax: AttributeSyntax, label: string): DataAttributeCompletion | undefined {
  return DATA_ATTRIBUTE_COMPLETIONS[syntax].find((completion) => completion.label === label);
}

suite('pure/dataAttributes Test Suite', () => {
  suite('DATA_ATTRIBUTES', () => {
    test('should hold lowercase dashed names that all start with data-', () => {
      for (const attribute of DATA_ATTRIBUTES) {
        assert.ok(attribute.name.startsWith('data-'), attribute.name);
        assert.strictEqual(attribute.name, attribute.name.toLowerCase(), attribute.name);
        assert.ok(/^[a-z-]+$/.test(attribute.name), attribute.name);
      }
    });

    test('should hold no duplicates', () => {
      const names = DATA_ATTRIBUTES.map((attribute) => attribute.name);
      assert.strictEqual(new Set(names).size, names.length);
    });

    test('should describe every attribute', () => {
      for (const attribute of DATA_ATTRIBUTES) {
        assert.ok(attribute.description.length > 0, attribute.name);
      }
    });

    // Stimulus target, value, class and outlet names are per controller, so a pattern label would
    // never fuzzy-match what the user types. Only the two fixed names are offered.
    test('should offer only the two fixed Stimulus attributes', () => {
      const stimulus = DATA_ATTRIBUTES.filter((attribute) => attribute.source === 'Stimulus').map((attribute) => attribute.name);
      assert.deepStrictEqual(stimulus, ['data-action', 'data-controller']);
    });
  });

  suite('DATA_ATTRIBUTE_COMPLETIONS', () => {
    test('should render an attribute that takes a value the same way in both notations', () => {
      assert.strictEqual(find('htmlAttributes', 'data-turbo-frame')?.body, 'data-turbo-frame="$1"');
      assert.strictEqual(find('wrappedAttributes', 'data-turbo-frame')?.body, 'data-turbo-frame="$1"');
    });

    // Presence is the value. A bare name after the tag would be inline text, so the bare notation
    // spells the boolean out as `=true`; inside a wrapper the bare name is the boolean form.
    test('should render a valueless attribute per notation', () => {
      assert.strictEqual(find('htmlAttributes', 'data-turbo-permanent')?.body, 'data-turbo-permanent=true');
      assert.strictEqual(find('wrappedAttributes', 'data-turbo-permanent')?.body, 'data-turbo-permanent');
    });

    // The generic entry teaches the notation itself: the HTML specification defines no data-* names.
    test('should offer a generic data-* entry in both notations', () => {
      assert.strictEqual(find('htmlAttributes', 'data-')?.body, 'data-${1:name}="$2"');
      assert.strictEqual(find('wrappedAttributes', 'data-')?.body, 'data-${1:name}="$2"');
    });

    test('should render every attribute in both notations', () => {
      assert.strictEqual(DATA_ATTRIBUTE_COMPLETIONS.htmlAttributes.length, DATA_ATTRIBUTES.length + 1);
      assert.strictEqual(DATA_ATTRIBUTE_COMPLETIONS.wrappedAttributes.length, DATA_ATTRIBUTES.length + 1);
    });

    test('should carry the source as the detail and the description as documentation', () => {
      const frame = find('htmlAttributes', 'data-turbo-frame');
      assert.strictEqual(frame?.detail, 'Turbo');
      assert.ok((frame?.documentation.length ?? 0) > 0);
    });
  });
});
