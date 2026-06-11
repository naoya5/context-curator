// types.ts — shared data model (DESIGN.md §3)
export type AssetKind =
  | 'skill' | 'mcp-server' | 'claude-md' | 'memory' | 'command' | 'agent';

export type AssetScope = 'user' | 'project' | 'plugin';

export interface Asset {
  id: string;             // `${kind}:${name}` をベースに一意化（重複時はパスを付加）
  kind: AssetKind;
  name: string;           // skill名 / mcp server名 / ファイル名
  path: string;           // 絶対パス（mcp-server は定義元 JSON のパス）
  scope: AssetScope;
  sizeBytes: number;
  /** 常時ロード分の推定トークン */
  footprintTokens: number;
  /** 呼び出し時にロードされる全文の推定トークン */
  fullTokens: number;
  modifiedAt: string;     // ISO8601
  meta?: Record<string, unknown>; // skill の description、mcp の command 等
}

export interface UsageEvent {
  ts: string;             // ISO8601
  kind: 'skill' | 'mcp-tool' | 'agent';
  ref: string;            // skill名 / mcp server名 / subagent_type
  tool?: string;          // mcp の場合の tool 名
  sessionId: string;
  cwd: string;
}

export interface UsageStats {
  ref: string;
  kind: UsageEvent['kind'];
  count: number;
  lastUsed: string | null;
  projects: string[];
}

export type FindingType = 'stale' | 'unused' | 'bloated' | 'zombie';

export interface Finding {
  asset: Asset;
  type: FindingType;
  reason: string;
  severity: 'info' | 'warn' | 'high';
  suggestion: string;
}

export interface Inventory {
  assets: Asset[];
  scannedAt: string;      // ISO8601
  warnings: string[];     // parse 失敗等
}
