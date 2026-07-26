import * as assert from 'node:assert';
import { failure, interpretResult, isSkip, looksLikeMissingGem, type RunFailureReason } from '../../slimLint/outcome';
import type { SpawnResult } from '../../slimLint/process';

const REPORT = JSON.stringify({ files: [{ path: 'a.slim', offenses: [{ severity: 'warning', message: 'm', location: { line: 3 } }] }] });

function finished(overrides: Partial<Extract<SpawnResult, { ok: true }>> = {}): SpawnResult {
  return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 1, ...overrides };
}

suite('slimLint/outcome Test Suite', () => {
  suite('isSkip', () => {
    // A skip is the extension's own decision, so it must not be reported as something going wrong.
    test('should classify our own decisions as skips', () => {
      for (const reason of ['untrusted', 'cancelled', 'not-eligible', 'timed-out-before'] as const) {
        assert.strictEqual(isSkip(reason), true, reason);
      }
    });

    test('should classify anything that actually went wrong as a failure', () => {
      for (const reason of ['enoent', 'timeout', 'overflow', 'spawn-error', 'exit', 'unparseable-report'] as const) {
        assert.strictEqual(isSkip(reason), false, reason);
      }
    });
  });

  suite('failure', () => {
    // kind is derived, never passed in, so the two can never disagree at a construction site.
    test('should derive kind from the reason', () => {
      const skipped = failure('cancelled');
      assert.strictEqual(skipped.ok === false && skipped.kind, 'skipped');
      const failed = failure('enoent');
      assert.strictEqual(failed.ok === false && failed.kind, 'failed');
    });

    test('should omit detail entirely when there is none', () => {
      const result = failure('cancelled');
      assert.ok(result.ok === false && !('detail' in result));
    });

    test('should carry the human sentence when there is one', () => {
      const result = failure('not-eligible', 'document is empty');
      assert.strictEqual(result.ok === false && result.detail, 'document is empty');
    });

    test('should carry the missing command when given one', () => {
      const result = failure('enoent', 'not found', '/usr/bin/slim-lint');
      assert.strictEqual(result.ok === false && result.command, '/usr/bin/slim-lint');
      const without = failure('enoent');
      assert.ok(without.ok === false && !('command' in without));
    });
  });

  suite('looksLikeMissingGem', () => {
    // "Could not find ..." is SpecSet's shape when the lockfile names the gem but it is not
    // installed; "bundler: command not found: ..." is CLI::Exec's exit-127 shape when the bundle
    // does not contain the gem at all, which `useBundler: "always"` can produce.
    test('should recognise the bundler messages', () => {
      for (const stderr of ['Could not find slim_lint-0.76.0', 'bundler: command not found: slim-lint', 'Bundler::GemNotFound']) {
        assert.strictEqual(looksLikeMissingGem(finished({ code: 1, stderr })), true, stderr);
      }
    });

    // CLI::Exec exits 127, which classifies as not-found rather than error. The PATH retry hangs off
    // this predicate, so keying it on 'error' alone would strand the code that actually occurs.
    test('should still recognise the bundler message at its own exit 127', () => {
      assert.strictEqual(looksLikeMissingGem(finished({ code: 127, stderr: 'bundler: command not found: slim-lint' })), true);
    });

    test('should not fire for a normal report exit', () => {
      assert.strictEqual(looksLikeMissingGem(finished({ code: 65, stderr: 'Could not find' })), false);
    });

    test('should not fire for a spawn that never finished', () => {
      assert.strictEqual(looksLikeMissingGem({ ok: false, reason: 'enoent', stderr: 'Could not find' }), false);
    });
  });

  suite('interpretResult', () => {
    test('should read the report from stdout', () => {
      const result = interpretResult(finished({ stdout: REPORT }));
      assert.ok(result.ok);
      assert.strictEqual(result.outcome.report?.offenses.length, 1);
    });

    test('should treat exit 65 as a report, not an error', () => {
      const result = interpretResult(finished({ code: 65, stdout: REPORT }));
      assert.ok(result.ok);
    });

    test('should report an error exit code as exit, carrying the classification as detail', () => {
      const result = interpretResult(finished({ code: 70, stdout: '' }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'exit');
      assert.strictEqual(result.kind, 'failed');
      assert.ok(result.detail !== undefined && result.detail.length > 0);
    });

    // A shim that resolved to a real file but could not run the gem gives Node no ENOENT, so
    // without this the missing-executable notice never fires for an rbenv or asdf user.
    test('should report exit 127 as enoent so the missing-executable notice fires', () => {
      const result = interpretResult(finished({ code: 127, stderr: 'rbenv: slim-lint: command not found' }), '/shims/slim-lint');
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'enoent');
      assert.strictEqual(result.kind, 'failed');
      assert.strictEqual(result.command, '/shims/slim-lint');
    });

    // The notice falls back to re-resolving when no command is carried, so this must stay omitted
    // rather than become an undefined entry the fallback would skip.
    test('should omit the command on exit 127 when the caller gave none', () => {
      const result = interpretResult(finished({ code: 127 }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'enoent');
      assert.ok(!('command' in result));
    });

    test('should report unparseable output rather than an empty report', () => {
      const result = interpretResult(finished({ stdout: 'Could not find gem\n{"files":[]}' }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'unparseable-report');
    });

    test('should pass a spawn failure through with its own reason', () => {
      const result = interpretResult({ ok: false, reason: 'enoent', stderr: '', message: 'not found' });
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'enoent');
      assert.strictEqual(result.detail, 'not found');
    });

    // The retry may fail on a different command than the original config resolves to, so the
    // notice needs the one the run itself could not find.
    test('should pass the missing command through a spawn failure', () => {
      const result = interpretResult({ ok: false, reason: 'enoent', stderr: '', message: 'not found', command: 'slim-lint' });
      assert.ok(!result.ok);
      assert.strictEqual(result.command, 'slim-lint');
    });

    test('should classify an untrusted refusal as skipped', () => {
      const result = interpretResult({ ok: false, reason: 'untrusted', stderr: '' });
      assert.ok(!result.ok);
      assert.strictEqual(result.kind, 'skipped');
    });
  });

  suite('the failure vocabulary', () => {
    // diagnostics.ts branches on two of these; a typo used to be a silent no-op.
    test('should keep every reason a skip or a failure, never neither', () => {
      const reasons: RunFailureReason[] = [
        'untrusted',
        'enoent',
        'timeout',
        'cancelled',
        'overflow',
        'spawn-error',
        'not-eligible',
        'timed-out-before',
        'exit',
        'unparseable-report'
      ];
      for (const reason of reasons) {
        const result = failure(reason);
        assert.ok(result.ok === false && (result.kind === 'skipped' || result.kind === 'failed'), reason);
      }
    });
  });
});
