// Reads settings from VS Code and hands them to the pure normalizer.
//
// The resource argument is mandatory, not optional: without it VS Code ignores folder-level
// settings in a multi-root workspace and any "[slim]" language override.

import * as vscode from 'vscode';
import { CONFIG_KEYS, normalizeConfig, type RawConfig } from './configSchema';
import type { SlimConfig } from './types';

export const CONFIG_SECTION = 'slim';

export function loadConfig(resource: vscode.Uri | undefined): SlimConfig {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const values: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(CONFIG_KEYS)) {
    values[field] = raw.get(key);
  }
  return normalizeConfig(values as RawConfig);
}
