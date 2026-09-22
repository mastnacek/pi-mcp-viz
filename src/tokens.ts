/**
 * Token accounting for MCP results.
 *
 * The counter answers "how much did this MCP call actually pull in?". Two
 * numbers are tracked per call:
 *
 *   payloadTokens — every text byte the tool returned
 *   docTokens     — only the documents themselves (KB chunks / a whole file)
 *
 * Estimation uses pi's own chars/4 heuristic (`estimateTokens` in
 * core/compaction), reimplemented here for plain strings so the plugin does not
 * have to fabricate an AgentMessage. It is conservative — it overestimates.
 */

import type { DocHit, McpCallRecord, McpTarget } from "./types.js";

/** Anything JSON.parse can produce — the shape we parse tool payloads into. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A parsed JSON object payload. */
export type JsonObject = { [key: string]: JsonValue };

/** Type guard for parsed JSON objects. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pi's own heuristic: chars / 4, rounded up. */
export function estimateTokensFromText(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/** Human token count: 842 → "842", 1337 → "1.3k", 12000 → "12k". */
export function fmtTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Human duration: 842 → "842ms", 1337 → "1.3s", 65000 → "1m05s". */
export function fmtMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Thousands separator that stays ASCII-safe in narrow terminals. */
export function fmtInt(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** One space-joined, length-capped line fragment. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

interface ContentPart {
	type?: string;
	text?: string;
}

/** Collect the text of every content part in a tool result. */
export function resultTexts(result: unknown): string[] {
	if (!result || typeof result !== "object") return [];
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const part of content as ContentPart[]) {
		if (part && typeof part === "object" && typeof part.text === "string") {
			texts.push(part.text);
		}
	}
	return texts;
}

/**
 * MCP results often arrive wrapped: the gateway tool returns
 * `content[0].text` = JSON of `{ content: [{ text: "<real payload>" }] }`.
 * Unwrap until a JSON object that is not just another content envelope, so
 * document accounting sees the real payload.
 */
export function unwrapPayload(text: string): JsonValue | undefined {
	let current: JsonValue | undefined = safeJson(text);
	for (let depth = 0; depth < 4; depth += 1) {
		if (!isJsonObject(current)) break;
		const content = current.content;
		if (!Array.isArray(content) || content.length === 0) break;
		const first = content[0];
		if (!isJsonObject(first) || typeof first.text !== "string") break;
		const next = safeJson(first.text);
		if (next === undefined) break;
		current = next;
	}
	return current;
}

function safeJson(text: string): JsonValue | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as JsonValue;
	} catch {
		return undefined;
	}
}

/** Arguments worth showing on the collapsed line, most specific first. */
const ARG_KEYS = [
	"query",
	"source_file",
	"path",
	"url",
	"slug",
	"model",
	"collection",
	"message",
	"prompt",
	"command",
	"name",
	"id",
	"input",
] as const;

/**
 * Render tool arguments as one readable line.
 *
 * Defaults to the single most specific argument (the query, the path, the URL):
 * joining several keys produced lines like “query ·…”, which read as truncation
 * noise. Pass `maxParts` to include more (the expanded card does).
 */
export function summarizeArgs(args: unknown, max = 72, maxParts = 1): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return clip(args, max);
	if (typeof args !== "object") return clip(String(args), max);

	const record = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ARG_KEYS) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		let rendered: string;
		if (typeof value === "string") rendered = value;
		else if (Array.isArray(value)) rendered = value.join(", ");
		else rendered = JSON.stringify(value) ?? String(value);
		parts.push(clip(rendered, max));
		if (parts.length >= maxParts) break;
	}
	if (parts.length === 0) {
		const keys = Object.keys(record);
		if (keys.length === 0) return "";
		parts.push(clip(keys.join(", "), max));
	}
	return clip(parts.join(" · "), max);
}

function asNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function titleOf(entry: JsonObject): string {
	const page = asString(entry.page_title) ?? "";
	const section = asString(entry.section_title) ?? "";
	const symbol = asString(entry.symbol_name) ?? "";
	if (section && page && !page.startsWith(section)) return `${section} — ${clip(page, 48)}`;
	if (section) return clip(section, 72);
	if (symbol) return clip(symbol, 72);
	const source = asString(entry.source_file) ?? asString(entry.resolved_source_file) ?? "";
	const base = source.split(/[\\/]/).pop() ?? "";
	return clip(base || "document", 72);
}

/** Document-level accounting for one parsed KB payload. */
function kbDocsFrom(payload: JsonObject): { hits: DocHit[]; collections: string[] } {
	const collection = asString(payload.collection);
	const results = payload.results;

	// kb_search: one document per result
	if (Array.isArray(results)) {
		const hits: DocHit[] = [];
		for (const raw of results) {
			if (!isJsonObject(raw)) continue;
			const text = asString(raw.text) ?? asString(raw.full_text) ?? "";
			hits.push({
				title: titleOf(raw),
				tokens: estimateTokensFromText(text),
				chars: text.length,
				collection,
				relevance: asNumber(raw.relevance),
				chunkType: asString(raw.chunk_type),
			});
		}
		return { hits, collections: collection ? [collection] : [] };
	}

	// kb_read_source: the whole document
	const whole = asString(payload.text);
	if (whole !== undefined) {
		const hits: DocHit[] = [
			{
				title: titleOf(payload),
				tokens: estimateTokensFromText(whole),
				chars: asNumber(payload.chars) ?? whole.length,
				collection,
				chunkType: asString(payload.chunk_type),
			},
		];
		return { hits, collections: collection ? [collection] : [] };
	}

	return { hits: [], collections: collection ? [collection] : [] };
}

export interface CallAnalysis {
	payloadTokens: number;
	docTokens: number;
	docs: number;
	collections: string[];
	hits: DocHit[];
	resultSummary?: string;
}

/**
 * Turn a raw tool result into token/document accounting.
 *
 * Non-KB servers get the payload counted as one "document" so the status line
 * and cards stay informative for openrouter/metaculus/... too.
 */
export function analyzeResult(target: McpTarget, result: unknown): CallAnalysis {
	const texts = resultTexts(result);
	const payloadTokens = texts.reduce((sum, text) => sum + estimateTokensFromText(text), 0);

	// The payload may be nested (gateway) — try every text part for a KB shape.
	let payload: JsonValue | undefined;
	for (const text of texts) {
		const unwrapped = unwrapPayload(text);
		if (isJsonObject(unwrapped)) {
			payload = unwrapped;
			break;
		}
	}

	const named = target.knowledgeBase || target.tool.includes("kb_");
	if (isJsonObject(payload) && named) {
		const { hits, collections } = kbDocsFrom(payload);
		if (hits.length > 0) {
			const docTokens = hits.reduce((sum, hit) => sum + hit.tokens, 0);
			return {
				payloadTokens,
				docTokens,
				docs: hits.length,
				collections,
				hits,
				resultSummary: hits.length === 1 ? "1 doc" : `${hits.length} hits`,
			};
		}
	}

	return {
		payloadTokens,
		docTokens: payloadTokens,
		docs: payloadTokens > 0 ? 1 : 0,
		collections: [],
		hits: [],
		resultSummary: payloadTokens > 0 ? "payload" : undefined,
	};
}

/** Human label for the "documents" number: KB reads documents, others payloads. */
export function docUnit(target: McpTarget): string {
	return target.knowledgeBase ? "doc" : "payload";
}

/** Second line of the card: docs + tokens + duration. */
export function composeMetaLine(record: McpCallRecord): string {
	const parts: string[] = [];
	if (record.docs > 0) {
		parts.push(`${record.docs} ${docUnit(record.target)}${record.docs === 1 ? "" : "s"}`);
	}
	parts.push(`${fmtTokens(record.docTokens)} tok`);
	if (record.payloadTokens > record.docTokens) parts.push(`${fmtTokens(record.payloadTokens)} tok in`);
	if (record.collections.length > 0) parts.push(record.collections.join(", "));
	if (record.durationMs !== undefined) parts.push(fmtMs(record.durationMs));
	return parts.join(" · ");
}
