# Change Log

All notable changes to the "Slim" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.1]: https://github.com/cadenza-tech/slim/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/cadenza-tech/slim/releases/tag/v0.0.0
