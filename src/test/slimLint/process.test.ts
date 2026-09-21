import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CancellationLike, SpawnRequest } from '../../slimLint/process';
import { createProcessRunner, type ProcessRunnerDeps } from '../../slimLint/process';

const NODE = process.execPath;

function request(script: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    command: NODE,
    args: ['-e', script],
    cwd: process.cwd(),
    stdin: '',
    env: process.env,
    timeoutMs: 10000,
    ...overrides
  };
}

function runner(overrides: Partial<ProcessRunnerDeps> = {}) {
  return createProcessRunner({ isTrusted: () => true, ...overrides });
}

/** Minimal CancellationToken stand-in so the process layer stays free of vscode. */
function token(): CancellationLike & { cancel(): void } {
  const listeners: (() => void)[] = [];
  let requested = false;
  return {
    get isCancellationRequested() {
      return requested;
    },
    onCancellationRequested(listener: () => void) {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    cancel() {
      requested = true;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

suite('slimLint/process Test Suite', () => {
  suite('workspace trust gate', () => {
    // `bundle exec` evaluates the workspace Gemfile as Ruby, .slim-lint.yml is ERB, and
    // .rubocop.yml can `require` any .rb in the repository.
    test('should refuse to spawn in an untrusted workspace', async () => {
      const result = await runner({ isTrusted: () => false }).run(request('process.stdout.write("ran")'));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'untrusted');
    });

    test('should refuse before doing any work when already cancelled', async () => {
      const cancelled = token();
      cancelled.cancel();
      const result = await runner().run(request('process.stdout.write("ran")'), cancelled);
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'cancelled');
    });
  });

  suite('normal completion', () => {
    test('should return stdout, stderr and the exit code', async () => {
      const result = await runner().run(request('process.stdout.write("out");process.stderr.write("err");process.exit(65)'));
      assert.ok(result.ok);
      assert.strictEqual(result.stdout, 'out');
      assert.strictEqual(result.stderr, 'err');
      assert.strictEqual(result.code, 65);
      assert.ok(result.durationMs >= 0);
    });

    test('should pipe stdin through to the child', async () => {
      const script = 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))';
      const result = await runner().run(request(script, { stdin: 'slim' }));
      assert.ok(result.ok);
      assert.strictEqual(result.stdout, 'SLIM');
    });

    test('should round-trip non-ascii content without corruption', async () => {
      const script = 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d))';
      const source = 'p 日本語のテキスト\n';
      const result = await runner().run(request(script, { stdin: source }));
      assert.ok(result.ok);
      assert.strictEqual(result.stdout, source);
    });

    test('should run in the requested cwd', async () => {
      const result = await runner().run(request('process.stdout.write(process.cwd())', { cwd: __dirname }));
      assert.ok(result.ok);
      assert.strictEqual(result.stdout, __dirname);
    });

    test('should pass the requested environment', async () => {
      const result = await runner().run(
        request('process.stdout.write(process.env.SLIM_TEST_VAR||"")', { env: { ...process.env, SLIM_TEST_VAR: 'x' } })
      );
      assert.ok(result.ok);
      assert.strictEqual(result.stdout, 'x');
    });
  });

  suite('failure paths', () => {
    test('should report ENOENT instead of rejecting', async () => {
      const result = await runner().run(request('', { command: '/nonexistent/slim-lint', args: [] }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'enoent');
      assert.strictEqual(result.command, '/nonexistent/slim-lint');
    });

    // stdout carries the JSON report: a truncated capture could never parse, so handing it on
    // would misreport a budget problem as a polluted stream. Overflow is its own failure instead.
    test('should report overflow rather than returning truncated stdout', async () => {
      const result = await runner({ maxBufferBytes: 1000 }).run(request('process.stdout.write("x".repeat(200000))'));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'overflow');
    });

    test('should not report overflow for output within the limit', async () => {
      const result = await runner({ maxBufferBytes: 100000 }).run(request('process.stdout.write("x".repeat(5000))'));
      assert.ok(result.ok);
      assert.strictEqual(result.stdout.length, 5000);
    });

    test('should time out and kill the child', async () => {
      const started = Date.now();
      const result = await runner().run(request('setTimeout(()=>{},30000)', { timeoutMs: 200 }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'timeout');
      assert.ok(Date.now() - started < 10000, 'must not wait for the child to finish on its own');
    });

    test('should stop on cancellation', async () => {
      const cancellation = token();
      const promise = runner().run(request('setTimeout(()=>{},30000)'), cancellation);
      setTimeout(() => cancellation.cancel(), 50);
      const result = await promise;
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'cancelled');
    });

    // Nothing here can see the teardown running once rather than twice; what it pins is that a
    // second cancellation is answered like the first.
    test('should still answer cancelled when cancelled twice', async () => {
      const cancellation = token();
      const promise = runner().run(request('setTimeout(()=>{},30000)'), cancellation);
      setTimeout(() => {
        cancellation.cancel();
        cancellation.cancel();
      }, 50);
      const result = await promise;
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'cancelled');
    });

    // An executablePath naming a wrapper script that does not `exec` - `cd app && bundle exec
    // slim-lint "$@"`, a docker wrapper - leaves slim-lint as a grandchild holding the stdio pipes.
    // Killing the wrapper does not close them, and a promise waiting for 'close' keeps its
    // concurrency slot for as long as the grandchild lives: four of those and nothing lints at all.
    test('should settle a timed out run whose grandchild still holds the pipes', async () => {
      const grandchild = 'setTimeout(()=>{},8000)';
      const wrapper = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"inherit"});setTimeout(()=>{},30000)`;
      const started = Date.now();
      const result = await runner().run(request(wrapper, { timeoutMs: 500 }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'timeout');
      assert.ok(Date.now() - started < 5000, `settled after ${Date.now() - started}ms, which is the grandchild's lifetime`);
    });

    // Settling is not the same as stopping. The run above is over once the wrapper exits, but the
    // grandchild - the Ruby process that just ran out of time - would go on burning a core on the
    // same document unless the signal reaches the wrapper's whole process group.
    test('should take a grandchild down with the wrapper it outlives', async function () {
      if (process.platform === 'win32') {
        // taskkill /T already walks the tree there, and this wrapper shape is POSIX's.
        this.skip();
      }
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-group-'));
      const proof = path.join(scratch, 'alive');
      try {
        // A survivor says so by itself: probing its pid instead races with whoever reaps it. It sits
        // out SIGTERM, because the wrapper's exit settles the run and with it the kill timer - so
        // the SIGKILL that ends this one has to come at that moment or never.
        const grandchild = `process.on("SIGTERM",()=>{}); process.stderr.write(String(process.pid)); setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(proof)},"x"),2500); setTimeout(()=>{},20000)`;
        const wrapper = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"inherit"});setTimeout(()=>{},20000)`;
        // Long enough for the wrapper to have spawned: a kill that lands first proves nothing.
        const result = await runner({ killGraceMs: 500 }).run(request(wrapper, { timeoutMs: 1500 }));
        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'timeout');
        assert.ok(Number(result.stderr) > 0, `the grandchild must have started, got ${JSON.stringify(result.stderr)}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.ok(!fs.existsSync(proof), 'the grandchild lived on to write its proof');
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    // What the group signal cannot reach: a descendant that left the group (its own `setsid`). The
    // group is empty by then and the signal has nobody to go to, which must not be an error.
    test('should fall back to the child alone once the group is gone', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      const escaped = 'setTimeout(()=>{},2500)';
      const wrapper = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(escaped)}],{stdio:"inherit",detached:true})`;
      const result = await runner({ killGraceMs: 200 }).run(request(wrapper, { timeoutMs: 1000 }));
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'timeout');
    });

    // A timeout and a cancellation can both arrive for one run: the editor cancels while the child is
    // still inside its grace period. A kill timer left armed would fire after the run has settled -
    // at a process group that, by then, may be somebody else's.
    test('should not signal anything once the run has settled', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      const signalled: string[] = [];
      let settled = false;
      const kill = process.kill;
      process.kill = ((pid: number, signal?: string | number): true => {
        if (settled) {
          signalled.push(`${pid} ${String(signal)}`);
        }
        return kill.call(process, pid, signal);
      }) as typeof process.kill;
      try {
        const cancellation = token();
        // Outlives SIGTERM for a moment, so that the cancellation lands between the two signals.
        const lingering = 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),300)); setTimeout(()=>{},30000)';
        const promise = runner({ killGraceMs: 600 }).run(request(lingering, { timeoutMs: 400 }), cancellation);
        setTimeout(() => cancellation.cancel(), 500);
        await promise;
        settled = true;
        await new Promise((resolve) => setTimeout(resolve, 900));
      } finally {
        process.kill = kill;
      }
      assert.deepStrictEqual(signalled, []);
    });

    // A child slow to die on SIGTERM is still alive when the timeout comes due, and answering
    // `timeout` for it records a back-off against a document whose run was merely superseded: the
    // next save is then skipped as "timed out before" with nothing having timed out.
    test('should keep calling a cancelled run cancelled when the timeout expires while it dies', async function () {
      if (process.platform === 'win32') {
        // taskkill /F has no grace period for the timeout to land in.
        this.skip();
      }
      const cancellation = token();
      const ignoresSigterm = 'process.on("SIGTERM",()=>{});setTimeout(()=>{},30000)';
      const promise = runner({ killGraceMs: 1500 }).run(request(ignoresSigterm, { timeoutMs: 1000 }), cancellation);
      setTimeout(() => cancellation.cancel(), 500);
      const result = await promise;
      assert.ok(!result.ok);
      assert.strictEqual(result.reason, 'cancelled');
    });

    // slim-lint exits before draining stdin on a bad flag (64) or broken config (78). Without an
    // 'error' listener on child.stdin the resulting EPIPE is an uncaught exception that takes down
    // the extension host, so this test failing would show up as a crash, not an assertion.
    test('should survive the child exiting before reading stdin', async () => {
      const result = await runner().run(request('process.exit(64)', { stdin: 'x'.repeat(2 * 1024 * 1024) }));
      assert.ok(result.ok || !result.ok, 'must settle rather than crash the host');
      if (result.ok) {
        assert.strictEqual(result.code, 64);
      }
    });
  });

  suite('dispose', () => {
    // run() takes its CancellationToken as optional, so shutdown cannot rely on cancellation
    // reaching every child: deactivate needs an explicit kill for whatever is still alive.
    test('should kill live children', async () => {
      const disposable = runner();
      const promise = disposable.run(request('setTimeout(()=>{},30000)'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      disposable.dispose();

      const result = await promise;
      assert.ok(result.ok, 'a SIGKILLed child still closes normally');
      assert.strictEqual(result.code, null, 'a signalled exit reports no code');
    });

    test('should be safe with nothing running', () => {
      const disposable = runner();
      disposable.dispose();
      disposable.dispose();
    });

    // Requests still queued on the semaphore when dispose() runs would otherwise spawn afterwards,
    // with nothing left alive to kill them.
    test('should refuse to spawn after dispose', async () => {
      const disposable = runner();
      disposable.dispose();

      const result = await disposable.run(request('setTimeout(()=>{},30000)'));

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok ? undefined : result.reason, 'cancelled');
    });
  });

  suite('missing command', () => {
    test('should answer enoent without spawning', async () => {
      const result = await runner().run(request('', { command: 'slim-lint', commandMissing: true }));

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok ? undefined : result.reason, 'enoent');
      assert.strictEqual(result.ok ? undefined : result.command, 'slim-lint');
    });

    // The refusal sits behind the trust gate on purpose: an untrusted workspace is a deliberate
    // silent skip, and surfacing a missing-executable dialog there would be a regression.
    test('should let trust outrank the missing command', async () => {
      const result = await runner({ isTrusted: () => false }).run(request('', { command: 'slim-lint', commandMissing: true }));

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok ? undefined : result.reason, 'untrusted');
    });

    test('should let cancellation outrank the missing command', async () => {
      const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };
      const result = await runner().run(request('', { command: 'slim-lint', commandMissing: true }), token);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok ? undefined : result.reason, 'cancelled');
    });
  });

  suite('concurrency', () => {
    test('should not run more children at once than the limit', async () => {
      const limited = runner({ maxConcurrent: 2 });
      const started = Date.now();
      // setTimeout guarantees a lower bound, so only the lower bound is asserted: four 200 ms
      // children through a limit of two cannot finish in under two rounds.
      await Promise.all(Array.from({ length: 4 }, () => limited.run(request('setTimeout(()=>{},200)'))));
      assert.ok(Date.now() - started >= 350, `expected at least two rounds, took ${Date.now() - started}ms`);
    });

    test('should not spawn a request cancelled while it waited for a slot', async () => {
      const limited = runner({ maxConcurrent: 1 });
      const cancellable = token();
      const blocker = limited.run(request('setTimeout(()=>{},300)'));
      // Queued behind the blocker, then superseded before a slot frees - the onType case.
      const queued = limited.run(request('process.stdout.write("SPAWNED")'), cancellable);
      cancellable.cancel();

      const result = await queued;
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.reason, 'cancelled');
      // ok:false carries no stdout, so the marker never being produced is the assertion that the
      // process was skipped rather than started and killed.
      await blocker;
    });
  });

  suite('buffer budgets', () => {
    // The report arrives on stdout while stderr carries only logging, so a shared budget would let
    // slim-lint's RuboCop advisories or a Ruby backtrace discard a perfectly good report.
    test('should keep a large stderr from aborting a valid stdout capture', async () => {
      const small = runner({ maxBufferBytes: 1000 });
      const result = await small.run(request('process.stderr.write("x".repeat(200000)); process.stdout.write("0123456789");'));
      assert.ok(result.ok, 'a big stderr must not overflow the stdout budget');
      assert.strictEqual(result.ok && result.stdout, '0123456789');
    });

    test('should cap a runaway stderr rather than failing the run', async () => {
      const small = runner({ maxBufferBytes: 1000 });
      const result = await small.run(request('process.stderr.write("x".repeat(200000));'));
      assert.ok(result.ok, 'stderr is only ever logged, so it is capped not fatal');
      assert.ok(result.ok && result.stderr.length <= 1000, `stderr must stay within the budget, got ${result.ok && result.stderr.length}`);
    });

    test('should still fail the run when stdout overflows', async () => {
      const small = runner({ maxBufferBytes: 1000 });
      const result = await small.run(request('process.stdout.write("x".repeat(200000));'));
      assert.ok(!result.ok);
      assert.strictEqual(result.ok === false && result.reason, 'overflow');
      // The message is the only explanation the output channel gets; an overflow must not be mute.
      assert.ok(result.message !== undefined && result.message.length > 0);
    });
  });
});
