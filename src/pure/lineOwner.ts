// Finds the line that owns another one: the first line of the outermost construct that takes it for
// itself rather than letting it be a Slim line of its own. Pure; no vscode imports.
//
// A line is only a line of its own while whatever stands above it parses its children. A text block,
// a filter, a `/!` comment and a tag carrying inline text all take everything indented deeper as
// content; an attribute wrapper or a literal left open takes the lines that follow whatever their
// indent, and so does a line of Ruby broken with a trailing `,` or `\`. A `/ slim-lint:disable`
// written among lines like those is rendered into the page, or breaks the expression apart - so the
// pair goes around the owner instead, which silences the line all the same: slim-lint reads its
// directives off the raw source lines.
//
// Every rule below follows Slim::Parser and was checked by rendering through Slim 5.2.2. Precision
// matters in both directions: a consumer missed puts the comment into the page, and a statement read
// as longer than it is puts the closing comment beneath a line that swallows it.

import {
  findLiteralEnd,
  indentColumns,
  isBlankText,
  isClosingBracket,
  isNameCharacter,
  isOpeningBracket,
  isSpaceCharacter,
  skipSpaces
} from './characters';
import type { DocumentSnapshot } from './textModel';

/**
 * Every engine Slim has shipped, not only the ones the current release registers: a header naming a
 * removed one no longer compiles, and reading its body as verbatim is still the safe answer.
 */
const FILTERS = new Set([
  'asciidoc',
  'builder',
  'coffee',
  'creole',
  'css',
  'erb',
  'javascript',
  'less',
  'markdown',
  'nokogiri',
  'org',
  'rdoc',
  'ruby',
  'sass',
  'scss',
  'textile',
  'wiki'
]);

/** Returned by the scans below for a construct the line opens and does not close. */
const UNCLOSED = -1;
/** Returned for a Ruby attribute value that runs to the end of the line and ends in `,` or `\`. */
const BROKEN = -2;

/**
 * How many lines a statement left open is followed for. A wrapper spanning more than this is not
 * something anyone writes, and the cap is what keeps a hostile file - every line opening a bracket
 * - from turning one quick fix into a scan of the whole document per line above it.
 */
const MAX_STATEMENT_LINES = 50;

/**
 * What a line does with the lines after it.
 *
 * `children`: parses the deeper ones as Slim lines. `content`: takes the deeper ones as its own
 * text. `open` and `broken`: is not finished yet - the next line is the rest of it, whatever its
 * indent.
 */
type Verdict = 'children' | 'content' | 'open' | 'broken';

/** Slim strips the line before looking, so trailing whitespace does not hide the `,` or `\`. */
function endsInContinuation(text: string): boolean {
  let end = text.length;
  while (end > 0 && isSpaceCharacter(text[end - 1])) {
    end--;
  }
  const last = text[end - 1];
  return last === ',' || last === '\\';
}

function skipName(text: string, from: number): number {
  let index = from;
  while (index < text.length && isNameCharacter(text[index])) {
    index++;
  }
  return index;
}

/** A bare word with any `ns:name` parts, then any `.class` / `#id` chain. Returns `from` when there is neither. */
function skipTagHeader(text: string, from: number): number {
  let index = skipName(text, from);
  while (text[index] === ':' && isNameCharacter(text[index + 1])) {
    index = skipName(text, index + 1);
  }
  while (text[index] === '.' || text[index] === '#') {
    index = skipName(text, index + 1);
  }
  return index;
}

/** Index just past the bracket closing the group opened at `openIndex`, literals stepped over whole. */
function skipBalanced(text: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"' || character === "'") {
      const end = findLiteralEnd(text, index);
      if (end === text.length) {
        return UNCLOSED;
      }
      index = end + 1;
      continue;
    }
    if (isOpeningBracket(character)) {
      depth++;
    } else if (isClosingBracket(character)) {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
    index++;
  }
  return UNCLOSED;
}

/**
 * A Ruby attribute value or a splat: it runs to the first space outside every bracket and literal.
 * Slim::Parser#parse_ruby_code carries on with the next line when the value reaches the end of this
 * one on a `,` or a `\`.
 */
