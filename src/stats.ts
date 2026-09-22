/**
 * Session state for pi-mcp-viz.
 *
 * Two kinds of state live here:
 *   - in-flight calls (toolCallId → record), so an end event can be matched and
 *     summarized even when several MCP calls run in parallel
 *   - cumulative totals, persisted as a custom entry so `/reload`, branch
 *     navigation and resume all rebuild the same numbers
 */

import type { McpCallRecord, ServerTotals, SessionTotals } from "./types.js";

/** Custom entry type for persisted totals — no renderer, so it stays hidden. */
export const STATS_ENTRY_TYPE = "mcp-viz-stats";

/** Custom entry type for the rendered cards (variant 1). */
export const CALL_ENTRY_TYPE = "mcp-viz-call";

export function emptyServerTotals(): ServerTotals {
	return { calls: 0, errors: 0, payloadTokens: 0, docTokens: 0, docs: 0, durationMs: 0 };
}

export function emptyTotals(): SessionTotals {
	return {
		calls: 0,
		errors: 0,
		payloadTokens: 0,
		docTokens: 0,
		docs: 0,
		kbDocs: 0,
		kbDocTokens: 0,
		byServer: {},
	};
}

/** Fold one finished call into the running totals (mutates `totals`). */
export function accumulate(totals: SessionTotals, record: McpCallRecord): void {
	const server = record.target.server;
	const per = totals.byServer[server] ?? emptyServerTotals();
	per.calls += 1;
	if (record.isError) per.errors += 1;
	per.payloadTokens += record.payloadTokens;
	per.docTokens += record.docTokens;
	per.docs += record.docs;
	per.durationMs += record.durationMs ?? 0;
	totals.byServer[server] = per;

	totals.calls += 1;
	if (record.isError) totals.errors += 1;
	totals.payloadTokens += record.payloadTokens;
	totals.docTokens += record.docTokens;
	totals.docs += record.docs;
	if (record.target.knowledgeBase) {
		totals.kbDocs += record.docs;
		totals.kbDocTokens += record.docTokens;
	}
}

interface CustomEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isServerTotals(value: unknown): value is ServerTotals {
	const record = value as Partial<ServerTotals> | null;
	return typeof record?.calls === "number";
}

/**
 * Rebuild totals from session entries.
 *
 * Reads the branch (`getBranch()`), not all entries: after /tree navigation the
 * numbers must describe the conversation the user is actually on. The last
 * persisted snapshot wins — it already contains everything before it.
 */
export function restoreTotals(entries: readonly CustomEntryLike[], entryType = STATS_ENTRY_TYPE): SessionTotals {
	let totals = emptyTotals();
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== entryType) continue;
		const data = entry.data as Partial<SessionTotals> | null;
		if (!data || typeof data.calls !== "number") continue;
		const byServer: Record<string, ServerTotals> = {};
		for (const [server, value] of Object.entries(data.byServer ?? {})) {
			if (isServerTotals(value)) byServer[server] = { ...emptyServerTotals(), ...value };
		}
		totals = {
			...emptyTotals(),
			...data,
			byServer,
		};
	}
	return totals;
}

/** In-flight call registry with a hard cap, so a lost end event cannot leak. */
export class PendingCalls {
	private readonly calls = new Map<string, McpCallRecord>();
	private readonly max: number;

	constructor(max = 64) {
		this.max = max;
	}

	start(record: McpCallRecord): void {
		if (this.calls.size >= this.max) {
			const oldest = this.calls.keys().next().value;
			if (oldest !== undefined) this.calls.delete(oldest);
		}
		this.calls.set(record.id, record);
	}

	finish(id: string): McpCallRecord | undefined {
		const record = this.calls.get(id);
		if (record !== undefined) this.calls.delete(id);
		return record;
	}

	/**
	 * Fallback lookup when an end event arrives without its start: take the
	 * oldest in-flight call for the same tool. Keeps the arguments (and the real
	 * duration) visible instead of rendering a bare record.
	 */
	takeByTool(toolName: string): McpCallRecord | undefined {
		for (const [id, record] of this.calls) {
			if (record.target.rawTool === toolName) {
				this.calls.delete(id);
				return record;
			}
		}
		return undefined;
	}

	get size(): number {
		return this.calls.size;
	}

	/** Snapshot of in-flight calls, oldest first. */
	list(): McpCallRecord[] {
		return [...this.calls.values()];
	}

	clear(): void {
		this.calls.clear();
	}
}

/** Bounded ring of recent calls, for /mcp-viz tail. */
export class RecentCalls {
	private readonly items: McpCallRecord[] = [];
	private readonly max: number;

	constructor(max = 20) {
		this.max = max;
	}

	push(record: McpCallRecord): void {
		this.items.push(record);
		if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
	}

	list(): McpCallRecord[] {
		return [...this.items];
	}

	clear(): void {
		this.items.length = 0;
	}
}
