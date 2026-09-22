# Change Log

All notable changes to the "Slim" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-09-23

### Changed

- The extension is now called `Slim Language Support`. The Visual Studio Marketplace requires a display name that no other extension has taken, and `Slim` was taken, so `1.0.1` could not be published there.

## [1.0.1] - 2026-09-23

### Changed

- The extension id is now `cadenza-tech.vscode-slim`. The Visual Studio Marketplace requires an extension name that no other publisher has taken, and `slim` was taken, so `1.0.0` could not be published there. An installation of the old `cadenza-tech.slim` from Open VSX does not update to the new id and has to be replaced.

## [1.0.0] - 2026-09-23

### Changed

- Completion: a partial name is now always inserted relative to `app/views`, also for a partial beside the current file, since a bare name only resolves from a view in the rendering controller's own directory; the partials beside the current file are still listed first
- Refactoring: `Slim: Wrap in Conditional`, `Slim: Wrap in Block` and `Slim: Split to Partial` now decline, with a message, a selection whose lines mix tabs and spaces for indentation, since no re-indentation keeps such lines at the same relative depth
- Snippets: the Slim control-flow snippets (`if`, `ifelse`, `each`, `case`, ...) are now supplied by the completion provider instead of the contributed snippet file, so accepting one after a `- ` already typed no longer writes `- - if`, they are offered on a line VS Code already highlights as Ruby, and they stay out of filter and text bodies; like the Rails set they no longer appear in **Insert Snippet**, do not expand with `editor.tabCompletion`, and are matched from the start of the word

### Fixed

- Code action: a linter name in a slim-lint report that is not a Ruby class name is no longer written into the document by the disable quick fix
- Code action: the `/ slim-lint:disable` pair is now written around the text block, filter, tag with inline text, open attribute wrapper or continued Ruby line that consumes the offending line, instead of into it, where the comment was rendered into the page or broke the expression apart; the block it covers is measured in columns, as Slim counts a tab
- Completion: `data-*` attribute names are no longer offered after `doctype`
- Completion: `data-*` attribute names are no longer offered inside a value written with spaces around its `=`, as in `a href = "/x"` or `a(href = "/x")`
- Completion: `data-*` attribute names are now offered past a whitespace modifier, as in `a> href=` or `a<>(`
- Completion: a partial name still being typed, as in `render 'sha, locals: { post: @post }`, now ends where the name ends, so accepting a suggestion no longer replaces the rest of the call; a name holding an interpolation with a comma in it, as in `"cards/#{kind.tr('-', '_')}"`, is kept whole
- Diagnostics: a line led by a no-break space or an ideographic space, which Slim renders as content, is no longer read as indented by it, so its diagnostic starts at that character and a disable comment written for it is not indented by it
- Diagnostics: a lint run abandoned by switching `slim.lint.run` off, or by changing the document's language mode, could clear the diagnostics a later run had published
- Diagnostics: an offense slim-lint reports twice on one line, which its RuboCop linter does when a cop fires twice there, is shown once
- Diagnostics: when a run forced by `Slim: Lint File`, `Slim: Restart Linter` or a settings change published nothing, the next save could reuse the report produced under the old settings instead of running slim-lint again
- Grammar: `#{` still being typed no longer colours the rest of the file as Ruby; an interpolation ends with the line it is written on
- Grammar: a `|` or `'` text block, a line of inline HTML or a filter body with something left open while typing - an HTML tag, a `#{`, a `/*`, a template literal, the `{` of a CSS rule - no longer colours the rest of the file, and the line after a `markdown:` body is no longer taken for one of its paragraphs
- Grammar: a Ruby line ending in a comma or a backslash followed by trailing whitespace now continues onto the next line, as Slim reads it, and a Ruby comment followed by trailing spaces no longer takes the rest of the file for Ruby
- Grammar: the `erb:` and `sass:` filters were dropped by stock VS Code, which registers neither grammar they included, so their headers were read as tags named `erb` and `sass`; `erb:` now highlights the Ruby inside `<% %>` on its own, and `sass:` keeps its region, coloured inside when a Sass extension is installed
- Indentation: pressing Enter after a tag whose whitespace modifier sits before its attributes, as in `a> href="/"`, now indents the next line
- Indentation: pressing Enter after a void element such as `img`, `br`, `input` or `meta` no longer indents the next line
- Indentation: pressing Enter on a line of many brackets no longer stalls the editor in the indentation rule
- Linting: a cancelled run whose slim-lint process was slow to exit could be recorded as a timeout, pausing automatic linting of that document although no run had timed out
- Linting: off Windows, a timed-out or cancelled run now takes slim-lint down together with a `slim.slimLint.executablePath` wrapper that does not `exec`, such as a docker script, instead of leaving it running and holding a lint slot for as long as it lived
- Linting: on Windows, a `slim.slimLint.executablePath` written with forward slashes, such as `C:/Ruby/bin/slim-lint.bat`, ran `C:` instead
- Linting: on Windows, a command that already carries its extension, such as `slim-lint.bat`, is found on `PATH` as it stands, the extensionless `slim-lint` script RubyInstaller places beside it is no longer taken for it, and a `PATH` entry naming no drive, such as `\tools`, is skipped
- Linting: relative `PATH` entries such as `./bin` are skipped when resolving `slim-lint`, since what they find is probed from the extension host's directory but spawned from the one owning `.slim-lint.yml`
- Linting: the output channel now shows what slim-lint wrote to stdout when it exits with an error, which is where its logger sends the sentence explaining a bad configuration, a rejected flag or a crash
- Navigation: Go to Definition and completion for a `render` call written after an output marker carrying a whitespace modifier, such as `=>` or `='`, now work
- Refactoring: a `/` code comment between a branch and the line it answers to, which the disable quick fix writes, no longer stops a selection from reaching the opener or the next branch
- Refactoring: a selection starting on `- else`, `- elsif`, `- when`, `- rescue` or `- ensure` now reaches back to the `- if`, `- case` or `- begin` that opens it, and one starting on the opener takes every branch written at its indent, so a wrap or a split no longer separates a branch from its statement
- Refactoring: a selection's nesting is measured in columns, with a tab reaching the next multiple of four as Slim counts it, so a file mixing tabs and spaces is read the way it renders
- Setting: `slim.lint.exclude` globs are now matched against the path relative to the workspace folder as well as the absolute path, so `vendor/**` skips what only `**/vendor/**` used to, and its entries are trimmed like those of the other path settings
- Snippets: `button_block`, `f.button_block`, `select`, `stylesheet_link_tag` and `tag.div_block` inserted Ruby with a comma missing, doubled or leading, and `collection_radio_buttons`, `collection_radio_buttons_block` and `mail_to_block` were labelled after another helper

