<p align="center">
  <img src="https://raw.githubusercontent.com/cadenza-tech/slim/refs/heads/main/images/icon.png" alt="Slim" width="128" height="128">
  <h1 align="center">Slim</h1>
</p>

<p align="center">
  Slim language support with syntax highlighting, snippets, and linting powered by slim-lint.
</p>

<p align="center">
  <a href="https://github.com/cadenza-tech/slim/blob/main/LICENSE.txt"><img src="https://img.shields.io/github/license/cadenza-tech/slim?label=License&labelColor=343B42&color=blue" alt="License"></a>
  <a href="https://github.com/cadenza-tech/slim/blob/main/CHANGELOG.md"><img src="https://img.shields.io/github/tag/cadenza-tech/slim?label=Tag&logo=github&labelColor=343B42&color=2EBC4F" alt="Tag"></a>
  <a href="https://github.com/cadenza-tech/slim/actions?query=workflow%3Atest"><img src="https://github.com/cadenza-tech/slim/actions/workflows/test.yml/badge.svg" alt="Test"></a>
  <a href="https://github.com/cadenza-tech/slim/actions?query=workflow%3Alint"><img src="https://github.com/cadenza-tech/slim/actions/workflows/lint.yml/badge.svg" alt="Lint"></a>
</p>

---

## Features

