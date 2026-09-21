import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { SlimLintClient } from '../../client';
import { Logger } from '../../logger';
import type { ResolveDeps } from '../../slimLint/executable';
import { createProcessRunner, type ProcessRunner, type SpawnRequest, type SpawnResult } from '../../slimLint/process';
import { config } from '../support/doubles';
import { openView } from '../support/host';

const REPORT = JSON.stringify({ files: [{ path: 'a.slim', offenses: [] }] });

/** Records every request that reaches the process layer, which is what these tests count. */
function recordingRunner(results: readonly SpawnResult[]): ProcessRunner & { readonly requests: SpawnRequest[] } {
  const requests: SpawnRequest[] = [];
  return {
    requests,
    async run(request: SpawnRequest): Promise<SpawnResult> {
      requests.push(request);
      return results[Math.min(requests.length - 1, results.length - 1)] as SpawnResult;
    }
  };
}

const TIMED_OUT: SpawnResult = { ok: false, reason: 'timeout', stderr: '' };
const SUCCEEDED: SpawnResult = { ok: true, code: 0, stdout: REPORT, stderr: '', durationMs: 10 };

let logger: Logger;

/**
 * Fake resolution that always finds slim-lint on a fake PATH. These tests are about coalescing and
 * back-off, and have to pass on a host with no Ruby at all: with the real filesystem, a machine
 * without the gem would answer every run with the missing-command short-circuit instead.
 */
const RESOLVING_DEPS: ResolveDeps = {
  fileExists: (target) => target.endsWith('/slim-lint'),
  readFile: () => null,
  platform: 'linux',
  env: { PATH: '/usr/bin' }
};

function clientFor(runner: ProcessRunner): SlimLintClient {
  return new SlimLintClient(runner, logger, RESOLVING_DEPS);
}

// This is what makes a debounce on the .slim-lint.yml watcher unnecessary. A single write commonly
// produces more than one filesystem event, and switching branches can change .slim-lint.yml and
// .rubocop.yml at once, firing both watchers: every one of those asks for the same document at the
// same version, so they arrive at the request already in flight instead of at a second Ruby process.
suite('client request coalescing Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should spawn once for concurrent identical requests', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const results = await Promise.all([client.run(document, config()), client.run(document, config()), client.run(document, config())]);

    assert.strictEqual(runner.requests.length, 1, 'three watcher events for one unchanged document must share one process');
    assert.ok(results.every((result) => result.ok));
  });

  // Closing a document cancels its run, but one still queued in the process layer settles late; a
  // document reopened meanwhile restarts at version 1 and lands on the very same key. forget()
  // evicting the entry is what keeps the reopened document's first lint from inheriting `cancelled`.
  test('should not hand a forgotten in-flight run to a later request with the same key', async () => {
    const requests: SpawnRequest[] = [];
    let releaseFirst: (result: SpawnResult) => void = () => undefined;
    const gate = new Promise<SpawnResult>((resolve) => {
      releaseFirst = resolve;
    });
    const runner: ProcessRunner = {
      run(request: SpawnRequest): Promise<SpawnResult> {
        requests.push(request);
        return requests.length === 1 ? gate : Promise.resolve(SUCCEEDED);
      }
    };
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const abandoned = client.run(document, config());
    client.forget(document.uri);
    const fresh = client.run(document, config());

    assert.strictEqual(requests.length, 2, 'the later request must spawn afresh, not join the forgotten run');
    releaseFirst({ ok: false, reason: 'cancelled', stderr: '' });
    const [abandonedResult, freshResult] = await Promise.all([abandoned, fresh]);
    assert.strictEqual(abandonedResult.ok, false);
    assert.ok(freshResult.ok, 'the fresh run must produce a real result');
  });
});