## [0.0.1] - 2026-07-28

### Changed

- Changes to `.slim-lint.yml`, `.rubocop.yml` and `Gemfile.lock` now share one debounced re-lint, so a branch switch re-lints open files once instead of once per file event
- `slim.slimLint.executablePath` now resolves a bare command name on `PATH` and refuses a relative path, which spawn would have resolved against the linted document's directory

## [0.0.0] - 2026-07-27

### Added

- Code action: disable a slim-lint linter for a block with `/ slim-lint:disable` comments
- Command: `Slim: Lint File`
- Command: `Slim: Restart Linter`
- Command: `Slim: Show Output Channel`
- Command: `Slim: Split to Partial`
- Command: `Slim: Wrap in Block`
- Command: `Slim: Wrap in Conditional`
- Completion: `data-*` attributes from Turbo, Stimulus and Rails UJS, both bare after the tag and inside `()` / `[]` / `{}` wrappers
- Completion: partial names inside a `render` call
- Diagnostics: paused for a file a slim-lint run timed out on, until it gets smaller, `slim.slimLint.timeoutMs` is raised, or a command asks for it
- Diagnostics: re-run for open files when `.slim-lint.yml` or `.rubocop.yml` changes
- Diagnostics: slim-lint offenses, with each linter name linking to its documentation
- Documentation: how to turn Emmet off for Slim alone, which restores VS Code's word-based completion
- Grammar: `#{...}` interpolation is highlighted as Ruby everywhere, including inside filters, with `\#{}` left alone
- Grammar: `doctype` lines, `/!` HTML comments and `/[if ...]` conditional comments, which the upstream grammar did not distinguish from the `/` code comment
- Grammar: multi-line Ruby continued with a trailing comma or a trailing backslash
- Grammar: the `='` and `=='` output markers with their whitespace modifiers
- Highlighting: Slim syntax with embedded Ruby, JavaScript, CSS, Sass, SCSS, Less, CoffeeScript, Markdown, ERB and YAML
- Linting: automatic `bundle exec` detection from `Gemfile.lock`, with a fallback to the `slim-lint` on `PATH`
- Navigation: Go to Definition for the partial a `render` call names, resolved the way Rails resolves it
- Setting: `slim.lint.debounceMs` to debounce linting while typing
- Setting: `slim.lint.exclude` to skip files, since slim-lint's own `exclude:` does not apply to stdin
- Setting: `slim.lint.run` to choose when diagnostics run
- Setting: `slim.slimLint.configPath` to pass a configuration file to slim-lint
- Setting: `slim.slimLint.executablePath` to override the slim-lint executable
- Setting: `slim.slimLint.timeoutMs` to bound how long a slim-lint process may run
- Setting: `slim.slimLint.useBundler` to control `bundle exec` detection
- Setting: `slim.snippets.rails` to offer Rails view helper snippets, defaulting to automatic detection
- Snippets: 239 Rails view helper snippets, offered only when the file belongs to a Rails project
- Snippets: Slim control flow, filters, doctypes and comments

[1.0.2]: https://github.com/cadenza-tech/slim/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/cadenza-tech/slim/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cadenza-tech/slim/compare/v0.0.1...v1.0.0
[0.0.1]: https://github.com/cadenza-tech/slim/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/cadenza-tech/slim/releases/tag/v0.0.0
