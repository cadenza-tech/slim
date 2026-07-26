// slim-lint command line construction. Pure; no vscode imports.
//
// --stdin-file-path reads the document from $stdin and bypasses slim-lint's file finder entirely,
// which is also what skips the config file's own `exclude:` globs - the reason the extension offers
// `slim.lint.exclude` as the replacement. The path itself is never stat'ed, so a synthetic one for
// an untitled buffer is safe.

export interface BaseArgsOptions {
  /** Absolute path reported to slim-lint for the piped source. */
  readonly stdinPath: string;
  /** Passed through as -c. */
  readonly configPath?: string | null;
}

function configArgs(configPath: string | null | undefined): string[] {
  return configPath ? ['-c', configPath] : [];
}

/** Lint from stdin: JSON report on stdout. */
export function buildLintArgs(options: BaseArgsOptions): string[] {
  return ['--reporter', 'json', ...configArgs(options.configPath), '--stdin-file-path', options.stdinPath];
}
