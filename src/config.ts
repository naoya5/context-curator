// config.ts — ~/.curator/config.yaml loader with built-in defaults (DESIGN.md §4.4)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface PolicyConfig {
  staleDays: number;
  unusedGraceDays: number;
  bloat: {
    claudeMdTokens: number;
    skillFullTokens: number;
    memoryFileTokens: number;
  };
}

export interface CuratorConfig {
  policy: PolicyConfig;
  ignore: string[];
}

const DEFAULTS: CuratorConfig = {
  policy: {
    staleDays: 30,
    unusedGraceDays: 14,
    bloat: {
      claudeMdTokens: 3000,
      skillFullTokens: 8000,
      memoryFileTokens: 2000,
    },
  },
  ignore: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const b = base[key];
    const o = override[key];
    if (
      o !== undefined &&
      typeof o === 'object' &&
      o !== null &&
      !Array.isArray(o) &&
      typeof b === 'object' &&
      b !== null &&
      !Array.isArray(b)
    ) {
      result[key] = deepMerge(b, o);
    } else if (o !== undefined) {
      result[key] = o;
    }
  }
  return result;
}

export function loadConfig(curatorHome: string): CuratorConfig {
  const configPath = join(curatorHome, 'config.yaml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw) as Partial<CuratorConfig> | null;
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULTS;
    }
    return deepMerge(DEFAULTS, parsed);
  } catch {
    // File not found or parse error → use built-in defaults silently
    return DEFAULTS;
  }
}
