/**
 * Visual rendering tests for all three variants.
 *
 * Components are rendered to plain strings, so the exact card and modal output
 * is asserted without a terminal: what the user sees is what this test reads.
 * The theme is an identity stub — colours are not the subject here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CallEntryPayload } from "../src/visuals/entry.js";
import { renderCallEntry } from "../src/visuals/entry.js";
import { McpModalCard } from "../src/visuals/modal.js";
import { composeDoneStatus, composeLiveStatus } from "../src/visuals/status.js";
import type { McpCallRecord, SessionTotals } from "../src/types.js";

// SAFETY: the renderers only call theme.fg/theme.bg; an identity stub satisfies
// that contract without pulling a real theme out of the running TUI.
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const RECORD: McpCallRecord = {
	id: "call-1",
	target: {
		server: "knowledge_base",
		badge: "KB",
		tool: "kb_search",
		rawTool: "knowledge_base_kb_search",
		via: "prefix",
		knowledgeBase: true,
	},
	startedAt: Date.now() - 940,
	endedAt: Date.now(),
	durationMs: 940,
	argsSummary: "NotesDocument GetItemValue array",
	args: { collection: "lotus-notes", query: "NotesDocument GetItemValue array", n: 3 },
	payloadTokens: 1500,
	docTokens: 1334,
	docs: 3,
	collections: ["lotus-notes"],
	resultSummary: "3 hits",
	hits: [
		{ title: "Usage — GetItemValue (NotesDocument)", tokens: 800, chars: 3200, relevance: 1 },
		{ title: "Examples", tokens: 434, chars: 1736, relevance: 0.9 },
		{ title: "Values property", tokens: 100, chars: 400, relevance: 0.8 },
	],
};

const PAYLOAD: CallEntryPayload = { record: RECORD, detail: 1, maxHits: 5 };

test("entry card: collapsed line shows server, tool, hits and tokens", () => {
	const card = renderCallEntry(PAYLOAD, false, theme);
	const lines = card.render(100);
	const text = lines.join("\n");

	assert.match(text, /KB/);
	assert.match(text, /kb_search/);
	assert.match(text, /NotesDocument GetItemValue array/);
	assert.match(text, /3 hits/);
	assert.match(text, /1\.3k tok/);
	assert.match(text, /940ms/);
	assert.match(text, /lotus-notes/);
	// detail 1 shows the documents even collapsed
	assert.match(text, /Usage — GetItemValue/);
});

test("entry card: respects terminal width and maxHits", () => {
	for (const width of [48, 80, 120]) {
		const lines = renderCallEntry(PAYLOAD, false, theme).render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	}

	const limited: CallEntryPayload = { record: RECORD, detail: 1, maxHits: 2 };
	const text = renderCallEntry(limited, false, theme).render(100).join("\n");
	assert.match(text, /\+1 more/);
});

test("entry card: expanded adds the arguments", () => {
	const text = renderCallEntry(PAYLOAD, true, theme).render(100).join("\n");
	assert.match(text, /args \{/);
	assert.match(text, /lotus-notes/);
});

test("entry card: errors are marked", () => {
	const failing: CallEntryPayload = {
		record: { ...RECORD, isError: true, docs: 0, hits: [], docTokens: 0 },
		detail: 0,
		maxHits: 5,
	};
	const text = renderCallEntry(failing, false, theme).render(100).join("\n");
	assert.match(text, /✗/);
});

test("modal card: framed, informative and width-safe", () => {
	const card = new McpModalCard(theme, RECORD, {
		delayMs: 5000,
		maxHits: 5,
		onDone: () => {},
		requestRender: () => {},
	});
	const lines = card.render(100);
	const text = lines.join("\n");

	assert.match(text, /╭/);
	assert.match(text, /╰/);
	assert.match(text, /MCP/);
	assert.match(text, /KB/);
	assert.match(text, /kb_search/);
	assert.match(text, /3 hits/);
	assert.match(text, /Usage — GetItemValue/);
	assert.match(text, /Esc/);
	// Every line of the frame must be exactly the same visible width — the
	// sidebar-style border is the first thing a misaligned width breaks.
	const widths = new Set(lines.map((line) => visibleWidth(line)));
	assert.equal(widths.size, 1, `uneven modal frame: ${[...widths].join(",")}`);
	assert.equal([...widths][0], 68); // MAX_WIDTH, terminal is wide enough
	card.dispose();
});

test("modal card: dismisses itself after the delay", async () => {
	let done = 0;
	const card = new McpModalCard(theme, RECORD, {
		delayMs: 120,
		maxHits: 5,
		onDone: () => {
			done += 1;
		},
		requestRender: () => {},
	});

	assert.match(card.render(100).join("\n"), /Esc/);
	await new Promise((resolve) => setTimeout(resolve, 260));
	assert.equal(done, 1);
	// A second dismissal must not fire twice.
	card.handleInput();
	assert.equal(done, 1);
	card.dispose();
});

test("modal card: any key dismisses immediately", () => {
	let done = 0;
	const card = new McpModalCard(theme, RECORD, {
		delayMs: 60_000,
		maxHits: 5,
		onDone: () => {
			done += 1;
		},
		requestRender: () => {},
	});
	card.handleInput();
	assert.equal(done, 1);
	card.dispose();
});

test("status variant: live line while running, summary afterwards", () => {
	const live = composeLiveStatus([{ ...RECORD, startedAt: Date.now() - 1200 }]);
	assert.match(live, /📚 KB kb_search… 1\.2s/);
	assert.equal(composeLiveStatus([]), "");

	const totals: SessionTotals = {
		calls: 7,
		errors: 0,
		payloadTokens: 20_000,
		docTokens: 12_400,
		docs: 21,
		kbDocs: 21,
		kbDocTokens: 12_400,
		byServer: {},
	};
	const done = composeDoneStatus(RECORD, totals);
	assert.match(done, /📚 KB 3 docs · 1\.3k tok · 940ms/);
	assert.match(done, /session 7 calls 12k tok/);
	assert.match(done, /\(12k KB\)/);

	const first = composeDoneStatus(RECORD);
	assert.equal(first.includes("session"), false);

	const failed = composeDoneStatus({ ...RECORD, isError: true, docs: 0 });
	assert.match(failed, /⚠ KB failed/);

	const other = composeDoneStatus({
		...RECORD,
		target: { ...RECORD.target, knowledgeBase: false, badge: "OR", server: "openrouter" },
	});
	assert.match(other, /🔌 OR 3 payloads/);
});
