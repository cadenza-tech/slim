import * as assert from 'node:assert';
import { DiagnosticsController } from '../../diagnostics';
import { Logger } from '../../logger';
import { MissingExecutableNotice, type Notifier } from '../../missingExecutableNotice';
import type { RunFailureReason } from '../../slimLint/outcome';
import { config, memento, stubLintRunner } from '../support/doubles';
import { openView } from '../support/host';

function counting(): Notifier & { calls: number } {
  const notifier = Object.assign(
    async (): Promise<string | undefined> => {
      notifier.calls++;
      return undefined;
    },
    { calls: 0 }
  );
  return notifier;
}

/** Lints once with a runner that always fails for `reason`, and reports whether the user was warned. */
async function warningsFor(reason: RunFailureReason): Promise<number> {
  const notifier = counting();
  const logger = new Logger();
  const controller = new DiagnosticsController(
    stubLintRunner(() => ({ ok: false, kind: 'failed', reason })),
    logger,
    () => config(),
    new MissingExecutableNotice(logger, memento(), notifier)
  );
  const document = await openView('offenses.slim');

  await controller.lint(document, config());

  controller.dispose();
  logger.dispose();
  return notifier.calls;
}

// What the notice itself does once asked is pinned in missingExecutableNotice.test.ts. These two
// pin the routing: which failures are worth interrupting the user for.
suite('diagnostics missing executable Test Suite', () => {
  test('should warn when the executable could not be run', async () => {
    assert.strictEqual(await warningsFor('enoent'), 1);
  });

  test('should not warn for failures that are not a missing executable', async () => {
    assert.strictEqual(await warningsFor('timeout'), 0);
  });

  // After the missing-gem retry the command that failed is the PATH executable; re-resolving under
  // the original config would name the bundle command that ran fine.
  test('should name the command the failed run itself could not find', async () => {
    const seen: string[] = [];
    const notifier: Notifier = async (message: string) => {
      seen.push(message);
      return undefined;
    };
    const logger = new Logger();
    const controller = new DiagnosticsController(
      stubLintRunner(() => ({ ok: false, kind: 'failed', reason: 'enoent', command: '/gem/bin/slim-lint' })),
      logger,
      () => config(),
      new MissingExecutableNotice(logger, memento(), notifier)
    );
    const document = await openView('offenses.slim');

    await controller.lint(document, config());

    controller.dispose();
    logger.dispose();
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0]?.includes('/gem/bin/slim-lint'), seen[0]);
    assert.ok(!seen[0]?.includes('/usr/bin/slim-lint'), 'must not name the re-resolved command');
  });
});
