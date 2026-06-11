// extract.ts — tool_use → UsageEvent extraction (DESIGN.md §4.2)
// Extraction rules:
//   Skill tool       → kind:'skill',    ref: input.skill
//   mcp__*           → kind:'mcp-tool', ref: parts[0], tool: rest.join('__')
//   Agent / Task     → kind:'agent',    ref: input.subagent_type ?? 'general-purpose'
//
// mcp name splitting: name.slice(5).split('__') where parts[0] = server, rest = tool
// This handles names like mcp__plugin_context-mode_context-mode__ctx_search
// because the server name itself may contain underscores but is always parts[0].
//
// Lines missing timestamp / sessionId / cwd are dropped (event lost, not crash).

import type { UsageEvent } from '../types.js';
import type { TranscriptLine } from './transcript.js';

/** Extract UsageEvents from a single parsed transcript line */
export function extractEvents(line: TranscriptLine): UsageEvent[] {
  const row = line.raw;
  if (!isObject(row)) return [];

  // Only process 'assistant' type lines
  if (row['type'] !== 'assistant') return [];

  // Extract required metadata from the line
  const ts = getString(row, 'timestamp');
  const sessionId = getString(row, 'sessionId');
  const cwd = getString(row, 'cwd');

  // If any required field is missing, drop the entire line
  if (!ts || !sessionId || !cwd) return [];

  const message = row['message'];
  if (!isObject(message)) return [];

  const content = message['content'];
  if (!Array.isArray(content)) return [];

  const events: UsageEvent[] = [];

  for (const item of content) {
    if (!isObject(item)) continue;
    if (item['type'] !== 'tool_use') continue;

    const name = getString(item, 'name');
    if (!name) continue;

    const input = item['input'];

    const event = extractFromToolUse(name, input, ts, sessionId, cwd);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

/** Extract all UsageEvents from an array of transcript lines */
export function extractEventsFromLines(lines: TranscriptLine[]): {
  events: UsageEvent[];
  skippedToolUseCount: number;
} {
  const events: UsageEvent[] = [];
  let skippedToolUseCount = 0;

  for (const line of lines) {
    const row = line.raw;
    if (!isObject(row)) continue;
    if (row['type'] !== 'assistant') continue;

    const ts = getString(row, 'timestamp');
    const sessionId = getString(row, 'sessionId');
    const cwd = getString(row, 'cwd');
    if (!ts || !sessionId || !cwd) continue;

    const message = row['message'];
    if (!isObject(message)) continue;

    const content = message['content'];
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (!isObject(item)) continue;
      if (item['type'] !== 'tool_use') continue;

      const name = getString(item, 'name');
      if (!name) continue;

      const input = item['input'];
      const event = extractFromToolUse(name, input, ts, sessionId, cwd);
      if (event) {
        events.push(event);
      } else {
        // tool_use that doesn't match Skill/mcp__/Agent/Task → skip
        skippedToolUseCount++;
      }
    }
  }

  return { events, skippedToolUseCount };
}

function extractFromToolUse(
  name: string,
  input: unknown,
  ts: string,
  sessionId: string,
  cwd: string,
): UsageEvent | null {
  // --- Skill ---
  if (name === 'Skill') {
    const skillName = isObject(input) ? getString(input, 'skill') : undefined;
    if (!skillName) return null;
    return { ts, kind: 'skill', ref: skillName, sessionId, cwd };
  }

  // --- mcp__ tool ---
  if (name.startsWith('mcp__')) {
    // name.slice(5) removes 'mcp__' prefix
    // split('__') gives [server, ...toolParts]
    const parts = name.slice(5).split('__');
    if (parts.length < 2) return null; // malformed: no tool part
    const server = parts[0];
    const tool = parts.slice(1).join('__');
    if (!server || !tool) return null;
    return { ts, kind: 'mcp-tool', ref: server, tool, sessionId, cwd };
  }

  // --- Agent / Task ---
  if (name === 'Agent' || name === 'Task') {
    const subagentType = isObject(input)
      ? (getString(input, 'subagent_type') ?? 'general-purpose')
      : 'general-purpose';
    return { ts, kind: 'agent', ref: subagentType, sessionId, cwd };
  }

  // Not a tracked tool
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
