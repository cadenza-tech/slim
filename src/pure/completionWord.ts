// Works out what a snippet that opens with a Slim code marker - a Rails view helper, a control-flow
// one - should replace, and whether it belongs there at all.
//
// Three things go wrong without this.
//
// 1. VS Code's default word boundary excludes '.', so at `f.te` the current word is `te`. The 37
//    dotted prefixes still surface through fuzzy matching, but the replace range covers only `te`,
//    so accepting one yields `f.f.text_field`.
//
// 2. Nearly every body starts with `= ` or `- `. Accepting `link_to` at `= link` would otherwise
//    produce `= = link_to(...)`. The script marker has to be inside the replaced range.
//
// 3. Not every body fits every position. A tag can carry a one-line output helper
//    (`span = link_to`) but not a control-code one and not a block, and a body with no marker of
//    its own only makes sense after a marker the user typed.
//
// Everything here scans linearly. An earlier version used /[A-Za-z_][A-Za-z0-9_]*...$/ with no left
// anchor, which is quadratic: a 30,000 character line - an inline data URI is enough - took two
// seconds, and provideCompletionItems runs synchronously on every keystroke.

import {
  findLiteralEnd,
  isBlankText,
  isClosingBracket,
  isIdentifierStart,
  isNameCharacter,
  isOpeningBracket,
  isSpaceCharacter,
  isWordCharacter,
  skipSpaces
} from './characters';

/**
 * Slim's whitespace and escape modifiers, written after `=` / `==`. A marker carrying one is left
 * alone entirely: every body would replace it with a plain `= `, silently dropping what the user
 * deliberately typed.
 */
const MARKER_MODIFIERS = new Set(["'", '<', '>']);

export interface CompletionWord {
  /** Characters before the cursor that make up the identifier being typed. */
  readonly identifierLength: number;
  /** Characters before the identifier that make up the Slim code marker, if any. */
  readonly markerLength: number;
  /** The marker text itself, e.g. '= '. Empty when there is none. */
  readonly marker: string;
  /** True when nothing but whitespace precedes the marker, so any body may replace it. */
  readonly markerAtLineStart: boolean;
}

/** Length of the identifier ending at the cursor, including one dot and a trailing '?'. */
function identifierLength(linePrefix: string): number {
  let end = linePrefix.length;
  if (linePrefix[end - 1] === '?') {
    end--;
  }
  let start = end;
  let dotSeen = false;
  while (start > 0) {
    const character = linePrefix[start - 1];
    if (isWordCharacter(character)) {
      start--;
    } else if (character === '.' && !dotSeen) {
      dotSeen = true;
      start--;
    } else {
      break;
    }
  }
  // An identifier cannot open with a digit or with the dot just walked over.
  while (start < end && !isIdentifierStart(linePrefix[start])) {
    start++;
  }
  return start === end ? 0 : linePrefix.length - start;
}

/**
 * True when `text` is a Slim tag header - tag word, ./# shorthand, wrapper groups, bare
 * `name=value` attributes - and nothing else.
 *
 * This is what keeps helpers out of positions that merely happen to end in '='. Inline text
 * (`p Price = tot`), a code line (`- x = tot`), an attribute's own `=` (`a href= `) and an
 * unbalanced wrapper (`a(href=x`) are all rejected; `span = ` and `a href="/" = ` are not - a bare
 * word before the marker is a tag in Slim.
 */
