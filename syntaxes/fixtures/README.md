# Grammar regression tests

`yarn test:grammar` runs `vscode-tmgrammar-snap` over `*.slim` in this directory and compares the
result against the committed `*.slim.snap` files. Run `yarn test:grammar:update` to accept
intentional changes, and read the diff before committing it.

## Why `grammar-test.config.json` and `stubs/` exist

`vscode-tmgrammar-snap` resolves `include:` targets through a `contributes.grammars` registry, and
**vscode-textmate silently drops an entire pattern when its include target is not registered** — not
just the include. The Slim grammar's filter patterns all include an external grammar
(`source.ruby`, `source.css`, …), so running the snapshots against the extension's own
`package.json` produces output where every `ruby:` / `css:` / `javascript:` / `markdown:`
region is unscoped. That looks exactly like a broken grammar, but it is an artifact of the harness.

`stubs/` holds near-empty grammars that claim those scope names, and
`grammar-test.config.json` registers them alongside the real Slim grammar. This keeps the filter
region boundaries — which this extension owns — under test, without vendoring third-party
Ruby/CSS/JavaScript grammars.

**Only a scope that stock VS Code registers may be stubbed.** A stub for anything else keeps a rule
alive here that every real editor drops: `source.sass` and `text.html.erb` were stubbed once, so the
`sass:` and `erb:` regions stayed green while an editor without those extensions read `sass` and
`erb` as tag names. `src/test/pure/manifest.test.ts` holds the list, and fails on a stub outside it.

The stubs tokenize nothing a real template holds, so the snapshots assert where each filter region
starts and ends, not how its contents are tokenized. Highlighting *inside* a filter comes from the real
embedded grammar at runtime and has to be checked by hand in the Extension Development Host
(`Developer: Inspect Editor Tokens and Scopes`).

The stubs a filter includes do carry one rule, which opens on `LEFT_OPEN_BY_THE_STUB` and never
finds its end. It stands for whatever a real grammar leaves open across lines - a block comment, a
template literal, a `{`. The other fixtures pin where a region ends when nothing inside it is open;
this one pins that it ends *anyway*, which is the whole difference between `while` and `end`: an
open construct sits above the filter on the rule stack, and a filter bounded by `end` is never asked
again. `filter-leak.slim` and `text-block-leak.slim` are the only fixtures that hold the word. The
text block leaves something open a second way, needing no stub at all: an unterminated `#{` opens a
region of the interpolation injection, which is this repository's own grammar.
