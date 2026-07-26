// Decides whether the cursor sits where a Slim tag attribute name belongs, and in which of the two
// notations.
//
// Attributes come bare after the tag - `a href="/" title="x"` - or inside a ()/[]/{} wrapper. The
// hard half is the bare notation, because the same position also holds the tag's inline text:
// `p Hello wo` and `a href="/" da` are indistinguishable until the token shapes are read, which is
// what the text fence below is for. Telling a name position from a value or text position is the
// whole job: offering `data-turbo-frame` where prose belongs is worse than offering nothing.
//
// Single line only. A wrapper spread over several lines cannot be judged from the prefix of one of
// them, which is what provideCompletionItems has to work with.
//
// Everything scans linearly, for the reason src/pure/completionWord.ts documents: this runs on every
// keystroke and a Slim line can hold an inline data URI.

import type { AttributeSyntax } from '../types';
import { findLiteralEnd, isNameCharacter, isSpaceCharacter, skipSpaces } from './characters';

/** Line leads that can never be a tag: code, verbatim text, comment, escape, inline HTML. */
const REJECT_STARTS = new Set(['-', '=', '|', "'", '/', '\\', '<']);

export interface AttributePosition {
  readonly syntax: AttributeSyntax;
  /**
   * Length of the name being typed. Unlike completionWord's identifier this reaches back over dashes:
   * replacing only `tur` in `data-tur` would leave `data-data-turbo-frame` behind, which is the
   * f.f.text_field bug in another guise.
   */
  readonly identifierLength: number;
}

/** Brackets on the tag header wrap attributes; brackets anywhere deeper are Ruby expressions. */
type Bracket = 'wrapper' | 'ruby';

/** Null wherever an attribute name cannot go. */
export function classifyAttributePosition(linePrefix: string): AttributePosition | null {
  let index = skipSpaces(linePrefix, 0);
  const lead = linePrefix[index];
  if (lead === undefined || REJECT_STARTS.has(lead)) {
    return null;
  }

  // --- The tag header: a bare word, a ./# shorthand chain, or both. `li: a` restarts it. ---
  let sawHeader = false;
  const consumeName = (): boolean => {
    const from = index;
    while (index < linePrefix.length && isNameCharacter(linePrefix[index])) {
      index++;
    }
    return index > from;
  };
  for (;;) {
    if (consumeName()) {
      sawHeader = true;
      // XML namespace tags - fb:like - carry the colon straight into the next name character.
      while (linePrefix[index] === ':' && isNameCharacter(linePrefix[index + 1])) {
        index++;
        consumeName();
      }
    }
    while (linePrefix[index] === '.' || linePrefix[index] === '#') {
      index++;
      consumeName();
      sawHeader = true;
    }
    if (!sawHeader) {
      return null;
    }
    // An inline tag - `li: a href="/"` - puts a second header after the colon. `tag:name` XML
    // tags carry no space after theirs, which is how the two are told apart.
    if (linePrefix[index] === ':' && (index + 1 >= linePrefix.length || isSpaceCharacter(linePrefix[index + 1]))) {
      index = skipSpaces(linePrefix, index + 1);
      if (index >= linePrefix.length) {
        // The cursor sits where the inline tag's name goes, which is not an attribute position.
        return null;
      }
      sawHeader = false;
      continue;
    }
    break;
  }

  const stack: Bracket[] = [];
  /** Inside the value half of an attribute, after its `=`. */
  let inValue = false;
  /** Name characters consumed since the last separator. */
  let pendingToken = false;
  /** Whether that token has seen its `=`, i.e. is an attribute rather than prose. */
  let tokenHadEq = false;
  /** Bare notation needs one space after the header before any attribute can start. */
  let sawBareSeparator = false;
  /** A wrapper only opens directly on the header; a bracket after anything else is Ruby or text. */
  let atHeaderEnd = true;
  /** Just past a closing value quote: a name typed here would fuse with the value. */
  let needsSeparator = false;

  for (; index < linePrefix.length; index++) {
    const character = linePrefix[index] as string;

    if (character === "'" || character === '"') {
      if (stack.length === 0 && !inValue) {
        // A literal where a bare attribute name belongs starts inline text - `p "hello"` - and
        // Slim never quotes attribute names.
        return null;
      }
      const end = findLiteralEnd(linePrefix, index);
      if (end === linePrefix.length) {
        // Unterminated: the cursor is inside a value literal.
        return null;
      }
      index = end;
      if (stack[stack.length - 1] !== 'ruby' && inValue) {
        inValue = false;
        pendingToken = false;
        tokenHadEq = false;
        needsSeparator = true;
      }
      atHeaderEnd = false;
      continue;
    }

    const top = stack[stack.length - 1];

    if (character === '(' || character === '[' || character === '{') {
      if (top === undefined && atHeaderEnd) {
        stack.push('wrapper');
      } else if (top !== undefined || inValue) {
        stack.push('ruby');
      } else {
        // A bracket where a bare attribute name belongs starts inline text.
        return null;
      }
      atHeaderEnd = false;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const closed = stack.pop();
      if (closed === undefined || closed === 'wrapper') {
        // Past the wrapper - or with no bracket open at all - the rest of the line is inline text.
        return null;
      }
      atHeaderEnd = false;
      continue;
    }

    if (top === 'ruby') {
      atHeaderEnd = false;
      continue;
    }

    if (isSpaceCharacter(character)) {
      if (stack.length === 0) {
        if (pendingToken && !tokenHadEq) {
          // The fence: a completed bare token with no `=` is prose, and so is everything after it.
          return null;
        }
        sawBareSeparator = true;
      }
      inValue = false;
      pendingToken = false;
      tokenHadEq = false;
      needsSeparator = false;
      atHeaderEnd = false;
      continue;
    }

    if (character === '=') {
      if (pendingToken && !inValue) {
        tokenHadEq = true;
        inValue = true;
      } else if (stack.length === 0 && !inValue) {
        // `a = expr` writes output; the rest of the line is Ruby, not attributes.
        return null;
      }
      // A second `=` or a comparison operator inside a value changes nothing.
      atHeaderEnd = false;
      continue;
    }

    if (character === '*' && !inValue && !pendingToken) {
      // A splat - `*{...}` or `*hash` - injects attributes; it reads like a value token.
      pendingToken = true;
      tokenHadEq = true;
      inValue = true;
      atHeaderEnd = false;
      continue;
    }

    if (inValue) {
      atHeaderEnd = false;
      continue;
    }

    if (isNameCharacter(character)) {
      if (needsSeparator) {
        // `href="/"x` - fused with the value it follows; not a fresh name.
        return null;
      }
      pendingToken = true;
      atHeaderEnd = false;
      continue;
    }

    if (stack.length === 0) {
      // Bare notation: punctuation where a name belongs starts inline text.
      return null;
    }
    // Inside a wrapper the scanner stays permissive about punctuation it does not model.
    atHeaderEnd = false;
  }

  if (inValue || needsSeparator) {
    return null;
  }
  const top = stack[stack.length - 1];
  if (top === 'ruby') {
    return null;
  }

  let syntax: AttributeSyntax;
  if (top === 'wrapper') {
    syntax = 'wrappedAttributes';
  } else {
    if (!sawBareSeparator) {
      // The cursor is still inside the tag header, where completionWord owns the word.
      return null;
    }
    syntax = 'htmlAttributes';
  }

  let start = linePrefix.length;
  while (start > 0 && isNameCharacter(linePrefix[start - 1])) {
    start--;
  }
  return { syntax, identifierLength: linePrefix.length - start };
}