// A failure whose only explanation is its `detail` - a spawn EACCES has no stderr at all - must
// still leave a line in the channel: the alternative is diagnostics that silently vanish.
suite('client failure logging Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should log the detail of a spawn failure that produces no stderr', async () => {
    const errors: string[] = [];
    logger.error = (message: string) => {
      errors.push(message);
    };
    const runner = recordingRunner([{ ok: false, reason: 'spawn-error', stderr: '', message: 'spawn EACCES /usr/bin/slim-lint' }]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const result = await client.run(document, config());

    assert.strictEqual(result.ok, false);
    assert.ok(
      errors.some((line) => line.includes('EACCES')),
      `the EACCES detail must reach the channel, got ${JSON.stringify(errors)}`
    );
  });

  // bin/slim-lint builds its logger on $stdout, so the sentence explaining an exit 64, 70 or 78
  // arrives there and stderr stays empty: logging stderr alone leaves "exit 78" in the channel and
  // the YAML error that caused it nowhere.
  test('should log what slim-lint wrote to stdout when it exits with an error', async () => {
    const details: string[] = [];
    logger.error = () => undefined;
    logger.detail = (label: string, text: string) => {
      details.push(`${label}: ${text}`);
    };
    const explanation = "Unable to load configuration from '.slim-lint.yml': did not find expected ',' or ']'";
    const runner = recordingRunner([{ ok: true, code: 78, stdout: explanation, stderr: '', durationMs: 10 }]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const result = await client.run(document, config());

    assert.strictEqual(result.ok, false);
    assert.ok(
      details.some((line) => line.includes(explanation)),
      `slim-lint's own explanation must reach the channel, got ${JSON.stringify(details)}`
    );
  });
});

// slim-lint is superlinear in document size: a ~19 KB file already takes longer than the default
// 15 s timeout on a normal machine. Without a back-off, every save and - in onType mode - every
// debounce tick starts another Ruby process that is killed 15 s later having produced nothing.
suite('client timeout back-off Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should not spawn again after a run timed out on the same document', async () => {
    const runner = recordingRunner([TIMED_OUT]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const first = await client.run(document, config());
    const second = await client.run(document, config());

    assert.strictEqual(first.ok, false);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(runner.requests.length, 1, 'the second run must not reach the process layer');
  });

  test('should report the skip as skipped rather than as a fresh failure', async () => {
    const runner = recordingRunner([TIMED_OUT]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config());
    const skipped = await client.run(document, config());

    assert.strictEqual(skipped.ok, false);
    assert.strictEqual(skipped.kind, 'skipped');
  });

  // The back-off is keyed on the size that timed out, so the document that shrank below it is worth
  // another try.
  test('should spawn again for a smaller document', async () => {
    const runner = recordingRunner([TIMED_OUT]);
    const client = clientFor(runner);
    const large = await openView('offenses.slim');
    const small = await openView('clean.slim');
    assert.ok(small.getText().length < large.getText().length, 'the fixture must be smaller for this test to mean anything');

    await client.run(large, config());
    await client.run(small, config());

    assert.strictEqual(runner.requests.length, 2, 'a different, smaller document must still run');
  });

  // Raising the timeout is exactly how a user says "this file is large, wait longer for it", so it
  // has to be what lifts the back-off. Keying on the value avoids needing an invalidation hook.
  test('should spawn again once the timeout is raised', async () => {
    const runner = recordingRunner([TIMED_OUT]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config({ timeoutMs: 15000 }));
    await client.run(document, config({ timeoutMs: 60000 }));

    assert.strictEqual(runner.requests.length, 2);
  });

  test('should spawn again after the back-off is forgotten', async () => {
    const runner = recordingRunner([TIMED_OUT]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config());
    client.forget(document.uri);
    await client.run(document, config());

    assert.strictEqual(runner.requests.length, 2, 'an explicit Slim: Lint File must always run');
  });

  // Only a timeout backs off. A process that finished, whatever its exit code, proves the document is
  // within budget, and cancelling a superseded onType run says nothing about the document at all.
  test('should not back off for a run that finished', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config());
    await client.run(document, config());

    assert.strictEqual(runner.requests.length, 2);
  });

  test('should not back off for a cancelled run', async () => {
    const runner = recordingRunner([{ ok: false, reason: 'cancelled', stderr: '' }]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config());
    await client.run(document, config());

    assert.strictEqual(runner.requests.length, 2);
  });

  test('should lift the back-off as soon as a run finishes', async () => {
    const runner = recordingRunner([TIMED_OUT, SUCCEEDED, SUCCEEDED]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    await client.run(document, config());
    client.forget(document.uri);
    await client.run(document, config());
    await client.run(document, config());

    assert.strictEqual(runner.requests.length, 3, 'the run that finished must clear the recorded size');
  });
});

