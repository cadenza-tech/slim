// Selection normalization and indentation arithmetic, shared by the selection refactorings.
//
// The block rule mirrors disableComment's findBlockEnd - a Slim block is its own line plus every
// line indented deeper - but anchored to the selection's shallowest indent rather than to one line.

import { indentColumns, isBlankText, skipSpaces } from './characters';
import type { DocumentSnapshot } from './textModel';

/**
 * A control line that carries on the statement opened at its own indent instead of starting one.
 * Runs once per command, not per keystroke, which is what makes a regex affordable here.
 */
const BRANCH_LINE = /^[ \t]*-\s*(?:else|elsif|when|in|rescue|ensure)\b/;
/** The branches that may sit a level under their opener, and the only opener that lets them. */
const NESTABLE_BRANCH = /^[ \t]*-\s*(?:when|in|else)\b/;
const CASE_OPENER = /^[ \t]*-\s*case\b/;
/**
 * A `/` code comment, which Slim drops while parsing: one between a branch and the line it answers
 * to changes nothing, and the disable quick fix writes exactly that. Not `/!` or `/[if]`, which are
 * rendered - Slim refuses an `- else` that follows one.
 */
const CODE_COMMENT = /^[ \t]*\/(?![![])/;

/**
 * The line that opens the statement `lineIndex` is a branch of, or `lineIndex` itself when it is not
 * a branch.
 *
 * The opener is the nearest line above at the same indent that is not a branch itself. A `case` is
 * the exception: Slim takes `- when` one level under `- case` as well as beside it, and once it has,
 * the `- else` of that case sits at the nested level too - so for those two a shallower `- case` is
 * the opener. Any other shallower line means the document is not what it looks like, and nothing
 * is moved. An assigned `- y = case x` only compiles with its branches beside it, which the
 * same-indent rule already covers.
 */
function findBlockStart(lineIndex: number, document: DocumentSnapshot): number {
  const target = document.lineAt(lineIndex).text;
  if (!BRANCH_LINE.test(target)) {
    return lineIndex;
  }
  const indent = indentColumns(target);
  for (let index = lineIndex - 1; index >= 0; index--) {
    const text = document.lineAt(index).text;
    if (isBlankText(text)) {
      continue;
    }
    const columns = indentColumns(text);
    if (columns > indent) {
      continue;
    }
    if (columns < indent) {
      return NESTABLE_BRANCH.test(target) && CASE_OPENER.test(text) ? index : lineIndex;
    }
    if (!BRANCH_LINE.test(text) && !CODE_COMMENT.test(text)) {
      return index;
    }
  }
  return lineIndex;
}

/** Whether the next line of Slim at `indent` after `lineIndex` - code comments aside - is a branch. */
function branchFollows(lineIndex: number, indent: number, document: DocumentSnapshot): boolean {
  for (let index = lineIndex + 1; index < document.lineCount; index++) {
    const text = document.lineAt(index).text;
    if (isBlankText(text)) {
      continue;
    }
    const columns = indentColumns(text);
    if (columns > indent) {
      continue;
    }
    if (columns < indent || !CODE_COMMENT.test(text)) {
      return columns === indent && BRANCH_LINE.test(text);
    }
  }
  return false;
}

const MIN_TAB_SIZE = 1;
const MAX_TAB_SIZE = 8;
const DEFAULT_TAB_SIZE = 2;

export interface LineRange {
  readonly startLine: number;
  /** Inclusive. */
  readonly endLine: number;
}

/** Shaped like a vscode.Selection so the glue translation is a straight copy of its four values. */
export interface SelectionInput {
  readonly startLine: number;
  /** Deliberately ignored: a wrap has to replace from column 0, so there is no partial-line case. */
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

function sharedPrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return left.slice(0, index);
}

/**
 * Turns a selection into the whole lines a refactoring should act on, or null when there are none.
 *
 * The extension at the end is the important part: raising a parent one level without its children
 * would leave them at the parent's own depth and silently detach them, which is the same failure
 * src/pure/disableComment.ts exists to avoid.
 *
 * It extends past the end while lines are deeper than the selection's *shallowest* indent, not just
 * past the last selected line's own block. A selection covering two same-depth siblings can end in
 * the middle of the second one, and asking findBlockEnd about any single line would leave that
 * sibling's remaining children behind. Everything up to the next line at or above the shallowest
 * indent belongs to something selected - and so does a `- else` or `- when` sitting exactly at it:
 * that is a branch of the statement the selection opened, and leaving it behind re-binds it to
 * whatever the refactoring puts in its place.
 *
 * Indents are compared in columns as Slim counts them, so a file mixing tabs and spaces nests here
 * the way it renders.
 */
export function normalizeSelection(selection: SelectionInput, document: DocumentSnapshot): LineRange | null {
  // Dragging over line numbers and Ctrl+L both end on column 0 of the line after the last one wanted.
  let endLine = selection.endCharacter === 0 && selection.endLine > selection.startLine ? selection.endLine - 1 : selection.endLine;
  let startLine = selection.startLine;

  while (startLine <= endLine && isBlankText(document.lineAt(startLine).text)) {
    startLine++;
  }
  while (endLine >= startLine && isBlankText(document.lineAt(endLine).text)) {
    endLine--;
  }
  if (startLine > endLine) {
    return null;
  }

  let shallowestIndent = Number.POSITIVE_INFINITY;
  let shallowestLine = startLine;
  for (let index = startLine; index <= endLine; index++) {
    const line = document.lineAt(index);
    if (isBlankText(line.text)) {
      continue;
    }
    const indent = indentColumns(line.text);
    if (indent < shallowestIndent) {
      shallowestIndent = indent;
      shallowestLine = index;
    }
  }
  // A selection whose shallowest line is an `- else` has left the `- if` it answers to outside, and
  // neither half survives being raised or extracted alone. For a `- when` nested under its `- case`
  // the opener is shallower still, which moves the indent everything below is measured against.
  const opener = findBlockStart(shallowestLine, document);
  if (opener < startLine) {
    startLine = opener;
    shallowestIndent = Math.min(shallowestIndent, indentColumns(document.lineAt(opener).text));
  }
  // Blank lines defer to what follows them, the way findBlockEnd reads a block: a stanza split by
  // an empty line stays intact, and trailing blanks are not dragged in.
  let blockEnd = endLine;
  for (let index = endLine + 1; index < document.lineCount; index++) {
    const line = document.lineAt(index);
    if (isBlankText(line.text)) {
      continue;
    }
    const indent = indentColumns(line.text);
    if (indent < shallowestIndent) {
      break;
    }
    // A code comment at the statement's own indent only belongs to it when a branch comes after:
    // on its own it is about whatever follows, and is left where it is.
    const carriesOn = BRANCH_LINE.test(line.text) || (CODE_COMMENT.test(line.text) && branchFollows(index, indent, document));
    if (indent === shallowestIndent && !carriesOn) {
      break;
    }
    blockEnd = index;
  }
  return { startLine, endLine: blockEnd };
}

export function linesOf(range: LineRange, document: DocumentSnapshot): string[] {
  const lines: string[] = [];
  for (let index = range.startLine; index <= range.endLine; index++) {
    lines.push(document.lineAt(index).text);
  }
  return lines;
}

/**
 * The leading whitespace every non-blank line shares, as a string rather than a width.
 *
 * Taken verbatim the way disableComment takes it, so tabs stay tabs. Mixed tabs and spaces share no
 * prefix and yield '' - which is not an answer a caller can act on, so the commands ask
 * mixesIndentation first and decline.
 */
export function commonIndent(lines: readonly string[]): string {
  let common: string | null = null;
  for (const line of lines) {
    if (isBlankText(line)) {
      continue;
    }
    const indent = line.slice(0, skipSpaces(line, 0));
    common = common === null ? indent : sharedPrefix(common, indent);
  }
  return common ?? '';
}

/**
 * Whether the lines indent with both tabs and spaces.
 *
 * Slim accepts that - a tab runs to the next multiple of four columns - but no prefix added to or
 * removed from every line keeps such lines at the same relative depth: `\timg` under `  section`
 * becomes its sibling once both gain two spaces. There is no re-indentation to get right, so the
 * commands decline rather than change what the page renders.
 */
export function mixesIndentation(lines: readonly string[]): boolean {
  let sawSpace = false;
  let sawTab = false;
  for (const line of lines) {
    if (isBlankText(line)) {
      continue;
    }
    const indent = line.slice(0, skipSpaces(line, 0));
    sawSpace = sawSpace || indent.includes(' ');
    sawTab = sawTab || indent.includes('\t');
  }
  return sawSpace && sawTab;
}

/** Blank lines stay empty: indenting one would be trailing whitespace, which slim-lint reports. */
export function indentLines(lines: readonly string[], unit: string): string[] {
  return lines.map((line) => (isBlankText(line) ? line : unit + line));
}

export function dedentLines(lines: readonly string[]): string[] {
  const common = commonIndent(lines);
  if (common === '') {
    return [...lines];
  }
  return lines.map((line) => (isBlankText(line) ? line : line.slice(common.length)));
}

/**
 * One indentation level, derived from the editor's own options and nothing else.
 *
 * insertSnippet runs every inserted line through normalizeIndentation, which uses exactly these two
 * values, so choosing anything else here would have VS Code rewrite the result. The clamp is the same
 * defence configSchema applies: detectIndentation reports whatever it found and settings.json is
 * hand-editable.
 */
export function indentUnit(insertSpaces: boolean, tabSize: number | undefined): string {
  if (!insertSpaces) {
    return '\t';
  }
  const width =
    tabSize !== undefined && Number.isFinite(tabSize) ? Math.min(MAX_TAB_SIZE, Math.max(MIN_TAB_SIZE, Math.trunc(tabSize))) : DEFAULT_TAB_SIZE;
  return ' '.repeat(width);
}
