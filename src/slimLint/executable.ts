// Resolves how and where to invoke slim-lint. Pure; no vscode imports.
//
// Three decisions live here and all of them are easy to get wrong:
//
// 1. cwd. slim-lint discovers .slim-lint.yml by walking UP from the process cwd, never from the
//    file path. Pinning cwd to the workspace root therefore *breaks* monorepos: a config at
//    packages/web/.slim-lint.yml is never found from the repository root. cwd must be the
//    directory that owns the config, bounded by the workspace folder.
//
// 2. Windows. CreateProcess searches the current directory before PATH, so a bare command name
//    lets a repository ship its own slim-lint.exe and have it run. Commands are always resolved to
//    an absolute path first, and `shell: true` is never used anywhere.
//
// 3. A relative slim.slimLint.configPath. It is resolved against the workspace folder here rather
//    than left for the spawned process, which would resolve it against cwd -- and (1) moves cwd to
//    whichever directory owns .slim-lint.yml, so one setting would mean different files depending
//    on which document is being linted.

import { type FsDeps, findUpwards, lockfileListsGem, pathApi } from '../pure/fsWalk';
import type { UseBundler } from '../types';

export const CONFIG_FILE_NAME = '.slim-lint.yml';
export const GEMFILE_NAME = 'Gemfile';
export const SLIM_LINT_COMMAND = 'slim-lint';
export const BUNDLE_COMMAND = 'bundle';

