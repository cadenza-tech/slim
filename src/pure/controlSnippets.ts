// The Slim control-flow snippets, supplied by the completion provider. Pure; no vscode imports.
//
// They used to be contributed through snippets/slim.code-snippets, where they could not work after
// the marker they are written with. A contributed snippet replaces nothing but the word matching its
// prefix, so accepting `if` after a `- ` already typed wrote `- - if condition`; and once the line
// had been highlighted VS Code read the position as embedded Ruby and did not offer the Slim set
// there at all. The provider is asked by the document's language whatever the position is
// highlighted as, and src/pure/completionWord.ts puts the marker inside the range it replaces.
//
// Seven of the bodies - if, else, elsif, unless, each, yield and content_for - derive from
// haml-vscode by Karuna Murti (MIT), which is why src/pure/railsSnippetsUpstream.ts leaves those
// seven prefixes out. See syntaxes/NOTICE.md.

import type { ProvidedSnippet } from '../types';

export const CONTROL_SNIPPETS: readonly ProvidedSnippet[] = [
  { prefix: 'if', body: '- if ${1:condition}\n  $2', detail: 'Slim control code: if' },
  { prefix: 'ifelse', body: '- if ${1:condition}\n  $2\n- else\n  $3', detail: 'Slim control code: if/else' },
  { prefix: 'elsif', body: '- elsif ${1:condition}\n  $2', detail: 'Slim control code: elsif' },
  { prefix: 'else', body: '- else\n  $1', detail: 'Slim control code: else' },
  { prefix: 'unless', body: '- unless ${1:condition}\n  $2', detail: 'Slim control code: unless' },
  { prefix: 'each', body: '- ${1:collection}.each do |${2:item}|\n  $3', detail: 'Slim control code: each block' },
  {
    prefix: 'eachwi',
    body: '- ${1:collection}.each_with_index do |${2:item}, ${3:index}|\n  $4',
    detail: 'Slim control code: each_with_index block'
  },
  { prefix: 'case', body: '- case ${1:subject}\n- when ${2:value}\n  $3\n- else\n  $4', detail: 'Slim control code: case/when/else' },
  { prefix: 'when', body: '- when ${1:value}\n  $2', detail: 'Slim control code: when' },
  { prefix: 'while', body: '- while ${1:condition}\n  $2', detail: 'Slim control code: while' },
  { prefix: 'until', body: '- until ${1:condition}\n  $2', detail: 'Slim control code: until' },
  { prefix: 'begin', body: '- begin\n  $1\n- rescue ${2:StandardError} => ${3:e}\n  $4', detail: 'Slim control code: begin/rescue' },
  { prefix: 'do', body: '- ${1:expression} do |${2:arg}|\n  $3', detail: 'Slim control code: do block' },
  { prefix: 'yield', body: '= yield ${1::section}', detail: 'Slim output code: yield' },
  { prefix: 'content_for', body: '- content_for ${1::section} do\n  $2', detail: 'Slim control code: content_for block' }
];

/**
 * The control snippets the typed word can still become.
 *
 * Answering with all fifteen and leaving VS Code to filter them would be simpler and wrong: once a
 * provider has returned any item at all, VS Code stops asking the providers ranked below it, the
 * word-based one among them, so every tag typed at a line start - `sect`, `nav` - would lose its
 * suggestions to a list that could never show anything.
 *
 * A prefix match is deliberately narrower than the subsequence match VS Code gives a contributed
 * snippet: `se` is a subsequence of `else` and of `case`, and matching it would take the suggestions
 * away from `section` for a keystroke. The cost is a request made in the middle of a word - `cf`
 * then Ctrl+Space - which no longer finds `content_for`; typing from the first letter still does,
 * since VS Code narrows the list it already holds. Case is ignored, as it is for any snippet.
 */
export function controlSnippetsFor(identifier: string): readonly ProvidedSnippet[] {
  const typed = identifier.toLowerCase();
  return CONTROL_SNIPPETS.filter((snippet) => snippet.prefix.startsWith(typed));
}
