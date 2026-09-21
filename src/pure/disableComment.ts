// Builds `/ slim-lint:disable` / `enable` insertions. Pure; no vscode imports.
//
// `/` is a Slim *code* comment, and every line indented deeper than it is swallowed as part of the
// comment and never rendered. Putting the `enable` marker directly after the offending line
// therefore deletes that line's children from the output:
//
//   / slim-lint:disable LineLength
//   div class="x"                  <- offending line, indent 2
//   / slim-lint:enable LineLength  <- placed here...
//     img src="a.gif"              <- ...and indent 4 > 2 swallows this, so it disappears
//
// The marker therefore goes after the whole block, never after the single line.
//
// The `disable` marker has the mirror-image problem: written above a line that something else
// consumes - the body of a text block or a filter, the rest of a wrapped attribute list - it is
// rendered into the page or breaks the expression apart. src/pure/lineOwner.ts finds the line that
// consumes it, and the pair goes around that one's block instead.

import { isBlankText } from './characters';
import { DIAGNOSTIC_SOURCE } from './diagnosticMapper';
import { blockEnd, owningLine } from './lineOwner';
import type { DocumentSnapshot, Eol } from './textModel';

export interface InsertionSpec {
  readonly line: number;
  readonly character: number;
  readonly text: string;
}

/**
 * Finds the last line belonging to the block that starts at `lineIndex`, which must be a line Slim
 * parses as one of its own.
 *
 * Blank lines never end a block on their own - they are only excluded when nothing deeper follows -
 * so a stanza split by an empty line stays intact. Indents are compared in columns as Slim counts
 * them, and a line left open takes the lines that finish it whatever their indent; both live in
 * src/pure/lineOwner.ts.
 */
export function findBlockEnd(lineIndex: number, document: DocumentSnapshot): number {
  return isBlankText(document.lineAt(lineIndex).text) ? lineIndex : blockEnd(lineIndex, document);
}

/**
 * The line whose indentation both comments are written at, or null in a document of blank lines.
 *
 * A blank target - the shape TrailingWhitespace and EmptyLines report - has no indent of its own,
 * and writing the pair at column 0 there is not neutral: the `enable` marker is a Slim comment,
 * and anything after it indented deeper is swallowed out of the rendered output. The following
 * non-blank line's indent is the one level that can never swallow it; a trailing blank falls back
 * to the preceding line, after which nothing follows that could be swallowed at any indent.
 */
function anchorLine(lineIndex: number, document: DocumentSnapshot): number | null {
  if (!isBlankText(document.lineAt(lineIndex).text)) {
    return lineIndex;
  }
  for (let index = lineIndex + 1; index < document.lineCount; index++) {
    if (!isBlankText(document.lineAt(index).text)) {
      return index;
    }
  }
  for (let index = lineIndex - 1; index >= 0; index--) {
    if (!isBlankText(document.lineAt(index).text)) {
      return index;
    }
  }
  return null;
}

/** Returns the two insertions that wrap a block in a slim-lint disable/enable pair. */
export function buildDisableComment(lineIndex: number, linterName: string, document: DocumentSnapshot, eol: Eol): [InsertionSpec, InsertionSpec] {
  const anchor = anchorLine(lineIndex, document);
  const owner = anchor === null ? null : owningLine(anchor, document);
  // An anchor that owns itself is consumed by nothing, so the pair goes tightly around the target -
  // which for a blank target is not the anchor. Otherwise it goes around whatever consumes it.
  const start = owner === null || owner === anchor ? lineIndex : owner;
  const indentSource = owner === null ? null : document.lineAt(owner);
  const indent = indentSource === null ? '' : indentSource.text.slice(0, indentSource.firstNonWhitespaceCharacterIndex);
  // A blank target nothing takes is wrapped on its own. A trailing blank one can lie past the end
  // of the block that owns its anchor, and has to be covered all the same.
  const end = start === lineIndex ? findBlockEnd(start, document) : Math.max(lineIndex, blockEnd(start, document));

  const disable: InsertionSpec = {
    line: start,
    character: 0,
    text: `${indent}/ slim-lint:disable ${linterName}${eol}`
  };

  if (end + 1 < document.lineCount) {
    return [disable, { line: end + 1, character: 0, text: `${indent}/ slim-lint:enable ${linterName}${eol}` }];
  }

  // Appending past the last line: the separator has to come first.
  const lastLine = document.lineAt(end);
  return [disable, { line: end, character: lastLine.text.length, text: `${eol}${indent}/ slim-lint:enable ${linterName}` }];
}

/**
 * slim-lint has no per-cop inline disable, so silencing the RuboCop linter silences all Ruby
 * linting. Saying "Style/StringLiterals" while doing that would be dishonest.
 */
export function disableActionTitle(linterName: string): string {
  return linterName === 'RuboCop' ? 'Disable RuboCop (all cops) for this block' : `Disable ${linterName} for this block`;
}

/** The parts of a vscode.Diagnostic this decision reads, so the decision itself needs no vscode. */
export interface DiagnosticFacts {
  readonly source: string | undefined;
  /** `string | number | { value, target }` in the API. Narrowed here, not at the call site. */
  readonly code: unknown;
  readonly line: number;
}

export interface DisableActionPlan {
  /** Index into the input, so the caller can attach the diagnostic the action answers. */
  readonly index: number;
  readonly line: number;
  readonly linterName: string;
}

/** Syntax and parse errors carry no linter, so nothing can be disabled for them. */
export function linterNameOf(code: unknown): string | undefined {
  if (typeof code === 'string') {
    return code;
  }
  if (typeof code === 'object' && code !== null && 'value' in code) {
    return String((code as { value: unknown }).value);
  }
  return undefined;
}

/**
 * Which disable actions to offer, in input order.
 *
 * One per (line, linter): slim-lint reports no column, so two offenses of the same linter on one
 * line would otherwise offer two identical comments. Diagnostics from other extensions are skipped -
 * offering to write a slim-lint directive for someone else's finding would do nothing.
 */
export function planDisableActions(diagnostics: readonly DiagnosticFacts[]): readonly DisableActionPlan[] {
  const plans: DisableActionPlan[] = [];
  const seen = new Set<string>();

  for (const [index, diagnostic] of diagnostics.entries()) {
    if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
      continue;
    }
    const linterName = linterNameOf(diagnostic.code);
    if (linterName === undefined) {
      continue;
    }
    // NUL-joined for the same reason the client's coalescing key is: it cannot appear in either part.
    const key = `${diagnostic.line}\u0000${linterName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    plans.push({ index, line: diagnostic.line, linterName });
  }
  return plans;
}
