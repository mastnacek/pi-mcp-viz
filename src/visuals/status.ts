/**
 * Variant 3 — the status line.
 *
 * One dim line in the footer, not a transcript row: it is meant to be readable
 * at a glance while the agent works and to disappear by itself afterwards.
 *
 *   📚 KB kb_search searching… 1.2s
 *   📚 KB 3 docs · 1.3k tok · 0.9s · session 7 calls 12.4k tok
 *
 * Both composers are pure, so the exact wording is unit-tested.
 */

import { fmtInt, fmtMs, fmtTokens } from "../tokens.js";
import type { McpCallRecord, SessionTotals } from "../types.js";

export const STATUS_KEY = "mcp-viz";

/** Icon per target: the KB gets the book, everything else the plug. */
export function iconFor(record: McpCallRecord): string {
	if (record.isError) return "⚠";
	return record.target.knowledgeBase ? "📚" : "🔌";
}

/** Live line while one or more MCP calls are in flight. */
export function composeLiveStatus(active: readonly McpCallRecord[], now = Date.now()): string {
	if (active.length === 0) return "";
	if (active.length > 1) {
		const names = active.map((call) => call.target.badge).join("+");
		const oldest = Math.min(...active.map((call) => call.startedAt));
		return `🔌 ${names} ${active.length} calls… ${fmtMs(now - oldest)}`;
	}
	const call = active[0];
	if (call === undefined) return "";
	const elapsed = fmtMs(now - call.startedAt);
	const label = call.target.knowledgeBase ? "KB" : call.target.badge;
	return `${iconFor(call)} ${label} ${call.target.tool}… ${elapsed}`;
}

/** Finished line: this call, plus the session counter when it is worth showing. */
export function composeDoneStatus(record: McpCallRecord, totals?: SessionTotals): string {
	const label = record.target.knowledgeBase ? "KB" : record.target.badge;
	const parts: string[] = [];

	if (record.isError) {
		parts.push("failed");
	} else if (record.docs > 0) {
		const unit = record.target.knowledgeBase ? "doc" : "payload";
		parts.push(`${fmtInt(record.docs)} ${unit}${record.docs === 1 ? "" : "s"}`);
	}
	parts.push(`${fmtTokens(record.docTokens)} tok`);
	if (record.durationMs !== undefined) parts.push(fmtMs(record.durationMs));

	let line = `${iconFor(record)} ${label} ${parts.join(" · ")}`;

	if (totals && totals.calls > 1) {
		line += ` · session ${fmtInt(totals.calls)} calls ${fmtTokens(totals.docTokens)} tok`;
		if (totals.kbDocTokens > 0) line += ` (${fmtTokens(totals.kbDocTokens)} KB)`;
	}
	return line;
}