function isTagHeader(text: string): boolean {
  let index = skipSpaces(text, 0);
  if (index === text.length) {
    return true;
  }
  const lead = text[index] as string;
  if (!isNameCharacter(lead) && lead !== '.' && lead !== '#') {
    return false;
  }
  for (;;) {
    while (
      index < text.length &&
      (isNameCharacter(text[index]) || text[index] === '.' || text[index] === '#' || (text[index] === ':' && isNameCharacter(text[index + 1])))
    ) {
      index++;
    }
    // An inline tag - `li: span= x` - restarts the header after the colon. `tag:name` XML tags
    // carry no space after theirs, which is how the two are told apart; attributePosition.ts makes
    // the same distinction.
    if (text[index] !== ':' || (index + 1 < text.length && !isSpaceCharacter(text[index + 1] as string))) {
      break;
    }
    index = skipSpaces(text, index + 1);
    if (index === text.length) {
      // `li:` right before the marker: the marker sits where the chained tag's name belongs.
      return false;
    }
    const chainLead = text[index] as string;
    if (!isNameCharacter(chainLead) && chainLead !== '.' && chainLead !== '#') {
      return false;
    }
  }

  let depth = 0;
  let inToken = false;
  let tokenHasEq = false;
  for (; index < text.length; index++) {
    const character = text[index] as string;
    if (character === "'" || character === '"') {
      if (depth === 0 && !(inToken && tokenHasEq)) {
        // A literal anywhere but an attribute value is inline text: `p "hello" = x` is prose.
        return false;
      }
      // A quoted value is opaque: `a(title=":)")` holds a bracket and `a title="b c"` holds a
      // space, and counting either would reject a perfectly balanced header.
      const end = findLiteralEnd(text, index);
      if (end === text.length) {
        // Unterminated: whatever follows - including the '=' that made classifyHead ask - is
        // still string content, not a header.
        return false;
      }
      index = end;
      continue;
    }
    if (isOpeningBracket(character)) {
      depth++;
      continue;
    }
    if (isClosingBracket(character)) {
      depth--;
      if (depth < 0) {
        return false;
      }
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (isSpaceCharacter(character)) {
      if (inToken && !tokenHasEq) {
        // A completed bare token with no '=' is inline text, not an attribute.
        return false;
      }
      inToken = false;
      tokenHasEq = false;
      continue;
    }
    if (character === '=') {
      if (!inToken) {
        return false;
      }
      tokenHasEq = true;
      continue;
    }
    if (character === '*' && !inToken) {
      // A splat token injects attributes and never carries a bare '='.
      inToken = true;
      tokenHasEq = true;
      continue;
    }
    inToken = true;
  }
  // A trailing token is the attribute whose '=' triggered the question, e.g. `a href` of `a href=`.
  if (inToken && !tokenHasEq) {
    return false;
  }
  return depth === 0 && !inToken;
}

function classifyHead(head: string): Pick<CompletionWord, 'marker' | 'markerLength' | 'markerAtLineStart'> | null {
  let end = head.length;
  while (end > 0 && isSpaceCharacter(head[end - 1])) {
    end--;
  }
  if (end === 0) {
    return { marker: '', markerLength: 0, markerAtLineStart: true };
  }

  if (MARKER_MODIFIERS.has(head[end - 1] as string)) {
    return null;
  }
  // A control-code marker is only ever the first thing on a line.
  if (head[end - 1] === '-') {
    return isBlankText(head.slice(0, end - 1)) ? marker(head, end - 1, true) : null;
  }
  if (head[end - 1] !== '=') {
    return null;
  }

  let runStart = end;
  while (runStart > 0 && head[runStart - 1] === '=') {
    runStart--;
  }
  if (!isTagHeader(head.slice(0, runStart))) {
    return null;
  }
  // Only the last '=' is taken, so the first half of Slim's unescaped `==` keeps the meaning the
  // user typed: the body's own `= ` lands after it and the line stays `== link_to ...`.
  return marker(head, end - 1, isBlankText(head.slice(0, end - 1)));
}

function marker(head: string, from: number, atLineStart: boolean): Pick<CompletionWord, 'marker' | 'markerLength' | 'markerAtLineStart'> {
  const text = head.slice(from);
  return { marker: text, markerLength: text.length, markerAtLineStart: atLineStart };
}

/** Returns null wherever a line of Ruby cannot start. */
export function computeCompletionWord(linePrefix: string): CompletionWord | null {
  const length = identifierLength(linePrefix);
  if (length === 0) {
    return null;
  }
  const head = classifyHead(linePrefix.slice(0, linePrefix.length - length));
  return head === null ? null : { identifierLength: length, ...head };
}

/**
 * How many characters this particular body should replace, or null when it does not belong here.
 *
 * The eight upstream helpers that carry no marker of their own (image_alt, strip_tags, ...) go
 * inside an existing expression, so they need the marker the user typed to stay put.
 */
export function computeReplaceLength(word: CompletionWord, body: string): number | null {
  const carriesMarker = body.startsWith('= ') || body.startsWith('- ');
  if (word.markerLength === 0) {
    // Nothing but the identifier: only a body that supplies its own marker yields a valid line.
    return carriesMarker ? word.identifierLength : null;
  }
  // A tag - or the first half of `==` - already opened the line, so a control-code body and the
  // illegal nesting of `span = form_with ... do` are both out; a one-line `= ` body fits.
  if (!word.markerAtLineStart && (!body.startsWith('= ') || body.includes('\n'))) {
    return null;
  }
  return word.identifierLength + (carriesMarker ? word.markerLength : 0);
}

/**
 * The word VS Code should filter the item by.
 *
 * The filter word runs from the replaced range's start to the cursor, so when the range reaches back
 * over the Slim code marker the prefix alone would never match what the user has typed.
 */
export function filterTextFor(word: CompletionWord, replaceLength: number, prefix: string): string {
  return (replaceLength > word.identifierLength ? word.marker : '') + prefix;
}
