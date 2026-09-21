import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_KEYS,
  LINT_RUN_VALUES,
  MAX_DEBOUNCE_MS,
  MAX_TIMEOUT_MS,
  MIN_DEBOUNCE_MS,
  MIN_TIMEOUT_MS,
  normalizeConfig,
  RAILS_SNIPPETS_VALUES,
  USE_BUNDLER_VALUES
} from '../../configSchema';
import type { SlimConfig } from '../../types';

// The manifest is a second source of truth for things the source already decides, and every one of
// these disagreements is silent: nothing fails, the user just gets behaviour the settings UI does
// not describe. Read with fs rather than imported, because resolveJsonModule is unset and rootDir
// would put the JSON somewhere out/ does not expect.
const ROOT = path.join(__dirname, '..', '..', '..');

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), 'utf8')) as Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: the manifest is untyped JSON; every read is asserted.
const manifest = readJson('package.json') as any;
const defaults = normalizeConfig({});

function property(id: string): Record<string, unknown> {
  const found = manifest.contributes.configuration.properties[id];
  assert.ok(found !== undefined, `package.json declares no ${id}`);
  return found;
}

suite('package.json manifest Test Suite', () => {
  suite('settings', () => {
    // The pair whose disagreement is both silent and user-visible: VS Code clamps settings.json to
    // the JSON schema and configSchema clamps independently to its own constants, so a mismatch
    // means a value the settings UI accepts and the extension quietly rejects.
    test('should declare the same default as normalizeConfig produces', () => {
      for (const [field, key] of Object.entries(CONFIG_KEYS)) {
        assert.deepStrictEqual(property(`slim.${key}`).default, defaults[field as keyof SlimConfig], `slim.${key}`);
      }
    });

    test('should declare the same bounds as configSchema clamps to', () => {
      assert.strictEqual(property('slim.lint.debounceMs').minimum, MIN_DEBOUNCE_MS);
      assert.strictEqual(property('slim.lint.debounceMs').maximum, MAX_DEBOUNCE_MS);
      assert.strictEqual(property('slim.slimLint.timeoutMs').minimum, MIN_TIMEOUT_MS);
      assert.strictEqual(property('slim.slimLint.timeoutMs').maximum, MAX_TIMEOUT_MS);
    });

    test('should declare exactly the settings the extension reads', () => {
      const declared = Object.keys(manifest.contributes.configuration.properties).sort();
      const read = Object.values(CONFIG_KEYS)
        .map((key) => `slim.${key}`)
        .sort();
      assert.deepStrictEqual(declared, read);
    });

    test('should offer exactly the enum values configSchema accepts', () => {
      for (const [key, values] of [
        ['lint.run', LINT_RUN_VALUES],
        ['slimLint.useBundler', USE_BUNDLER_VALUES],
        ['snippets.rails', RAILS_SNIPPETS_VALUES]
      ] as const) {
        assert.deepStrictEqual(property(`slim.${key}`).enum, [...values], `slim.${key}`);
      }
    });

    // Parallel arrays: adding a value and forgetting its description shifts every description by
    // one, so the UI silently mislabels every choice rather than showing a gap.
    test('should describe every enum value exactly once', () => {
      for (const id of Object.keys(manifest.contributes.configuration.properties)) {
        const declared = property(id);
        if (declared.enum === undefined) {
          continue;
        }
        assert.strictEqual((declared.enum as unknown[]).length, (declared.enumDescriptions as unknown[]).length, id);
      }
    });

    test('should restrict only settings that exist', () => {
      const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
      for (const id of manifest.capabilities.untrustedWorkspaces.restrictedConfigurations) {
        assert.ok(declared.has(id), `${id} is restricted but not declared`);
      }
    });
  });

  suite('commands', () => {
    // At the 1.57 floor activationEvents is not generated, so a missing entry means the command
    // silently does nothing until the extension happens to already be active.
    test('should have an activation event for every command and vice versa', () => {
      const commands = manifest.contributes.commands.map((command: { command: string }) => command.command).sort();
      const activated = manifest.activationEvents
        .filter((event: string) => event.startsWith('onCommand:'))
        .map((event: string) => event.slice('onCommand:'.length))
        .sort();
      assert.deepStrictEqual(activated, commands);
    });

    test('should only put declared commands in the palette', () => {
      const commands = new Set(manifest.contributes.commands.map((command: { command: string }) => command.command));
      for (const entry of manifest.contributes.menus.commandPalette) {
        assert.ok(commands.has(entry.command), `${entry.command} is in the palette but not declared`);
      }
    });
  });

  suite('grammars', () => {
    // A scope renamed during a vendor update leaves a dead embeddedLanguages entry, and the embedded
    // language silently stops being highlighted. The grammar snapshots do not look at this mapping.
    test('should map only scopes the grammar actually produces', () => {
      const grammar = readJson('syntaxes', 'slim.tmLanguage.json');
      const scopes = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node) {
            walk(child);
          }
          return;
        }
        if (typeof node !== 'object' || node === null) {
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          if ((key === 'name' || key === 'contentName') && typeof value === 'string') {
            for (const scope of value.split(' ')) {
              scopes.add(scope);
            }
          }
          walk(value);
        }
      };
      walk(grammar);

      for (const scope of Object.keys(manifest.contributes.grammars[0].embeddedLanguages)) {
        assert.ok(scopes.has(scope), `${scope} is mapped to an embedded language but the grammar never produces it`);
      }
    });

    // vscode-textmate silently drops an entire pattern when its include target is not registered,
    // so a grammar added without a stub makes the snapshots look unscoped rather than fail.
    test('should register every contributed grammar with the snapshot harness', () => {
      const harness = readJson('syntaxes', 'fixtures', 'grammar-test.config.json') as {
        contributes: { grammars: { scopeName: string }[] };
      };
      const registered = new Set(harness.contributes.grammars.map((grammar) => grammar.scopeName));
      for (const grammar of manifest.contributes.grammars) {
        assert.ok(registered.has(grammar.scopeName), `${grammar.scopeName} is contributed but has no entry in grammar-test.config.json`);
      }
    });

    /**
     * The scopes the extensions built into VS Code register, of those this grammar includes. Each one
     * is a claim that was checked against the `contributes.grammars` of those extensions; source.sass
     * and text.html.erb are absent because only third-party extensions have them.
     */
    const STOCK_SCOPES = [
      'source.coffee',
      'source.css',
      'source.css.less',
      'source.css.scss',
      'source.js',
      'source.ruby',
      'source.yaml',
      'text.html.basic',
      'text.html.markdown'
    ];

    // The other direction of the same trap. A stub for a scope stock VS Code does not register keeps
    // a rule alive in the snapshots that every real editor drops - which is how the `sass:` and `erb:`
    // regions stayed green while an editor without those extensions read their headers as tag names.
    test('should stub only the scopes stock VS Code registers', () => {
      const harness = readJson('syntaxes', 'fixtures', 'grammar-test.config.json') as {
        contributes: { grammars: { scopeName: string }[] };
      };
      const contributed = new Set(manifest.contributes.grammars.map((grammar: { scopeName: string }) => grammar.scopeName));
      const stubbed = harness.contributes.grammars.map((grammar) => grammar.scopeName).filter((scope) => !contributed.has(scope));
      assert.deepStrictEqual(stubbed.sort(), STOCK_SCOPES);
    });

    // vscode-textmate drops a begin/end rule whose every pattern includes a grammar that is not
    // registered, and with it the region: the body is then read as Slim, and an `erb:` body's `%>`
    // opens a Ruby %-literal that runs to the end of the file. A rule survives on one pattern that
    // needs nothing from outside.
    test('should keep every filter rule alive without third-party grammars', () => {
      const grammar = readJson('syntaxes', 'slim.tmLanguage.json') as { patterns: { begin?: string; patterns?: { include?: string }[] }[] };
      const stock = new Set(STOCK_SCOPES);
      for (const rule of grammar.patterns) {
        if (rule.begin === undefined || rule.patterns === undefined) {
          continue;
        }
        const survives = rule.patterns.some(
          (pattern) => pattern.include === undefined || pattern.include.startsWith('#') || stock.has(pattern.include)
        );
        assert.ok(survives, `the rule beginning ${rule.begin} has only third-party includes and vanishes in stock VS Code`);
      }
    });

    /**
     * An `end` is only tried while its own rule is on top of the rule stack. A construct another
     * grammar leaves open - a `/*`, a template literal, a `#{` still being typed - sits above it, so
     * the region never ends and the rest of the file is coloured as that construct. `while` is asked
     * of every line whatever is open, and pops it all.
     *
     * Which is why this asks about the rules that hand their body to other patterns. The `/` and
     * `/!` comments keep an `end`: they hold no patterns, and the one thing that reaches into them
     * anyway - the interpolation injection - is excluded from them by its selector, which the next
     * test pins.
     */
    test('should bound an indented body by while wherever something can be left open in it', () => {
      const grammar = readJson('syntaxes', 'slim.tmLanguage.json') as {
        patterns: { begin?: string; end?: string; while?: string; patterns?: unknown[] }[];
      };
      const indented = grammar.patterns.filter((rule) => rule.begin?.startsWith('^(\\s*)') === true && rule.patterns !== undefined);
      // The nine filters and the text block. A rule written with another prefix would be missed, so
      // the count says which rules the assertions below were actually made about.
      assert.strictEqual(indented.length, 10, 'the grammar has changed shape');
      for (const rule of indented) {
        assert.strictEqual(rule.end, undefined, `the rule beginning ${rule.begin} ends on a pattern`);
        assert.strictEqual(rule.while, '^(?=\\1\\s|\\s*$)', `the rule beginning ${rule.begin}`);
      }
    });

    /**
     * A line of HTML is one line of Slim, and the HTML grammar can leave a tag open across lines,
     * so this rule needs the same treatment with a `while` that can never match: it is asked at the
     * start of the next line, fails, and pops the rule and whatever the HTML grammar stacked on it.
     *
     * The neighbouring single-line rules keep their `end` deliberately. `^\s*(?=-)` and `(?==+)`
     * hold `rubyline`, which is meant to span lines when the Ruby ends in a comma or a backslash;
     * bounding them to one line was measured to break exactly that.
     */
    test('should bound a line of HTML to that line', () => {
      const grammar = readJson('syntaxes', 'slim.tmLanguage.json') as { patterns: { begin?: string; end?: string; while?: string }[] };
      const html = grammar.patterns.filter((rule) => rule.begin === '(?=<[\\w\\d\\:]+)');
      assert.strictEqual(html.length, 1, 'the grammar has changed shape');
      assert.strictEqual(html[0]?.end, undefined, 'the HTML line rule ends on a pattern');
      assert.strictEqual(html[0]?.while, '(?!)');
    });

    // An injection applies at every level of the scope stack, so it reaches inside a rule that has
    // no patterns of its own. Without `-comment` an unterminated `#{` under `/` or `/!` opens a
    // Ruby region that outlives the comment and colours the rest of the file.
    test('should keep the interpolation injection out of comments', () => {
      const injection = readJson('syntaxes', 'slim-interpolation.injection.json') as { injectionSelector: string };
      assert.ok(
        injection.injectionSelector.split(/\s+/).includes('-comment'),
        `the selector ${injection.injectionSelector} no longer excludes comments, which are bounded by end`
      );
    });
  });

  // Replaces the inline node -e in .github/workflows/lint.yml, which hardcoded the version string.
  test('should pin @types/vscode to the engines.vscode floor', () => {
    const engine = manifest.engines.vscode as string;
    const floor = engine
      .replace(/^[^0-9]*/, '')
      .split('.')
      .slice(0, 2)
      .join('.');
    const types = readJson('node_modules', '@types', 'vscode', 'package.json').version as string;
    assert.ok(types.startsWith(`${floor}.`), `@types/vscode is ${types}, expected ${floor}.x to match engines.vscode ${engine}`);
  });
});