function skipRubyValue(text: string, from: number): number {
  let index = from;
  while (index < text.length && !isSpaceCharacter(text[index])) {
    const character = text[index] as string;
    if (character === '"' || character === "'") {
      const end = findLiteralEnd(text, index);
      if (end === text.length) {
        return UNCLOSED;
      }
      index = end + 1;
    } else if (isOpeningBracket(character)) {
      index = skipBalanced(text, index);
      if (index === UNCLOSED) {
        return UNCLOSED;
      }
    } else {
      index++;
    }
  }
  const last = text[index - 1];
  return index === text.length && index > from && (last === ',' || last === '\\') ? BROKEN : index;
}

/** Slim's @attr_name: anything but whitespace, the quotes, `<>/=` and the delimiters. */
function isAttributeNameCharacter(character: string | undefined): boolean {
  if (character === undefined || isSpaceCharacter(character) || isOpeningBracket(character) || isClosingBracket(character)) {
    return false;
  }
  return character !== '"' && character !== "'" && character !== '<' && character !== '>' && character !== '/' && character !== '=';
}

/** Index where the tag's content starts, or UNCLOSED / BROKEN when an attribute runs past the end of the line. */
function skipAttributes(text: string, from: number): number {
  const wrapper = skipSpaces(text, from);
  if (isOpeningBracket(text[wrapper])) {
    return skipBalanced(text, wrapper);
  }

  let index = from;
  for (;;) {
    const start = skipSpaces(text, index);
    if (text[start] === '*' && start + 1 < text.length && !isSpaceCharacter(text[start + 1])) {
      index = skipRubyValue(text, start + 1);
    } else {
      let nameEnd = start;
      while (isAttributeNameCharacter(text[nameEnd])) {
        nameEnd++;
      }
      const equals = skipSpaces(text, nameEnd);
      if (nameEnd === start || text[equals] !== '=') {
        // Not an attribute, so this is where the content starts.
        return index;
      }
      const value = skipSpaces(text, text[equals + 1] === '=' ? equals + 2 : equals + 1);
      if (text[value] === '"' || text[value] === "'") {
        const end = findLiteralEnd(text, value);
        index = end === text.length ? UNCLOSED : end + 1;
      } else {
        index = skipRubyValue(text, value);
      }
    }
    if (index < 0) {
      return index;
    }
  }
}

function classifyTag(text: string, from: number): Verdict {
  let index = from;
  // Slim tries its embedded engines before any tag, and lets attributes sit before the colon.
  const leadingName = text.slice(from, skipName(text, from));
  let mayBeFilter = FILTERS.has(leadingName);
  for (;;) {
    const headerEnd = skipTagHeader(text, index);
    if (headerEnd === index) {
      // Not a tag at all: a line of someone else's text block, or a shape Slim itself rejects.
      return 'children';
    }
    if (mayBeFilter && text[headerEnd] === ':') {
      return 'content';
    }
    index = headerEnd;
    while (text[index] === '<' || text[index] === '>' || text[index] === "'") {
      index++;
    }
    index = skipAttributes(text, index);
    if (index === UNCLOSED) {
      return 'open';
    }
    if (index === BROKEN) {
      return 'broken';
    }
    index = skipSpaces(text, index);
    const lead = text[index];
    if (lead === undefined || lead === '/') {
      return 'children';
    }
    if (lead === '=') {
      return endsInContinuation(text) ? 'broken' : 'children';
    }
    if (lead !== ':') {
      // Inline text, and Slim reads every deeper line as more of it.
      return 'content';
    }
    if (mayBeFilter) {
      return 'content';
    }
    // `li: a href="/"` - the inner tag decides.
    mayBeFilter = false;
    index = skipSpaces(text, index + 1);
  }
}

/**
 * `/` counts as content although a directive inside a code comment would be harmless - the body is
 * dropped from the page and slim-lint still reads it. What is not harmless is reading that body as
 * Slim: a commented-out `x = [1,` would claim the live line below it as the rest of itself.
 */
function classify(text: string): Verdict {
  const index = skipSpaces(text, 0);
  const lead = text[index];
  if (lead === '|' || lead === "'" || lead === '/') {
    return 'content';
  }
  if (lead === '-' || lead === '=') {
    // Slim::Parser#parse_broken_line, which only code and output lines go through: prose ends in
    // commas all the time, and a line of inline text is never continued that way.
    return endsInContinuation(text) ? 'broken' : 'children';
  }
  if (lead === undefined || lead === '<' || lead === '\\') {
    return 'children';
  }
  return classifyTag(text, index);
}

