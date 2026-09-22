import * as assert from 'node:assert';
import { linterDocUrl, mapOffense, mapOffenses } from '../../pure/diagnosticMapper';
import type { DocumentSnapshot } from '../../pure/textModel';
import type { Offense } from '../../types';
import { snapshotOfLines } from '../support/snapshot';

const snapshot = (...lines: string[]): DocumentSnapshot => snapshotOfLines(lines);

function offense(overrides: Partial<Offense> = {}): Offense {
  return { line: 1, severity: 'warning', message: 'm', ...overrides };
}

suite('pure/diagnosticMapper Test Suite', () => {
  test('should convert a 1-based line to a 0-based range covering the code', () => {
    const spec = mapOffense(offense({ line: 2 }), snapshot('div', '  p hello', 'span'));
    assert.deepStrictEqual(spec.start, { line: 1, character: 2 });
    assert.deepStrictEqual(spec.end, { line: 1, character: 9 });
  });

  test('should skip leading indentation', () => {
    const spec = mapOffense(offense({ line: 1 }), snapshot('      div'));
    assert.strictEqual(spec.start.character, 6);
  });

  // TrailingWhitespace and FinalNewline report exactly this shape, and skipping the indentation
  // would collapse the range to zero width, which VS Code does not render.
  test('should never produce a zero-width range on a whitespace-only line', () => {
    const spec = mapOffense(offense({ line: 1 }), snapshot('    ', 'div'));
    assert.deepStrictEqual(spec.start, { line: 0, character: 0 });
    assert.deepStrictEqual(spec.end, { line: 0, character: 4 });
  });

  test('should extend an empty line into the next line', () => {
    const spec = mapOffense(offense({ line: 2 }), snapshot('div', '', 'span'));
    assert.deepStrictEqual(spec.start, { line: 1, character: 0 });
    assert.deepStrictEqual(spec.end, { line: 2, character: 0 });
  });

  test('should extend an empty final line backwards', () => {
    const spec = mapOffense(offense({ line: 2 }), snapshot('div', ''));
    assert.deepStrictEqual(spec.start, { line: 0, character: 3 });
    assert.deepStrictEqual(spec.end, { line: 1, character: 0 });
  });

  test('should clamp line 0, which slim-lint uses for file-level errors', () => {
    const spec = mapOffense(offense({ line: 0 }), snapshot('div'));
    assert.strictEqual(spec.start.line, 0);
  });

  test('should clamp a line past the end of the buffer after an edit race', () => {
    const spec = mapOffense(offense({ line: 999 }), snapshot('div', 'span'));
    assert.strictEqual(spec.start.line, 1);
    assert.strictEqual(spec.end.line, 1);
  });

  test('should carry severity through', () => {
    assert.strictEqual(mapOffense(offense({ severity: 'error' }), snapshot('div')).severity, 'error');
    assert.strictEqual(mapOffense(offense({ severity: 'warning' }), snapshot('div')).severity, 'warning');
  });

  test('should attach a documentation link when the linter is known', () => {
    const spec = mapOffense(offense({ linterName: 'LineLength' }), snapshot('div'));
    assert.deepStrictEqual(spec.code, {
      value: 'LineLength',
      target: 'https://github.com/sds/slim-lint/blob/main/lib/slim_lint/linter/README.md#linelength'
    });
  });

  test('should omit the code when slim-lint reported no linter', () => {
    assert.strictEqual(mapOffense(offense(), snapshot('div')).code, undefined);
  });

  test('should lowercase the anchor, matching GitHub heading anchors', () => {
    assert.strictEqual(linterDocUrl('RuboCop'), 'https://github.com/sds/slim-lint/blob/main/lib/slim_lint/linter/README.md#rubocop');
  });

  test('should map every offense', () => {
    const specs = mapOffenses([offense({ line: 1 }), offense({ line: 2 })], snapshot('div', 'span'));
    assert.strictEqual(specs.length, 2);
  });

  test('should return nothing for no offenses', () => {
    assert.deepStrictEqual(mapOffenses([], snapshot('div')), []);
  });

  // slim-lint's RuboCop linter builds its offense from RuboCop's line alone, so a cop that fires
  // twice on one line - `= foo("a", "b")` under Style/StringLiterals - arrives as two entries that
  // differ in nothing. Both would be drawn over the whole line, with the same message.
  test('should show an offense reported twice only once', () => {
    const twice = [offense({ line: 1, message: 'Style/StringLiterals: Prefer single-quoted strings.', linterName: 'RuboCop' })];
    const specs = mapOffenses([...twice, ...twice], snapshot('= foo("a", "b")'));
    assert.strictEqual(specs.length, 1);
  });

  // Two cops of one line are two findings. slim-lint names the linter `RuboCop` for both, so the
  // message is the only thing telling them apart.
  test('should keep two offenses that differ only in their message', () => {
    const style = offense({ line: 1, message: 'Style/StringLiterals: Prefer single-quoted strings.', linterName: 'RuboCop' });
    const layout = offense({ line: 1, message: 'Layout/SpaceInsideParens: Space inside parentheses detected.', linterName: 'RuboCop' });
    assert.strictEqual(mapOffenses([style, layout], snapshot('= foo( "a" )')).length, 2);
  });

  // The severity and the linter are as much a part of what is drawn as the message is.
  test('should keep offenses that differ in severity or linter', () => {
    const base = { line: 1, message: 'm' } as const;
    const specs = mapOffenses(
      [offense({ ...base, severity: 'warning' }), offense({ ...base, severity: 'error' }), offense({ ...base, linterName: 'RuboCop' })],
      snapshot('div')
    );
    assert.strictEqual(specs.length, 3);
  });

  // Two lines past the end of a short buffer clamp onto the same range, which is the range the
  // panel draws: identical there means identical to the reader.
  test('should treat offenses clamped onto one line as repeats', () => {
    const specs = mapOffenses([offense({ line: 8 }), offense({ line: 9 })], snapshot('div'));
    assert.strictEqual(specs.length, 1);
  });

  test('should survive a single empty line', () => {
    const spec = mapOffense(offense({ line: 1 }), snapshot(''));
    assert.deepStrictEqual(spec.start, { line: 0, character: 0 });
    assert.deepStrictEqual(spec.end, { line: 0, character: 0 });
  });
});
