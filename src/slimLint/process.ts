// The only module that imports child_process, and the single gate every slim-lint spawn passes
// through. No vscode import: workspace trust arrives as an injected predicate so this stays unit
// testable and so the gate cannot be forgotten at a call site.
//
// The promise NEVER rejects. Failures come back as a discriminated result, which is what makes
// "errors are logged, never thrown out of an event handler" structural rather than a convention.

import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { Semaphore } from './semaphore';

/** How a slim-lint process finished. */
export type SpawnFailureReason = 'untrusted' | 'enoent' | 'timeout' | 'cancelled' | 'overflow' | 'spawn-error';

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /**
   * True when `args` is a pre-quoted cmd.exe line from applyCmdWrapper. Without passing this through
   * to spawn, Node re-quotes the `/c` payload and cmd.exe receives backslash-escaped garbage.
   */
  readonly windowsVerbatimArguments?: boolean;
  /**
   * True when PATH resolution failed and `command` is a bare name kept for display only. run()
   * answers ENOENT without spawning: handing a bare name to the OS re-opens the current-directory-
   * first search on Windows that resolveOnPath exists to close. Answered here rather than by the
   * caller so trust and cancellation keep their precedence - an untrusted workspace must stay
   * silent, not surface a missing-executable dialog.
   */
  readonly commandMissing?: boolean;
}

export type SpawnResult =
  | { readonly ok: true; readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly reason: SpawnFailureReason;
      readonly stderr: string;
      readonly message?: string;
      /** The command an `enoent` could not find - what the missing-executable dialog should name. */
      readonly command?: string;
    };

/** Minimal cancellation surface so the process layer does not depend on vscode. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ProcessRunner {
  run(request: SpawnRequest, token?: CancellationLike): Promise<SpawnResult>;
}

/**
 * Node's execFile default is 1 MB, and on overflow it kills the child and hands back whatever it
 * managed to read. A JSON report truncated that way would fail to parse and look like a linter
 * bug, so overflow is detected explicitly and reported as its own failure - and the kill is what
 * caps the memory a runaway child can take.
 *
 * The budget is per stream, not shared: the report arrives on stdout while stderr carries only
 * logging - RuboCop advisories, backtraces - and a noisy stderr must not be able to abort a valid
 * stdout capture. Worst-case memory is therefore twice this number.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const KILL_GRACE_MS = 2000;
/** `bundle exec` costs roughly 120 MB of RSS; linting many open documents at once must not fan out. */
export const DEFAULT_MAX_CONCURRENT = 4;

export interface ProcessRunnerDeps {
  readonly isTrusted: () => boolean;
  readonly maxBufferBytes?: number;
  readonly maxConcurrent?: number;
  readonly killGraceMs?: number;
  /** Injected for tests; defaults to the real platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Kills a child and, on Windows, its whole tree.
 *
 * `child.kill` reaches only the direct child. On the cmd.exe wrapper path that is cmd itself: the
 * ruby grandchild survives, keeps the inherited stdio pipes open - so 'close' waits on it - and
 * burns CPU on the very document that just timed out. taskkill /T is the platform's tree kill; it
 * is addressed absolutely because resolving commands to absolute paths is invariant here, and the
 * current directory must never be searched for it.
 */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform !== 'win32' || child.pid === undefined) {
    // No pid means the spawn already failed; there is nothing alive to address by id.
    child.kill('SIGKILL');
    return;
  }
  const taskkill = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
  // An unhandled 'error' would crash the extension host; fall back to the direct kill instead.
  killer.on('error', () => child.kill('SIGKILL'));
}

