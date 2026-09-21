// A DocumentSnapshot over plain lines, for the suites that must not load vscode.

import type { DocumentSnapshot, Eol } from '../../pure/textModel';

/**
 * Counts space and tab only, which is what snapshotOf in src/documentSnapshot.ts does. It is not what
 * vscode.TextLine.firstNonWhitespaceCharacterIndex does: that one is `\s`-based and takes NBSP and
 * U+3000 for indentation, where Slim renders them as content.
 *
 * The copies this replaces used `/\S/`, which additionally treats \v, \f and NBSP as whitespace - so
 * a line like "p" reported 1 here and 0 to Slim. src/test/integration/documentSnapshot pins
 * this fake against the real adapter, on lines led by exactly those characters.
 */
function firstNonWhitespaceCharacterIndex(text: string): number {
  let index = 0;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
    index++;
  }
  return index;
}

export function snapshotOfLines(lines: readonly string[]): DocumentSnapshot {
  return {
    lineCount: lines.length,
    lineAt(index: number) {
      const text = lines[index] ?? '';
      return { text, firstNonWhitespaceCharacterIndex: firstNonWhitespaceCharacterIndex(text) };
    }
  };
}

/** Absolute offset of a (line, character) position in `lines` joined by `eol`. */
export function offsetOf(lines: readonly string[], line: number, character: number, eol: Eol): number {
  let offset = 0;
  for (let index = 0; index < line; index++) {
    offset += (lines[index] as string).length + eol.length;
  }
  return offset + character;
}
