# Third-Party Notices

## Slim TextMate grammar

`syntaxes/slim.tmLanguage.json` is derived from **ruby-slim.tmbundle** by the Slim team.

- Upstream: https://github.com/slim-template/ruby-slim.tmbundle
- Vendored commit: `cad02689b6c6e03d67dab8eaadb22cf0fd3b436b` (master, 2025-07-27)
- Upstream file: `Syntaxes/Ruby Slim.tmLanguage` (XML plist, converted with `plutil -convert json`)
- License: MIT

### Modifications

- Every `include: source.ruby.rails` (five sites: the three delimited-ruby rules, `embedded-ruby`,
  and `rubyline`) now includes `source.ruby`. VS Code registers no `source.ruby.rails` scope, and
  vscode-textmate silently drops a whole pattern whose include target is unregistered, so those
  regions would otherwise lose Ruby highlighting entirely.
- The `scss:` and `less:` filters include `source.css.scss` and `source.css.less`, the scope names
  VS Code's built-in grammars actually register, instead of upstream's `source.scss`/`source.less`.
- The `erb:` filter includes no external grammar. Upstream's `source.erb` is registered by no
  published grammar and `text.html.erb` by none of VS Code's built-ins, and vscode-textmate drops a
  rule whose every include is missing: the header was then read as a tag named `erb`, and the body
  as Slim - where the `=` of `<%= x %>` opens a Ruby line and Ruby reads the closing `%>` as the
  start of a `%`-literal that ran to the end of the file. With an ERB extension installed the rule
  survived, but an HTML tag or comment left open in the body ran past the end of the filter in the
  same way. The rule now hands only the inside of a `<% %>` tag to `source.ruby`, the shape the ERB
  grammar shipped with vscode-ruby and Ruby LSP has, with `# ...` matched as a comment first so
  that it cannot swallow the `%>` that closes the tag. It is written as `begin`/`while` instead of
  `begin`/`end`: a filter's `end` is only tried while the filter is on top of the rule stack, so a
  tag still missing its `%>` would otherwise take the rest of the file for Ruby. What it shares with
  the other filters is how the body is told from what follows - by the header's own leading
  whitespace plus one more character - so a body indented with tabs under a header indented with
  spaces is not recognised as one.
- Every filter is written as `begin`/`while` (`^(?=\1\s|\s*$)`) where upstream has `begin`/`end`
  (`^(?!(\1\s)|\s*$)`), for the reason given under `erb:` above. The two tell a body line from what
  follows it in the same way, and against the grammars VS Code ships every well-formed filter
  tokenizes the same either way - checked over 104 documents, eight filters in thirteen shapes.
  (Not the same *rule*, though: a zero-width `while` anchors `\G` at column 0 of every body line,
  where the `end` form leaves it unset. No `\G` rule in those grammars can reach the start of an
  indented line, but a third-party one that could would be a real difference.) What `end` could not
  do is end the region while the embedded grammar has something open - a `/*`, a template literal,
  a heredoc, or simply the `{` of a CSS rule still being typed - because a filter's `end` is only
  tried while the filter is on top of the rule stack; everything below it was then coloured as that
  construct to the end of the file. `while` is asked of every line whatever is open, and pops it
  all - which also takes back the line after a `markdown:` body, whose own paragraph rule used to
  claim the next, more shallowly indented Slim line as a continuation.
- The `sass:` filter carries a second pattern that can never match, `(?!)`, next to its
  `source.sass` include. `source.sass` comes from third-party extensions only, and without the
  extra pattern the rule is dropped in stock VS Code the same way: `sass` became a tag name and the
  body's selectors and properties Slim tags. With it the region is scoped either way, and
  highlighted inside when a Sass extension is installed.
- `syntaxes/fixtures/grammar-test.config.json` stubs only the scopes stock VS Code registers.
  Stubs for `source.sass` and `text.html.erb` were what kept the two rules above alive in the
  snapshots while every real editor dropped them; `src/test/pure/manifest.test.ts` pins both halves.
- A `doctype` rule was added (`meta.prolog.slim` / `keyword.other.doctype.slim`): upstream only
  scopes the legacy `! ` prolog.
- `/!` HTML comments and `/[if IE]` conditional comments were split out of the `/` code comment.
  Upstream's single rule swallowed both, but a conditional comment's children are rendered content:
  the new `/[...]` rule scopes only the header line, so children keep their normal scopes, while
  `/!` keeps the block behaviour with `comment.block.html.slim`.
