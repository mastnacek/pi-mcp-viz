/**
 * Variant 1 — the transcript card.
 *
 * Rendered through `pi.registerEntryRenderer()`, so it is durable, sits inline
 * in the conversation like a tool row, and never reaches the model's context.
 *
 *   ▸ KB  kb_search · "NotesDocument GetItemValue"          3 hits · 1.3k tok · 0.9s
 *     📚 3 docs · 1 334 tok · lotus-notes
 *
 * Expanded adds the arguments and the per-document breakdown. The stored entry
 * carries the detail settings from call time, so old cards keep rendering as
 * they did when they were written.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { clip, docUnit, fmtInt, fmtMs, fmtTokens } from "../tokens.js";
import type { McpCallRecord } from "../types.js";

/** What `pi.appendEntry(CALL_ENTRY_TYPE, payload)` stores. */
export interface CallEntryPayload {
	record: McpCallRecord;
	detail: 0 | 1 | 2;
	maxHits: number;
}

function headerLine(record: McpCallRecord, theme: Theme): string {
	const badge = record.target.knowledgeBase
		? theme.bg("selectedBg", theme.fg("accent", ` ${record.target.badge} `))
		: theme.fg("muted", `[${record.target.badge}]`);

	const status = record.isError ? theme.fg("error", " ✗") : "";
	const head = `▸ ${badge} ${theme.fg("toolTitle", record.target.tool)}${status}`;

	let tail = "";
	if (record.resultSummary) tail += ` ${record.resultSummary}`;
	tail += ` · ${fmtTokens(record.docTokens)} tok`;
	if (record.durationMs !== undefined) tail += ` · ${fmtMs(record.durationMs)}`;

	const args = record.argsSummary ? ` ${theme.fg("dim", `“${clip(record.argsSummary, 46)}”`)}` : "";
	return `${head}${args}${theme.fg("dim", tail)}`;
}

function metaLine(record: McpCallRecord, theme: Theme): string {
	const parts: string[] = [];
	if (record.docs > 0) {
		const unit = docUnit(record.target);
		parts.push(`${fmtInt(record.docs)} ${unit}${record.docs === 1 ? "" : "s"}`);
	}
	parts.push(`${fmtInt(record.docTokens)} tok`);
	if (record.collections.length > 0) parts.push(record.collections.join(", "));
	return theme.fg("dim", `  ${record.target.knowledgeBase ? "📚" : "·"} ${parts.join(" · ")}`);
}

function hitLine(hit: { title: string; tokens: number; relevance?: number }, theme: Theme): string {
	const relevance = hit.relevance === undefined ? "" : theme.fg("success", ` ${hit.relevance.toFixed(2)}`);
	return `    ${theme.fg("text", hit.title)}${relevance} ${theme.fg("dim", `${fmtTokens(hit.tokens)} tok`)}`;
}

/** Build the card component for one stored call. */
export function renderCallEntry(payload: CallEntryPayload, expanded: boolean, theme: Theme) {
	const { record } = payload;
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(headerLine(record, theme), 0, 0));

	if (record.docs > 0) box.addChild(new Text(metaLine(record, theme), 0, 0));

	// Detail 1 shows the documents even collapsed: that is the point of the
	// plugin for the KB — seeing which documents came back.
	const showHits = expanded || payload.detail >= 1;
	if (showHits) {
		for (const hit of record.hits.slice(0, payload.maxHits)) {
			box.addChild(new Text(hitLine(hit, theme), 0, 0));
		}
		const hidden = record.hits.length - payload.maxHits;
		if (hidden > 0) box.addChild(new Text(theme.fg("dim", `    … +${hidden} more`), 0, 0));
	}

	if (expanded && record.args && typeof record.args === "object") {
		const rendered = JSON.stringify(record.args);
		box.addChild(new Text(theme.fg("dim", `    args ${clip(rendered, 96)}`), 0, 0));
	}

	return box;
}
