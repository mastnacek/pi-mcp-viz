/**
 * Token + document accounting tests.
 *
 * The KB payloads are the real shapes produced by kb_search and kb_read_source
 * (see the knowledge-base MCP server), including the gateway wrapper where the
 * real payload hides inside content[0].text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTool } from "../src/mcp.js";
import {
	analyzeResult,
	composeMetaLine,
	estimateTokensFromText,
	fmtMs,
	fmtTokens,
	resultTexts,
	summarizeArgs,
	unwrapPayload,
} from "../src/tokens.js";
import type { McpTarget } from "../src/types.js";

const KB: McpTarget = {
	server: "knowledge_base",
	badge: "KB",
	tool: "kb_search",
	rawTool: "knowledge_base_kb_search",
	via: "prefix",
	knowledgeBase: true,
};

const OTHER: McpTarget = {
	server: "openrouter",
	badge: "OR",
	tool: "list-models",
	rawTool: "openrouter_list-models",
	via: "prefix",
	knowledgeBase: false,
};

function toolResult(text: string) {
	return { content: [{ type: "text", text }] };
}

function kbSearchPayload(chunks: string[]) {
	return JSON.stringify({
		collection: "lotus-notes",
		query: "NotesDocument GetItemValue",
		total_chunks: 38736,
		elapsed: 0.94,
		results: chunks.map((text, index) => ({
			text,
			source_file: `C:\\kb\\doc_${index}.html`,
			chunk_type: "html",
			page_title: "GetItemValue (NotesDocument)",
			section_title: index === 0 ? "Usage" : "Examples",
			line_number: "",
			relevance: index === 0 ? 1 : 0.9,
		})),
	});
}

test("estimate + format helpers", () => {
	assert.equal(estimateTokensFromText(""), 0);
	assert.equal(estimateTokensFromText("abcd"), 1);
	assert.equal(estimateTokensFromText("abcde"), 2); // ceil(5/4)

	assert.equal(fmtTokens(842), "842");
	assert.equal(fmtTokens(1337), "1.3k");
	assert.equal(fmtTokens(12_400), "12k");
	assert.equal(fmtTokens(2_500_000), "2.5M");

	assert.equal(fmtMs(842), "842ms");
	assert.equal(fmtMs(1337), "1.3s");
	assert.equal(fmtMs(65_000), "1m05s");
});

test("kb_search results are counted per document", () => {
	const chunks = ["a".repeat(800), "b".repeat(400), "c".repeat(40)];
	const analysis = analyzeResult(KB, toolResult(kbSearchPayload(chunks)));

	assert.equal(analysis.docs, 3);
	assert.equal(analysis.resultSummary, "3 hits");
	assert.equal(analysis.docTokens, 200 + 100 + 10);
	assert.deepEqual(analysis.collections, ["lotus-notes"]);
	assert.equal(analysis.hits.length, 3);
	assert.equal(analysis.hits[0]?.title, "Usage — GetItemValue (NotesDocument)");
	assert.equal(analysis.hits[0]?.tokens, 200);
	assert.equal(analysis.hits[0]?.relevance, 1);
	assert.equal(analysis.hits[0]?.chunkType, "html");
});

test("kb_read_source counts one whole document", () => {
	const payload = JSON.stringify({
		collection: "lotus-notes",
		source_file: "C:\\kb\\doc_1.html",
		resolved_source_file: "C:\\Users\\x\\.claude\\mcp\\knowledge-base\\references\\doc_1.html",
		chunk_type: "html",
		bytes: 9878,
		chars: 4443,
		truncated: false,
		text: "d".repeat(4443),
	});
	const analysis = analyzeResult({ ...KB, tool: "kb_read_source" }, toolResult(payload));

	assert.equal(analysis.docs, 1);
	assert.equal(analysis.resultSummary, "1 doc");
	assert.equal(analysis.docTokens, Math.ceil(4443 / 4));
	assert.equal(analysis.hits[0]?.chars, 4443);
});

test("gateway wrapper is unwrapped before accounting", () => {
	const inner = { content: [{ type: "text", text: kbSearchPayload(["x".repeat(400)]) }] };
	const outer = toolResult(JSON.stringify(inner));
	const analysis = analyzeResult(KB, outer);

	assert.equal(analysis.docs, 1);
	assert.equal(analysis.docTokens, 100);
	// The whole envelope still counts as payload.
	assert.ok(analysis.payloadTokens > analysis.docTokens);
});

test("non-KB MCP servers count the payload", () => {
	const analysis = analyzeResult(OTHER, toolResult(JSON.stringify({ data: [{ id: "x" }] }).padEnd(400, " ")));
	assert.equal(analysis.docs, 1);
	assert.equal(analysis.resultSummary, "payload");
	assert.equal(analysis.docTokens, analysis.payloadTokens);
	assert.equal(analysis.collections.length, 0);
});

test("malformed or empty results degrade gracefully", () => {
	assert.deepEqual(analyzeResult(KB, { content: [] }), {
		payloadTokens: 0,
		docTokens: 0,
		docs: 0,
		collections: [],
		hits: [],
		resultSummary: undefined,
	});

	const broken = analyzeResult(KB, toolResult("not json at all"));
	assert.equal(broken.docs, 1);
	assert.equal(broken.hits.length, 0);

	assert.deepEqual(resultTexts(undefined), []);
	assert.equal(unwrapPayload("[1,2,3]")?.constructor, Array);
	assert.equal(unwrapPayload("Nope"), undefined);
});

test("argument summary picks the meaningful keys", () => {
	// Default: one primary argument, so the card never shows "query ·…".
	assert.equal(
		summarizeArgs({ collection: "lotus-notes", query: "GetItemValue array", n: 3 }),
		"GetItemValue array",
	);
	assert.equal(
		summarizeArgs({ collection: "lotus-notes", query: "GetItemValue array" }, 72, 2),
		"GetItemValue array · lotus-notes",
	);
	assert.equal(summarizeArgs("plain"), "plain");
	assert.equal(summarizeArgs({}), "");
	assert.equal(summarizeArgs({ path: "C:\\very\\long\\" + "x".repeat(200) }).length <= 73, true);
});

test("meta line combines docs, tokens and duration", () => {
	const line = composeMetaLine({
		id: "1",
		target: KB,
		startedAt: 0,
		argsSummary: "",
		payloadTokens: 1500,
		docTokens: 1334,
		docs: 3,
		collections: ["lotus-notes"],
		hits: [],
		durationMs: 940,
	});
	assert.equal(line, "3 docs · 1.3k tok · 1.5k tok in · lotus-notes · 940ms");
});

test("classify + analyze work end to end for a real tool name", () => {
	const target = classifyTool("knowledge_base_kb_search", ["knowledge_base"]);
	assert.ok(target);
	const analysis = analyzeResult(target, toolResult(kbSearchPayload(["y".repeat(1600)])));
	assert.equal(analysis.docs, 1);
	assert.equal(analysis.hits[0]?.tokens, 400);
});