/** slim_lint as Bundler writes it into the specs section of Gemfile.lock. */
const GEMFILE_LOCK_SLIM_LINT = /^\s+slim_lint \(/m;

export interface ResolveDeps extends FsDeps {
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolveInput {
  /** Absolute path of the document. For untitled documents, a synthetic path inside the cwd. */
  readonly documentPath: string;
  readonly workspaceFolderPath?: string;
  readonly executablePath?: string | null;
  readonly useBundler: UseBundler;
}

export interface Invocation {
  readonly command: string;
  /** Sits before the caller's arguments, e.g. ['exec', 'slim-lint'] under Bundler. */
  readonly argsPrefix: readonly string[];
  readonly cwd: string;
  readonly usesBundler: boolean;
  /** Set when Bundler is used, so a monorepo does not resolve a different Gemfile from cwd. */
  readonly bundleGemfile?: string;
  /** Node cannot spawn .bat/.cmd without a shell since CVE-2024-27980; cmdWrapper.ts wraps these. */
  readonly needsCmdWrapper: boolean;
  /**
   * True when PATH resolution failed and `command` is a bare name kept for display only. The client
   * short-circuits to ENOENT instead of spawning it: handing a bare name to the OS re-opens the
   * current-directory-first search on Windows that resolveOnPath exists to close.
   */
  readonly commandMissing: boolean;
}

/** Picks the directory slim-lint should run from so that its upward config search resolves. */
export function resolveCwd(input: ResolveInput, deps: ResolveDeps): string {
  const p = pathApi(deps.platform);
  const documentDirectory = p.dirname(input.documentPath);
  const boundary = input.workspaceFolderPath ?? documentDirectory;
  const configDirectory = findUpwards(documentDirectory, boundary, (dir) => deps.fileExists(p.join(dir, CONFIG_FILE_NAME)), deps.platform);
  return configDirectory ?? boundary;
}

/**
 * Turns the configured -c path into the absolute one slim-lint should receive.
 *
 * A relative path is documented as being relative to the workspace folder, and it has to be made
 * absolute here for that to hold: the process resolves it against cwd, which resolveCwd points at
 * the directory owning .slim-lint.yml. Without a workspace folder there is nothing to resolve
 * against, so the value is passed through untouched.
 */
export function resolveConfigPath(
  configPath: string | null | undefined,
  workspaceFolderPath: string | undefined,
  platform: NodeJS.Platform
): string | null {
  const trimmed = configPath?.trim();
  if (!trimmed) {
    return null;
  }
  const p = pathApi(platform);
  if (workspaceFolderPath === undefined || p.isAbsolute(trimmed)) {
    return trimmed;
  }
  return p.join(workspaceFolderPath, trimmed);
}

/**
 * The path handed to --stdin-file-path.
 *
 * Absolute, because a relative path would break across Windows drives and for files outside the
 * cwd. `null` is a buffer with no path of its own; it gets a synthetic one inside the cwd, which
 * is safe because slim-lint never stats the path: it only names the piped source in the report.
 *
 * Takes the path rather than a vscode.TextDocument so this file stays inside src/slimLint: the
 * boundary test looks for emitted requires, so a type-only import would slip past it unnoticed.
 */
export function stdinPathFor(documentFsPath: string | null, cwd: string, platform: NodeJS.Platform): string {
  return documentFsPath ?? pathApi(platform).join(cwd, 'untitled.slim');
}

/**
 * Decides whether to go through Bundler.
 *
 * Presence of a Gemfile is not enough: most Rails projects have one without slim_lint in it, and
 * `bundle exec slim-lint` then fails with "Could not find gem" rather than ENOENT. The lock file is
 * checked instead, so the PATH fallback is chosen up front rather than after a failed spawn.
 */
export function findBundlerGemfile(input: ResolveInput, deps: ResolveDeps): string | null {
  const p = pathApi(deps.platform);
  const documentDirectory = p.dirname(input.documentPath);
  const boundary = input.workspaceFolderPath ?? documentDirectory;

  if (input.useBundler === 'never') {
    return null;
  }

  if (input.useBundler === 'always') {
    const anyGemfile = findUpwards(documentDirectory, boundary, (dir) => deps.fileExists(p.join(dir, GEMFILE_NAME)), deps.platform);
    return anyGemfile === null ? null : p.join(anyGemfile, GEMFILE_NAME);
  }

  const lockDirectory = findUpwards(documentDirectory, boundary, (dir) => lockfileListsGem(dir, GEMFILE_LOCK_SLIM_LINT, deps), deps.platform);
  return lockDirectory === null ? null : p.join(lockDirectory, GEMFILE_NAME);
}

/**
 * Resolves a bare command name to an absolute path by scanning PATH.
 *
 * Empty and relative PATH entries are dropped. An empty entry means the current directory, which on
 * Windows is exactly the vector this exists to close; a relative one - `.`, or the `./bin` of the
 * Rails binstub convention - is probed against the extension host's cwd but spawned from the
 * directory owning .slim-lint.yml, so what it finds is neither absolute nor the file that would run.
 */
export function resolveOnPath(command: string, deps: ResolveDeps): string | null {
  const p = pathApi(deps.platform);
  if (p.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return deps.fileExists(command) ? command : null;
  }

  const isWindows = deps.platform === 'win32';
  const separator = isWindows ? ';' : ':';
  const rawPath = deps.env.PATH ?? deps.env.Path ?? '';
  const pathExt = isWindows ? (deps.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '') : [''];
  // cmd.exe tries a name that already carries one of these as it stands before appending any. Only
  // then: RubyInstaller ships an extensionless `slim-lint` Ruby script beside slim-lint.bat, and
  // CreateProcess cannot start that one.
  const carriesExtension = isWindows && pathExt.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  const extensions = carriesExtension ? ['', ...pathExt] : pathExt;

  for (const rawEntry of rawPath.split(separator)) {
    // cmd.exe tolerates quoted PATH entries and some installers write them; existsSync does not.
    const entry = isWindows && rawEntry.startsWith('"') && rawEntry.endsWith('"') && rawEntry.length >= 2 ? rawEntry.slice(1, -1) : rawEntry;
    if (!p.isAbsolute(entry)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = p.join(entry, command + extension);
      if (deps.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function needsCmdWrapper(command: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return false;
  }
  const lower = command.toLowerCase();
  return lower.endsWith('.bat') || lower.endsWith('.cmd');
}

/**
 * What an explicit executablePath may name: an absolute path, taken as given because the user named
 * a concrete location, or a bare command name, resolved on PATH like the default command. A
 * relative path is refused (null): spawn would resolve it against cwd, which is the directory
 * owning .slim-lint.yml - one the repository chooses, not the user - re-opening exactly the
 * current-directory search that resolveOnPath exists to close.
 */
function resolveExplicit(explicit: string, deps: ResolveDeps): string | null {
  if (pathApi(deps.platform).isAbsolute(explicit)) {
    return explicit;
  }
  return explicit.includes('/') || explicit.includes('\\') ? null : resolveOnPath(explicit, deps);
}

export function resolveInvocation(input: ResolveInput, deps: ResolveDeps): Invocation {
  const cwd = resolveCwd(input, deps);

  // An explicit path wins outright; bundler detection is skipped. Whether an absolute path exists
  // is left to the spawn: the user named a concrete path, so there is no search for the OS to redo
  // behind us.
  const explicit = input.executablePath?.trim();
  if (explicit) {
    const command = resolveExplicit(explicit, deps);
    return {
      command: command ?? explicit,
      argsPrefix: [],
      cwd,
      usesBundler: false,
      needsCmdWrapper: needsCmdWrapper(command ?? explicit, deps.platform),
      commandMissing: command === null
    };
  }

  const gemfile = findBundlerGemfile(input, deps);
  if (gemfile !== null) {
    const bundle = resolveOnPath(BUNDLE_COMMAND, deps);
    return {
      // The bare name is kept when resolution fails so the missing-executable notice can still say
      // what was looked for; commandMissing is what keeps it from ever being spawned.
      command: bundle ?? BUNDLE_COMMAND,
      argsPrefix: ['exec', SLIM_LINT_COMMAND],
      cwd,
      usesBundler: true,
      bundleGemfile: gemfile,
      needsCmdWrapper: needsCmdWrapper(bundle ?? BUNDLE_COMMAND, deps.platform),
      commandMissing: bundle === null
    };
  }

  const slimLint = resolveOnPath(SLIM_LINT_COMMAND, deps);
  return {
    command: slimLint ?? SLIM_LINT_COMMAND,
    argsPrefix: [],
    cwd,
    usesBundler: false,
    needsCmdWrapper: needsCmdWrapper(slimLint ?? SLIM_LINT_COMMAND, deps.platform),
    commandMissing: slimLint === null
  };
}
