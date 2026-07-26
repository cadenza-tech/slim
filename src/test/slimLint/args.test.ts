import * as assert from 'node:assert';
import { buildLintArgs } from '../../slimLint/args';

suite('slimLint/args Test Suite', () => {
  suite('buildLintArgs', () => {
    test('should request the json reporter and pipe the given path', () => {
      assert.deepStrictEqual(buildLintArgs({ stdinPath: '/w/a.slim' }), ['--reporter', 'json', '--stdin-file-path', '/w/a.slim']);
    });

    test('should pass configPath through as -c', () => {
      assert.deepStrictEqual(buildLintArgs({ stdinPath: '/w/a.slim', configPath: '/w/.slim-lint.yml' }), [
        '--reporter',
        'json',
        '-c',
        '/w/.slim-lint.yml',
        '--stdin-file-path',
        '/w/a.slim'
      ]);
    });

    test('should omit -c for null, undefined and empty configPath', () => {
      for (const configPath of [null, undefined, '']) {
        assert.ok(!buildLintArgs({ stdinPath: '/w/a.slim', configPath }).includes('-c'), `configPath=${String(configPath)}`);
      }
    });

    test('should never autocorrect', () => {
      const args = buildLintArgs({ stdinPath: '/w/a.slim' });
      assert.ok(!args.includes('-a'));
      assert.ok(!args.includes('-A'));
    });

    test('should place the stdin path last so it is never read as another flag value', () => {
      const args = buildLintArgs({ stdinPath: '/w/a.slim', configPath: '/w/c.yml' });
      assert.strictEqual(args[args.length - 1], '/w/a.slim');
      assert.strictEqual(args[args.length - 2], '--stdin-file-path');
    });
  });
});