- Syntax highlighting for `.slim`, including the `ruby:`, `javascript:`, `css:`, `sass:`, `scss:`, `less:`, `coffee:`, `markdown:` and `erb:` filters, `---` YAML front matter, and verbatim text
- Multi-line Ruby, continued with a trailing comma or a trailing backslash
- `#{...}` interpolation highlighted as Ruby wherever it appears, including inside filters
- Diagnostics from [slim-lint](https://github.com/sds/slim-lint), with each linter name linking to its documentation
- Quick Fixes to disable a linter for a block with `/ slim-lint:disable` comments
- Go to Definition and completion for the partial a `render` call names, resolved the way Rails resolves it
- Selection refactorings: wrap in a conditional or a Ruby block, and extract to a new partial
- Completion for the `data-*` attributes Turbo, Stimulus and Rails UJS define, both bare after the tag and inside `()` / `[]` / `{}` wrappers
- Snippets for Slim control flow, filters, doctypes and comments
- 239 Rails view helper snippets (`link_to`, `form_with`, `f.text_field`, `turbo_frame_tag`, ...), offered only when the file belongs to a Rails project
- Automatic `bundle exec` detection, with a fallback to the `slim-lint` on your `PATH`
- No telemetry and no network requests

## Requirements

Syntax highlighting and snippets work on their own. Diagnostics need [slim-lint](https://github.com/sds/slim-lint):

```sh
gem install slim_lint
```

or add it to your `Gemfile`:

```ruby
gem 'slim_lint', require: false
```

slim-lint 0.22.0 or newer is required: 0.21.0 introduced `--stdin-file-path`, the flag this extension lints your unsaved buffer through, and 0.22.0 the inline `slim-lint:disable` comments the Quick Fixes write.

## No formatter

This extension deliberately registers no formatter: slim-lint has no auto-correct of any kind, so there is nothing that could format a Slim file without inventing a rewriter of its own — and a formatter that guesses is worse than none. If slim-lint grows an auto-correct, a formatter belongs here too.

The disable-comment Quick Fixes need no subprocess and work today.

## Completion and Emmet

VS Code's built-in Emmet counts Slim among the languages it handles, so it is active in `.slim` files whether or not you want it there. Its suggestions crowd out the word-based suggestions VS Code would otherwise offer from the current file.

If completion feels unhelpful, turn Emmet off for Slim alone:

```jsonc
"emmet.excludeLanguages": ["markdown", "slim"]
```

Two things to know:

- **Keep `"markdown"` in the list.** It is there by default, and because this setting is an array your value replaces the default rather than adding to it.
- **`emmet.showExpandedAbbreviation` cannot do this.** It is a window-scoped setting, so putting it under `"[slim]"` has no effect, and setting it to `"never"` globally would disable Emmet in HTML too. Its `"inMarkupAndStylesheetFilesOnly"` value does not help either: it only restricts Emmet to the languages it supports natively, and Slim is one of them.

This extension deliberately does not disable Emmet on your behalf, since plenty of people want it.

## Rails snippets

On top of the Slim snippets, 239 Rails view helper snippets are available: the full set from
[haml-vscode](https://github.com/karuna/haml-vscode) — whose `= helper` and `- ... do` bodies are
valid Slim exactly as they are — plus 18 helpers it predates, such as `form_with`,
`turbo_frame_tag`, `turbo_stream_from`, `dom_id`, `rich_text_area` and the `tag` builder. Typing
`= link` and accepting `link_to` gives you `= link_to(...)`, not `= = link_to(...)`, and `f.te`
completes to `f.text_field` rather than `f.f.text_field`.

They are off in a plain Slim project and on in a Rails one, with nothing to configure:

```jsonc
// Look for config/application.rb or a Gemfile.lock listing rails (default)
"slim.snippets.rails": "auto"

// Always offer them
"slim.snippets.rails": "on"

// Never offer them
"slim.snippets.rails": "off"
```

`auto` reads the workspace from disk, so it is always off for files that are not on the local
filesystem — a virtual workspace such as GitHub Repositories, a diff from the `git:` scheme, or an
untitled buffer. It is also off for a file opened on its own without a workspace folder, since there
is then no directory to search upwards from. Set `"on"` in those cases.

Two behaviours differ from the built-in Slim snippets, because a contributed snippet file cannot be
switched off by a setting and these are therefore supplied by a completion provider instead:

- they do not appear in the **Insert Snippet** command
- they do not expand with `editor.tabCompletion`

They are suggested as you type like any other snippet, and honour
`editor.snippetSuggestions: "none"`.

## Partials

`Ctrl` / `Cmd` click a partial name in a `render` call to open it, or use **Go to Definition** and
**Peek Definition**. Typing inside the quotes completes the names of the partials that exist. There is
nothing to configure and no Ruby process is involved — only file names are read, so both work in an
untrusted workspace too.

The name resolves the way Rails resolves it, against the `app/views` directory that contains the
current file:

| Written | Opens |
| - | - |
| `= render 'shared/foo'` | `app/views/shared/_foo.html.slim` |
| `= render 'sidebar'` | `_sidebar.html.slim` beside the current file, then `app/views/application/` |
| `= render partial: 'shared/foo'` | the same as the first form |
| `= render layout: 'shared/foo' do` | the same as the first form |

`.slim` is preferred over `.erb`, and the current file's own format over `html`: from
`index.turbo_stream.slim`, `= render 'shared/foo'` opens `_foo.turbo_stream.slim` when it exists and
falls back to `_foo.html.slim` when it does not.

`= render template: 'posts/index'` is deliberately not followed. A template resolves without the
leading underscore, so treating it as a partial would point at a file that is not there.

Completion offers a partial that sits beside the current file under its bare name, and everything else
under its `app/views`-relative name, which is what Rails needs in each case. Turn it off with:

```jsonc
"slim.completions.partials": false
```

## data attribute completion

Inside an attribute list, typing `data-` completes the attributes Turbo, Stimulus and Rails UJS
define, in both Slim notations:

```slim
a data-turbo-frame="modal" Open
div(data-controller="dropdown")
```

Attributes whose presence *is* the value — `data-turbo-permanent`, `data-turbo-stream` and the rest —
are inserted as `data-turbo-permanent=true` after the tag, where a bare name would read as inline
text, and as the bare boolean name inside a wrapper. Stimulus contributes only `data-controller` and
`data-action`: target, value and class names are per controller, so a placeholder for them would
never match what you type.

Nothing is read from disk and no process is started, so this works in an untrusted or virtual
workspace. Turn it off with:

```jsonc
"slim.completions.dataAttributes": false
```

## Syntax highlighting only

To get highlighting and snippets without ever starting a Ruby process:

```jsonc
"slim.lint.run": "off"
```

With that set, nothing is spawned when you open, edit or save a `.slim` file. The `Slim: Lint File` command still runs slim-lint, because invoking it explicitly is a deliberate request.

Rails snippets never spawn anything either, but `auto` does read `Gemfile.lock` from the workspace. Set `"slim.snippets.rails": "off"` to stop even that.

## Settings

| Setting | Default | Description |
| - | - | - |
| `slim.lint.run` | `onSave` | When to run diagnostics: `onSave` (also on open), `onType`, or `off`. |
| `slim.lint.debounceMs` | `500` | Debounce in milliseconds while typing. Only used when `slim.lint.run` is `onType`. |
| `slim.lint.exclude` | `[]` | Glob patterns of files to skip. See [Known Limitations](#known-limitations). |
| `slim.slimLint.executablePath` | `null` | Absolute path to the slim-lint executable, or a bare command name resolved on `PATH`; relative paths are refused. Skips bundler detection when set. |
| `slim.slimLint.useBundler` | `auto` | Whether to run through `bundle exec`: `auto`, `always`, or `never`. |
| `slim.slimLint.configPath` | `null` | Configuration file passed as `-c`. |
| `slim.slimLint.timeoutMs` | `15000` | How long to wait for a slim-lint process before terminating it. See [Known Limitations](#known-limitations). |
| `slim.snippets.rails` | `auto` | Whether to offer Rails view helper snippets: `auto`, `on`, or `off`. See [Rails snippets](#rails-snippets). |
| `slim.completions.partials` | `true` | Whether to complete partial names inside a `render` call. See [Partials](#partials). |
| `slim.completions.dataAttributes` | `true` | Whether to complete Turbo, Stimulus and Rails UJS `data-*` attributes. See [data attribute completion](#data-attribute-completion). |

`slim.slimLint.executablePath`, `slim.slimLint.useBundler` and `slim.slimLint.configPath` are machine-scoped, so a repository cannot point them at an arbitrary binary through its own `.vscode/settings.json`.

## Commands

| Command | Description |
| - | - |
| `Slim: Lint File` | Run slim-lint against the active file. |
| `Slim: Wrap in Conditional` | Wrap the selection in `- if`, with the condition selected so you can type over it. |
| `Slim: Wrap in Block` | Wrap the selection in a Ruby `each` block, with the collection selected. |
| `Slim: Split to Partial` | Move the selection into a new partial and replace it with `= render`. |
| `Slim: Restart Linter` | Drop every cached conclusion and re-lint open files. |
| `Slim: Show Output Channel` | Open the log, which records every command, its working directory, exit code and stderr. |

## Security

Linting a Slim file runs Ruby code from your workspace: `bundle exec` evaluates the `Gemfile`, and `.rubocop.yml` — which slim-lint's RuboCop linter reads — can `require` arbitrary `.rb` files. This extension therefore declares limited support for untrusted workspaces — in a workspace you have not trusted, syntax highlighting and snippets work, and no process is ever spawned.

## Known Limitations

- **`exclude:` in `.slim-lint.yml` is not applied.** Linting from the editor pipes the buffer through `--stdin-file-path`, which bypasses slim-lint's file finder — the stage that applies the top-level `exclude:` globs. Use `slim.lint.exclude` instead. Per-linter `include:` / `exclude:` are unaffected and still work.
- **Diagnostics cover a whole line.** slim-lint reports a line number and no column.
- **A file that times out is left alone until something changes.** Every run boots Ruby and RuboCop afresh, so once a run has exceeded `slim.slimLint.timeoutMs` on a document, saving it again would only spend the same time to be killed again. Automatic runs for that document are therefore paused until it gets smaller, `slim.slimLint.timeoutMs` is raised, or you run `Slim: Lint File` or `Slim: Restart Linter`. The output channel records it when it happens.
- **This extension never writes to your configuration files.**
- **Only `.slim-lint.yml` and `.rubocop.yml` are watched.** Changing either re-lints the Slim files you have open. A configuration reached some other way — a file named by `slim.slimLint.configPath`, or one pulled in by `inherits_from` — is still read on every run, but changing it does not refresh anything on its own until you edit a `.slim` file or run `Slim: Lint File`.
- **The `erb:` and `sass:` filter bodies are highlighted only when a matching extension is installed.** The grammar hands them to the `text.html.erb` and `source.sass` scopes, which no VS Code built-in registers; without an ERB or indented-Sass extension those bodies simply stay uncoloured. The other filters map to scopes the built-in grammars provide.
- **`Slim: Split to Partial` adds no `locals:`.** Instance variables carry over on their own, but a selection using a block variable needs the argument adding by hand — deriving them means parsing the Ruby in the selection, and getting that wrong would silently change what the view renders. It also never overwrites: if a partial of that name already exists the command stops, and it needs a file saved on disk, unlike the two wrap commands which work in an untitled buffer too.
- **A selection is interpreted by indentation alone.** With no selection the block under the cursor is used, and a selection whose last line still has children is extended to include them — otherwise raising it one level would detach them. Nothing understands filters, so wrapping the body of a `ruby:` or `javascript:` filter produces broken Ruby or JavaScript, and neither does anything understand multi-line Ruby, so a selection starting midway through a comma- or backslash-continued expression is not valid either.
- **Partials are resolved against one `app/views`.** The one containing the current file, which means an engine's or a dummy app's is used when the file lives there. `prepend_view_path` and an engine's view path chain would need the application to be booted, so they are not followed.
- **Attribute completion reads one line.** A wrapped attribute list spread over several lines cannot be judged from the line being typed, so nothing is offered there.
- **Partial completion needs a workspace folder.** File search always comes back empty without one, so a `.slim` file opened on its own gets Go to Definition but no completion. Multi-line `render partial:` calls are not covered either, since the name has to be on the line being typed.
- **`slim` language id conflicts.** Several extensions contribute the `slim` language and the `text.slim` grammar. If more than one is installed the result is whichever loads last, so installing only one is recommended.

## Contributing

Bug reports and pull requests are welcome on GitHub at https://github.com/cadenza-tech/slim. This project is intended to be a safe, welcoming space for collaboration, and contributors are expected to adhere to the [code of conduct](https://github.com/cadenza-tech/slim/blob/main/CODE_OF_CONDUCT.md).

## License

The extension is available as open source under the terms of the [MIT License](https://github.com/cadenza-tech/slim/blob/main/LICENSE.txt).

The bundled TextMate grammar is derived from [ruby-slim.tmbundle](https://github.com/slim-template/ruby-slim.tmbundle) by the Slim team, and the Rails snippet set from [haml-vscode](https://github.com/karuna/haml-vscode) by Karuna Murti — both MIT licensed. See [syntaxes/NOTICE.md](https://github.com/cadenza-tech/slim/blob/main/syntaxes/NOTICE.md) for the vendored commits and the list of modifications.

## Code of Conduct

Everyone interacting in the Slim project's codebases, issue trackers, chat rooms and mailing lists is expected to follow the [code of conduct](https://github.com/cadenza-tech/slim/blob/main/CODE_OF_CONDUCT.md).

## Sponsor

You can sponsor this project on [GitHub Sponsors](https://github.com/sponsors/cadenza-tech).
