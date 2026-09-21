import * as assert from 'node:assert';
import type { LintRunner, RunResult } from '../../client';
import { DiagnosticsController } from '../../diagnostics';
import { Logger } from '../../logger';
import { MissingExecutableNotice } from '../../missingExecutableNotice';
import type { Invocation } from '../../slimLint/executable';
import type { SlimLintReport } from '../../types';
import { config, INVOCATION, memento, stubLintRunner } from '../support/doubles';
import { openView } from '../support/host';

const ONE_OFFENSE: SlimLintReport = {
  offenses: [{ line: 1, severity: 'warning', message: 'Line is too long', linterName: 'LineLength' }]
};

// A report is reused, not recomputed, whenever the text it describes is exactly what the document
// still holds: an unchanged document re-linted on save, an undo back to published text. A Ruby boot
// is the entire cost of a run, which is what makes the digest worth keeping.
suite('report reuse Test Suite', () => {
  let logger: Logger;

  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  /** Nothing here reaches a missing executable; the notice is only what the controller needs to exist. */
  function notice(): MissingExecutableNotice {
    return new MissingExecutableNotice(logger, memento());
  }

  test('should not run again when the report on screen was produced from the same text', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    await controller.lint(document, config());

    assert.strictEqual(runner.runs, 1, 'the second lint of unchanged text must reuse the published report');
    controller.dispose();
  });

  test('should run again once the text changes', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const first = await openView('offenses.slim');
    const second = await openView('clean.slim');

    await controller.lint(first, config());
    await controller.lint(second, config());

    assert.strictEqual(runner.runs, 2, 'different text must be linted');
    controller.dispose();
  });

  test('should run again when forced', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    await controller.lint(document, config(), true);

    assert.strictEqual(runner.runs, 2, 'Slim: Lint File must always run');
    assert.strictEqual(runner.forgotten, 1, 'and must lift the timeout back-off too');
    controller.dispose();
  });

  // Diagnostics that are gone are not a report anyone can reuse.
  test('should run again after the diagnostics were cleared', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    controller.clear(document);
    await controller.lint(document, config());

    assert.strictEqual(runner.runs, 2);
    controller.dispose();
  });

  test('should run again after the document was forgotten', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    controller.forget(document);
    await controller.lint(document, config());

    assert.strictEqual(runner.runs, 2);
    assert.strictEqual(runner.forgotten, 1, 'closing a document must release the client state it holds');
    controller.dispose();
  });

  // A failed run publishes nothing, so nothing may be reused: the next attempt has to be a real one.
  test('should run again after a failure', async () => {
    let attempts = 0;
    const runner = stubLintRunner(() => {
      attempts++;
      return attempts === 1 ? { ok: false, kind: 'failed', reason: 'timeout' } : { ok: true, outcome: { report: ONE_OFFENSE } };
    });
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    await controller.lint(document, config());

    assert.strictEqual(runner.runs, 2);
    controller.dispose();
  });

  // A forced request exists because the rules changed, so the digest recorded under the old ones
  // stops answering anything the moment it arrives - whether or not the forced run goes on to
  // publish. An unparseable report keeps the old diagnostics on purpose; keeping their digest too
  // would make every later save of the same text skip, with the panel still showing the old rules.
  test('should run again after a forced run that published nothing', async () => {
    let attempts = 0;
    const runner = stubLintRunner(() => {
      attempts++;
      return attempts === 2 ? { ok: false, kind: 'failed', reason: 'unparseable-report' } : { ok: true, outcome: { report: ONE_OFFENSE } };
    });
    const controller = new DiagnosticsController(runner, logger, () => config(), notice());
    const document = await openView('offenses.slim');

    await controller.lint(document, config());
    await controller.lint(document, config(), true);
    await controller.lint(document, config());

    assert.strictEqual(runner.runs, 3, 'the report published before the forced run must not be reused after it');
    controller.dispose();
  });

  // slim.lint.exclude has to keep a file out of the panel; publish() re-checks it itself because
  // the setting can change while the run whose report it is publishing was in flight.
  test('should not record a report published for an excluded document', async () => {
    const runner = stubLintRunner(() => ({ ok: true, outcome: { report: ONE_OFFENSE } }));
    let current = config({ lintExclude: ['**/offenses.slim'] });
    const controller = new DiagnosticsController(runner, logger, () => current, notice());
    const document = await openView('offenses.slim');

    controller.publish(document, ONE_OFFENSE.offenses, document.getText());

    // Had the excluded publish recorded its digest, this lint of identical text would reuse and skip.
    current = config();
    await controller.lint(document, current);
    assert.strictEqual(runner.runs, 1, 'the excluded publish must leave nothing to reuse');
    controller.dispose();
  });

  // Switching lint.run off disarms the debounce timer, but a run already in flight has nothing to
  // trip its staleness check on - same version, same generation. Its result must not repopulate the
  // panel the user just switched off, and must not leave a digest behind that a later lint would
  // mistake for a published report.
  test('should discard a run that was in flight when lint.run switched off', async () => {
    let resolveFirst: ((result: RunResult) => void) | undefined;
    let calls = 0;
    const runner: LintRunner = {
      resolve: (): Invocation => INVOCATION,
      forget: (): void => undefined,
      run: (): Promise<RunResult> => {
        calls++;
        if (calls === 1) {
          return new Promise<RunResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ ok: true, outcome: { report: ONE_OFFENSE } });
      }
    };
    let current = config();
    const controller = new DiagnosticsController(runner, logger, () => current, notice());
    const document = await openView('offenses.slim');

    const inFlight = controller.lint(document, current);
    current = config({ lintRun: 'off' });
    controller.refreshNow(document);
    resolveFirst?.({ ok: true, outcome: { report: ONE_OFFENSE } });
    await inFlight;

    // Behavioural probe: had the abandoned run published, its digest would make this reuse and skip.
    current = config();
    await controller.lint(document, current);
    assert.strictEqual(calls, 2, 'the run cancelled by switching off must not leave a reusable report behind');
    controller.dispose();
  });
});