function decode(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read through a call rather than inline.
 *
 * isCancellationRequested is declared readonly, so an inline comparison lets control-flow analysis
 * conclude that a second check can never be true - which is exactly the check that matters here,
 * because the token is cancelled by the editor while this code is awaiting a semaphore slot.
 */
function isCancelled(token?: CancellationLike): boolean {
  return token?.isCancellationRequested === true;
}

/** A runner that can also tear down whatever it still has running. */
export interface DisposableProcessRunner extends ProcessRunner {
  /** Kills every live child. Not every call site has a CancellationToken to cancel through. */
  dispose(): void;
}

export function createProcessRunner(deps: ProcessRunnerDeps): DisposableProcessRunner {
  const maxBufferBytes = deps.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const platform = deps.platform ?? process.platform;
  const semaphore = new Semaphore(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const live = new Set<ChildProcess>();
  let disposed = false;

  function spawnOnce(request: SpawnRequest, token?: CancellationLike): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
      const startedAt = Date.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let overflowed = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let subscription: { dispose(): void } | undefined;

      let child: ChildProcess;
      try {
        child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: request.windowsVerbatimArguments === true
        });
      } catch (error) {
        resolve({ ok: false, reason: 'spawn-error', stderr: '', message: error instanceof Error ? error.message : String(error) });
        return;
      }

      live.add(child);

      const cleanup = (): void => {
        live.delete(child);
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        subscription?.dispose();
      };

      const finish = (result: SpawnResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const terminate = (): void => {
        if (platform === 'win32') {
          // kill() would reach only cmd.exe on the wrapper path; the ruby grandchild would keep the
          // stdio pipes - and the 'close' this promise waits on - open until it finished naturally.
          killTree(child, platform);
          return;
        }
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      };

      // stdout carries the JSON report, so exceeding the budget fails the run outright: a
      // truncated capture could never parse, and the kill stops a child streaming without bound.
      let stdoutBytes = 0;
      const collectStdout = (chunk: Buffer): void => {
        if (overflowed) {
          return;
        }
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBufferBytes) {
          overflowed = true;
          killTree(child, platform);
          finish({
            ok: false,
            reason: 'overflow',
            stderr: decode(stderrChunks),
            message: `slim-lint wrote more than ${maxBufferBytes} bytes to stdout and was killed; a report truncated there could never parse`
          });
          return;
        }
        stdoutChunks.push(chunk);
      };

      // stderr is only ever logged, never parsed, so it is capped rather than fatal: slim-lint's
      // RuboCop advisories alone can run to hundreds of lines, and a backtrace large enough to
      // blow the budget must not discard the valid report arriving on stdout.
      let stderrBytes = 0;
      const collectStderr = (chunk: Buffer): void => {
        if (stderrBytes > maxBufferBytes) {
          return;
        }
        stderrBytes += chunk.length;
        if (stderrBytes <= maxBufferBytes) {
          stderrChunks.push(chunk);
        }
      };

      child.stdout?.on('data', collectStdout);
      child.stderr?.on('data', collectStderr);

      // Must be registered before end(): slim-lint exits before draining stdin on a bad flag
      // (exit 64) or a broken .slim-lint.yml (exit 78), and an unhandled stream 'error' is an
      // uncaught exception in the extension host.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(request.stdin, 'utf8');

      child.on('error', (error: NodeJS.ErrnoException) => {
        const enoent = error.code === 'ENOENT';
        finish({
          ok: false,
          reason: enoent ? 'enoent' : 'spawn-error',
          stderr: decode(stderrChunks),
          message: error.message,
          ...(enoent ? { command: request.command } : {})
        });
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish({ ok: false, reason: 'timeout', stderr: decode(stderrChunks) });
          return;
        }
        if (cancelled) {
          finish({ ok: false, reason: 'cancelled', stderr: decode(stderrChunks) });
          return;
        }
        finish({ ok: true, code, stdout: decode(stdoutChunks), stderr: decode(stderrChunks), durationMs: Date.now() - startedAt });
      });

      // Whichever comes first names the result and owns the teardown. A child slow to die on SIGTERM
      // is still alive when the other one arrives: a cancelled run reported as `timeout` would record
      // a back-off nothing earned, and a second terminate() would orphan the first kill timer.
      timeoutTimer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        timedOut = true;
        terminate();
      }, request.timeoutMs);

      subscription = token?.onCancellationRequested(() => {
        if (timedOut || cancelled) {
          return;
        }
        cancelled = true;
        terminate();
      });
    });
  }

  return {
    async run(request: SpawnRequest, token?: CancellationLike): Promise<SpawnResult> {
      if (!deps.isTrusted()) {
        // Gating here rather than at the call sites is the point: `bundle exec` evaluates the
        // workspace Gemfile as Ruby, and .rubocop.yml can `require` any .rb from the workspace.
        return { ok: false, reason: 'untrusted', stderr: '' };
      }
      // Checked here so an already-cancelled request answers immediately instead of queueing.
      if (disposed || isCancelled(token)) {
        return { ok: false, reason: 'cancelled', stderr: '' };
      }
      if (request.commandMissing === true) {
        return { ok: false, reason: 'enoent', stderr: '', message: `${request.command} was not found on PATH`, command: request.command };
      }
      const release = await semaphore.acquire();
      try {
        // And again after the wait: a superseded onType tick can sit behind several `bundle exec`
        // cold starts, and spawning it then costs a full Ruby boot for a result nobody reads.
        // `disposed` again too: dispose() runs while requests sit queued on the semaphore, and a
        // spawn after it would outlive the extension with nothing left to kill it.
        if (disposed || isCancelled(token)) {
          return { ok: false, reason: 'cancelled', stderr: '' };
        }
        return await spawnOnce(request, token);
      } finally {
        release();
      }
    },

    dispose(): void {
      disposed = true;
      for (const child of live) {
        killTree(child, platform);
      }
      live.clear();
    }
  };
}
