// slim-lint JSON report parsing. Pure; no vscode imports. Never throws.
//
// The report is not trusted input: a workspace can put its own bin/slim-lint on PATH, so every
// field is narrowed before use. Anything unrecognized is dropped rather than crashing the parse.

import type { Offense, OffenseSeverity, SlimLintReport } from '../types';

export type ParseResult = { readonly ok: true; readonly report: SlimLintReport } | { readonly ok: false; readonly raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSeverity(value: unknown): OffenseSeverity {
  // Unknown or future values degrade to warning rather than being dropped.
  return value === 'error' ? 'error' : 'warning';
}

function toLine(value: unknown): number {
  // Integers only: a fractional line from a rogue reporter would survive the mapper's clamp and
  // reach lineAt(), which rejects non-integers.
  if (isRecord(value) && typeof value.line === 'number' && Number.isInteger(value.line)) {
    return value.line;
  }
  // Syntax errors can omit `location` entirely.
  return 1;
}

function toOffense(value: unknown): Offense | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = typeof value.message === 'string' ? value.message : '';
  if (message === '') {
    return null;
  }
  // slim-lint's key is `linter`, and it is null - not absent - for parse errors.
  const linterName = typeof value.linter === 'string' && value.linter !== '' ? value.linter : undefined;

  return {
    line: toLine(value.location),
    severity: toSeverity(value.severity),
    message,
    ...(linterName === undefined ? {} : { linterName })
  };
}

/**
 * Parses a slim-lint JSON report.
 *
 * Offenses from every entry in `files` are merged: the extension pipes a single document, so any
 * entry present belongs to it. slim-lint omits clean files from `files` entirely, so an empty
 * array means the document is clean - which is why callers must clear diagnostics rather than
 * leaving the previous ones in place.
 */
export function parseReport(text: unknown): ParseResult {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    return { ok: false, raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Bundler and gems occasionally write to the same stream, and exit 70 puts a backtrace there.
    // Refuse the whole payload rather than salvaging a substring.
    return { ok: false, raw };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    return { ok: false, raw };
  }

  const offenses: Offense[] = [];
  for (const file of parsed.files) {
    if (!isRecord(file) || !Array.isArray(file.offenses)) {
      continue;
    }
    for (const entry of file.offenses) {
      const offense = toOffense(entry);
      if (offense !== null) {
        offenses.push(offense);
      }
    }
  }

  const report: SlimLintReport = { offenses };
  return { ok: true, report };
}
