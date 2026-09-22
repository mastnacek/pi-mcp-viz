/**
 * Shared types for pi-mcp-viz.
 *
 * Everything the visuals render comes through `McpCallRecord` — a single
 * normalized shape for one MCP tool call, independent of which server it came
 * from. The three visual variants (transcript card, modal, status line) are
 * pure functions of this record plus the config, which is what makes them
 * testable without a terminal.
 */

/** Which server a tool call belongs to, as far as we could tell. */
export interface McpTarget {
	/** Server name from mcp.json, normalized to underscores (knowledge_base). */
	server: string;
	/** Short badge label for tight spaces: KB, OR, LSP, ... */
	badge: string;
	/** Tool name without the server prefix (kb_search). */
	tool: string;
	/** Full tool name as pi reported it (knowledge_base_kb_search). */
	rawTool: string;
	/** How the match was made — useful in /mcp-viz status output. */
	via: "gateway" | "namespace" | "prefix";
	/** True for the knowledge-base MCP, which gets the document accounting. */
	knowledgeBase: boolean;
}

/** One document that an MCP call pulled in (KB chunk or whole file). */
export interface DocHit {
	title: string;
	/** Tokens estimated for this document's text. */
	tokens: number;
	chars: number;
	collection?: string;
	relevance?: number;
	chunkType?: string;
}

/** One completed (or in-flight) MCP tool call. */
export interface McpCallRecord {
	id: string;
	target: McpTarget;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	isError?: boolean;
	/** One-line rendering of the arguments (query, collection, URL, ...). */
	argsSummary: string;
	/** Raw arguments, kept for the expanded view. */
	args?: unknown;
	/** Tokens in the whole tool result payload. */
	payloadTokens: number;
	/** Tokens in the documents the call returned. */
	docTokens: number;
	/** How many documents the call returned. */
	docs: number;
	/** KB collections touched by this call. */
	collections: string[];
	hits: DocHit[];
	/** Human tail for the collapsed line: "3 hits", "1 doc", "12 models". */
	resultSummary?: string;
}

/** Per-server running totals for the session. */
export interface ServerTotals {
	calls: number;
	errors: number;
	payloadTokens: number;
	docTokens: number;
	docs: number;
	durationMs: number;
}

/** Session totals, persisted as a custom entry (never sent to the model). */
export interface SessionTotals {
	calls: number;
	errors: number;
	payloadTokens: number;
	docTokens: number;
	docs: number;
	/** KB-specific: how many documents the knowledge base returned. */
	kbDocs: number;
	kbDocTokens: number;
	byServer: Record<string, ServerTotals>;
}

export type VariantName = "entry" | "modal" | "status";

export interface McpVizConfig {
	enabled: boolean;
	variants: Record<VariantName, boolean>;
	/** How long the modal stays before it dismisses itself. */
	modalDelayMs: number;
	/** How long the status badge stays after the call finished. */
	statusTtlMs: number;
	/** Live status while a call is running. */
	liveStatus: boolean;
	/** Only these servers (empty = all detected MCP servers). */
	includeServers: string[];
	/** Never these servers. */
	excludeServers: string[];
	/** Append a JSONL trace to ~/.pi/agent/mcp-viz.log (also used headless). */
	logToFile: boolean;
	/** Card detail level: 0 compact, 1 show hits, 2 show args + hits. */
	detail: 0 | 1 | 2;
	/** How many hits the card/modal lists. */
	maxHits: number;
}