- `rubyline`'s begin was `(==|=)(<>|><|<'|'<|<|>)?|-`, which misses the plain `'`
  trailing-whitespace modifier (`='`, `=='`). It is now `(==|=)([<>']{1,2})?|-`.
- The `(?==+|~)` root pattern dropped its `~` alternative; `~` has no meaning in Slim.

### Known upstream quirks, pinned by the snapshots

The snapshots under `syntaxes/fixtures/` assert the grammar as it is, including behaviour inherited
from upstream that a rewrite might improve but vendoring deliberately keeps:

- In `.card#first`, the leading `.card` is tokenized as tag punctuation plus
  `entity.other.attribute-name.event.slim` rather than as a class literal.
- A wrapped attribute list continued across lines (`a(href="..."` + newline + `title="...")`) is
  re-parsed from scratch on the continuation line: the second line's attribute is read as a tag
  head, because a begin/end pair cannot carry the wrapper state across lines in this grammar.
- A splat written as `*variable` (rather than `*{...}`) is not scoped; upstream's splat rule only
  matches the brace form.

## Interpolation injection

`syntaxes/slim-interpolation.injection.json` is original work, not vendored, but it exists to
correct the vendored grammar's behaviour inside filters: a filter hands its body to another grammar,
which then reads the `{` of `#{` as its own syntax. In JavaScript that opens an object literal, and
a quote inside the Ruby breaks the recovery, so every following line of the filter is mis-tokenized.
Adding the interpolation rule to the filter's own patterns does not work, because TextMate takes the
leftmost match on a line and the embedded grammar's rules start earlier; once its begin/end rules
are entered, the filter's patterns no longer apply inside them. An injection applies at every level
of the scope stack, which is why it is the right mechanism. Its selector excludes `text.ruby` (the
`ruby:` filter) and `source.ruby`, where `#{` is not interpolation, and its begin carries a
`(?<!\\)` lookbehind so the `\#{}` escape stays plain text.

### Upstream license (ruby-slim.tmbundle)

```
The MIT License

Copyright (c) 2014 Slim Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Rails snippets

`src/pure/railsSnippetsUpstream.ts` is derived from **haml-vscode** by Karuna Murti, and the seven
structural snippet bodies retained in `src/pure/controlSnippets.ts` (`if`, `else`, `elsif`,
`unless`, `each`, `yield`, `content_for`) originate there as well. Neither file is shipped as one:
esbuild bundles both into `dist/extension.js`, which is where the derived work lives in the
published extension.

- Upstream: https://github.com/karuna/haml-vscode
- Vendored commit: `504875f60bcd474f17762b2daf97680476135f79` (master, 2022-07-03)
- Upstream file: `snippets/snippets.json`
- License: MIT

### Modifications

- The upstream file contains 228 snippets, most of which are Rails view helpers (`link_to`,
  `url_for`, `audio_tag`, ...). `src/pure/railsSnippetsUpstream.ts` holds 221 of them. Prefixes and
  bodies are verbatim - `= helper` and `- ... do` lines are valid Slim as they are - apart from the
  container, which changed from a JSON object keyed by name to a TypeScript array, and seven
  repaired bodies. `fields_for` had `${:record_object}` with no tab stop number and
  `render_partial_collection` had `${7, layout: $8}` with a comma where a colon belongs, both of
  which VS Code's snippet parser rejects outright, so that upstream inserts their literal text.
  The other five inserted Ruby that is a syntax error as it stands: `video_tag` had
  `autobuf.fer:`, a stray dot in the `autobuffer:` keyword; `stylesheet_link_tag` had no comma
  between the source and `media:`; `button_block` and `f.button_block` opened their argument list
  with the comma of the optional hash, which is now parenthesized as in `time_tag_block`; and
  `select` had a comma before that placeholder as well as inside it. Three `detail` strings that
  named another helper were corrected: `mail_to_block`, `collection_radio_buttons` and
  `collection_radio_buttons_block`. The header of the file lists each change exactly, so that they
  can be reapplied after regenerating it. The seven structural snippets above are
  excluded so the two sets never offer the same prefix twice. The Rails set is offered through a
  CompletionItemProvider rather than `contributes.snippets`, because that contribution point takes
  only `language` and `path` and so cannot be turned off by a setting; `slim.snippets.rails`
  controls it, and defaults to detecting whether the workspace is a Rails project. The structural
  snippets go through the same provider, ungated, because only a provider can replace the `-` or
  `=` a body opens with when the user has already typed it.
- The 18 further helpers in `src/pure/railsSnippets.ts` (`form_with`, `turbo_frame_tag`, `dom_id`,
  ...) and `language-configuration.json` are original to this repository and are not covered by
  this notice.

### Upstream license (haml-vscode)

```
The MIT License (MIT)
=====================

Copyright © `2016` `Karuna Murti <karuna.murti at gmail dot com>`

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```