interface Statement {
  /** The last line the statement takes whatever its indent; the head itself unless it is left open. */
  readonly end: number;
  /** Whether the statement, once complete, takes the lines indented deeper than its head as content. */
  readonly consumesDeeper: boolean;
}

/**
 * Reads the statement `head` opens as Slim would: while it is left open, the next line is appended
 * and the whole is read again. Joining with a space is what Slim's own continuation amounts to for
 * every construct that can be left open - attributes are separated by whitespace, and a Ruby
 * expression does not care.
 */
function statementAt(head: number, document: DocumentSnapshot): Statement {
  let end = head;
  let text = document.lineAt(head).text;
  for (;;) {
    const verdict = classify(text);
    const unfinished = verdict === 'open' || verdict === 'broken';
    if (!unfinished || end + 1 >= document.lineCount || end - head >= MAX_STATEMENT_LINES) {
      return { end, consumesDeeper: verdict !== 'children' };
    }
    end++;
    text = `${text} ${document.lineAt(end).text.slice(skipSpaces(document.lineAt(end).text, 0))}`;
  }
}

/** The last line of the statement `head` opens: `head` itself unless the line is left open. */
export function statementEnd(head: number, document: DocumentSnapshot): number {
  return statementAt(head, document).end;
}

/** Whether the lines indented deeper than this one are its content rather than Slim lines of their own. */
export function consumesDeeperLines(text: string): boolean {
  return classify(text) !== 'children';
}

/** The last non-blank line after `from` indented deeper than `head`, or `from` when there is none. */
function lastDeeperLine(head: number, from: number, document: DocumentSnapshot): number {
  const indent = indentColumns(document.lineAt(head).text);
  let last = from;
  for (let index = from + 1; index < document.lineCount; index++) {
    const text = document.lineAt(index).text;
    if (isBlankText(text)) {
      continue;
    }
    if (indentColumns(text) <= indent) {
      break;
    }
    last = index;
  }
  return last;
}

/** The last line `head` takes for itself: the end of its statement, and of its content if it has any. */
function lastOwnedLine(head: number, document: DocumentSnapshot): number {
  const statement = statementAt(head, document);
  return statement.consumesDeeper ? lastDeeperLine(head, statement.end, document) : statement.end;
}

/**
 * The line a comment has to go above to be a sibling of `lineIndex` rather than part of whatever
 * takes it; `lineIndex` itself when nothing does. `lineIndex` must not be blank.
 *
 * Read from the top of the document, the way Slim parses it, because nothing about a line says on
 * its own whether it is Slim: `foo(1,` opens a wrapper in a template and means nothing in a filter
 * body, and the `)` closing a wrapper sits wherever its author put it. Walking forward, every line
 * asked what it opens is one Slim would parse, and what it takes is stepped over whole - so the
 * answer is the outermost owner without ever looking inside one.
 */
export function owningLine(lineIndex: number, document: DocumentSnapshot): number {
  let index = 0;
  while (index < lineIndex) {
    if (isBlankText(document.lineAt(index).text)) {
      index++;
      continue;
    }
    const last = lastOwnedLine(index, document);
    if (lineIndex <= last) {
      return index;
    }
    // A line that parses its children leaves them to be asked in their turn.
    index = last + 1;
  }
  return lineIndex;
}

/**
 * The last line of the block `head` opens, where `head` is a line owningLine answered with.
 *
 * Indentation decides it, read the same way: a child that opens a wrapper takes the line closing it
 * into the block even when that line sits at the head's own indent or above it.
 */
export function blockEnd(head: number, document: DocumentSnapshot): number {
  const indent = indentColumns(document.lineAt(head).text);
  let end = lastOwnedLine(head, document);
  let index = end + 1;
  while (index < document.lineCount) {
    const text = document.lineAt(index).text;
    if (isBlankText(text)) {
      index++;
      continue;
    }
    if (indentColumns(text) <= indent) {
      break;
    }
    end = lastOwnedLine(index, document);
    index = end + 1;
  }
  return end;
}