// The settings or a rule file changed while a run was in flight: the forced re-lint must not be
// handed that run's answer, because it was spawned under the state the force exists to replace.
suite('client forced run Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should not coalesce a forced run onto one already in flight', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const stale = client.run(document, config());
    const forced = client.run(document, config(), undefined, true);
    await Promise.all([stale, forced]);

    assert.strictEqual(runner.requests.length, 2, 'the forced run must spawn afresh under the new state');
  });

  test('should let later requests join the forced run, not the abandoned one', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const client = clientFor(runner);
    const document = await openView('offenses.slim');

    const stale = client.run(document, config());
    const forced = client.run(document, config(), undefined, true);
    const follower = client.run(document, config());
    await Promise.all([stale, forced, follower]);

    assert.strictEqual(runner.requests.length, 2, 'the follower must share the forced run, not add a third');
  });
});

// A command that PATH resolution could not find must never reach the OS as a bare name: on Windows
// CreateProcess searches the current directory - the repository - before PATH.
suite('client missing command Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should answer enoent without spawning when the command is not on PATH', async () => {
    // The real runner: the refusal lives behind its trust and cancellation checks, so a missing
    // command in a trusted workspace is ENOENT while an untrusted one stays a silent skip.
    const real = createProcessRunner({ isTrusted: () => true });
    const deps: ResolveDeps = { fileExists: () => false, readFile: () => null, platform: 'linux', env: { PATH: '/usr/bin' } };
    const client = new SlimLintClient(real, logger, deps);
    const document = await openView('offenses.slim');

    const result = await client.run(document, config());

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok ? undefined : result.reason, 'enoent');
    real.dispose();
  });

  test('should stay a silent untrusted skip when the workspace is not trusted', async () => {
    const real = createProcessRunner({ isTrusted: () => false });
    const deps: ResolveDeps = { fileExists: () => false, readFile: () => null, platform: 'linux', env: { PATH: '/usr/bin' } };
    const client = new SlimLintClient(real, logger, deps);
    const document = await openView('offenses.slim');

    const result = await client.run(document, config());

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok ? undefined : result.reason, 'untrusted', 'trust must outrank the missing command');
    real.dispose();
  });
});

// applyCmdWrapper builds a pre-quoted cmd.exe line and marks it verbatim; dropping that flag on the
// way to spawn lets Node re-quote the /c payload into backslash-escaped garbage, which is why every
// .bat/.cmd invocation - the standard gem layout on Windows - used to fail.
suite('client windows command wrapping Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should carry the cmd wrapper and its verbatim flag through to the process layer', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const deps: ResolveDeps = { fileExists: () => false, readFile: () => null, platform: 'win32', env: {} };
    const client = new SlimLintClient(runner, logger, deps);
    const document = await openView('offenses.slim');

    await client.run(document, config({ executablePath: 'C:\\Ruby\\bin\\slim-lint.bat' }));

    const request = runner.requests[0];
    assert.ok(request !== undefined);
    assert.deepStrictEqual(request.args.slice(0, 3), ['/d', '/s', '/c'], 'a .bat command must go through cmd.exe');
    assert.strictEqual(request.windowsVerbatimArguments, true, 'the pre-quoted line must reach spawn verbatim');
  });
});

// getWorkspaceFolder never matches untitled:, so without the workspaceFolders fallback the
// eligibility rule "untitled needs a workspace folder" was unsatisfiable and untitled linting dead.
suite('client untitled document Test Suite', () => {
  setup(() => {
    logger = new Logger();
  });

  teardown(() => {
    logger.dispose();
  });

  test('should lint an untitled document inside a workspace window', async () => {
    const runner = recordingRunner([SUCCEEDED]);
    const client = clientFor(runner);
    const document = await vscode.workspace.openTextDocument({ language: 'slim', content: 'p x\n' });

    const result = await client.run(document, config());

    assert.ok(result.ok, 'untitled plus a workspace folder must be eligible');
    assert.strictEqual(runner.requests.length, 1);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder !== undefined, 'the extension host opens a workspace folder');
    assert.ok(runner.requests[0]?.cwd.startsWith(folder.uri.fsPath), 'the run must anchor inside the workspace folder');
  });
});
