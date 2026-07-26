// slim-lint exit codes. Pure; no vscode imports.
//
// slim-lint's CLI intends to use sysexits, with one deliberate deviation: cli.rb hardcodes 67 for
// "no files matched", where sysexits says 66. Only 0 and 65 are treated as "a report was
// produced"; everything else is an error, whatever the number. That allowlist is what keeps the
// classification robust against codes future versions may add.
//
// 127 is the one error that is not slim-lint's at all, which is why it gets its own kind: cli.rb
// can only return 0, 64, 65, 67, 70 or 78, so a 127 comes from whatever tried to launch it and
// never did. A version manager shim is the common source - rbenv prints "rbenv: slim-lint: command
// not found" and exits 127 when the Ruby selected for the cwd lacks the gem, and since cwd is the
// directory owning .slim-lint.yml, that is decided per project. The command resolved to a real
// file, so Node reports no ENOENT and the missing-executable notice would otherwise stay silent
// for exactly the users who need it.

/** No offenses. */
const EXIT_OK = 0;
/** EX_USAGE: bad command line. */
const EXIT_USAGE = 64;
/** EX_DATAERR: offenses at or above the fail level. This is a NORMAL outcome. */
const EXIT_OFFENSES = 65;
/** slim-lint's own "no input" code: cli.rb returns 67, not sysexits' EX_NOINPUT of 66. */
const EXIT_NO_INPUT = 67;
/** EX_SOFTWARE: crashed. stderr carries a backtrace. */
const EXIT_SOFTWARE = 70;
/** EX_CONFIG: configuration error. */
const EXIT_CONFIG = 78;
/** Not slim-lint's own: the conventional "could not find the program" of whatever launched it. */
const EXIT_COMMAND_NOT_FOUND = 127;

export type ExitClassification =
  | { readonly kind: 'report' }
  | { readonly kind: 'not-found'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Classifies a slim-lint exit code.
 *
 * Only decides whether a report was produced. Never derive "has offenses" from the exit code:
 * --fail-level is user configurable, so a project with `fail_level: error` exits 0 while warnings
 * are present. Offense presence always comes from the parsed JSON.
 */
export function classifyExitCode(code: number | null): ExitClassification {
  switch (code) {
    case EXIT_OK:
    case EXIT_OFFENSES:
      return { kind: 'report' };
    case EXIT_USAGE:
      return { kind: 'error', reason: 'slim-lint rejected the command line (exit 64)' };
    case EXIT_NO_INPUT:
      return { kind: 'error', reason: 'slim-lint found no input to lint (exit 67)' };
    case EXIT_SOFTWARE:
      return { kind: 'error', reason: 'slim-lint crashed (exit 70)' };
    case EXIT_CONFIG:
      return { kind: 'error', reason: 'slim-lint could not load its configuration (exit 78)' };
    case EXIT_COMMAND_NOT_FOUND:
      return {
        kind: 'not-found',
        reason:
          'slim-lint resolved to a real file but could not be started (exit 127). A version manager shim reports this ' +
          'when the Ruby selected for the linted directory does not have slim_lint installed.'
      };
    default:
      return { kind: 'error', reason: `slim-lint exited with ${code === null ? 'no code' : code}` };
  }
}
