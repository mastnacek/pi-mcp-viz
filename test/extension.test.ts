/**
 * End-to-end wiring test.
 *
 * Drives the real extension with a mock ExtensionAPI/ExtensionContext: the same
 * handlers pi would call are invoked with the same event shapes, and the visible
 * effects (appended entries, status writes, trace file, modal call) are asserted.
 * This is what proves the plugin does something, not just that it compiles.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import mcpViz, { LOG_ENV } from "../index.js";
import { CONFIG_ENV, DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import { MCP_JSON_ENV, resetServerCache } from "../src/mcp.js";
import { CALL_ENTRY_TYPE, STATS_ENTRY_TYPE } from "../src/stats.js";
import type { CallEntryPayload } from "../src/visuals/entry.js";
import { renderCallEntry } from "../src/visuals/entry.js";

// SAFETY: the card renderers only call theme.fg/theme.bg; an identity stub
// satisfies that contract without a running TUI.
const STUB_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface AppendedEntry {
	customType: string;
	data: unknown;
}

interface Harness {
	pi: ExtensionAPI;
	entries: AppendedEntry[];
	statuses: Array<string | undefined>;
	notifications: Array<{ message: string; type: string }>;
	modalCalls: number;
	emit: (event: string, payload: unknown) => Promise<void>;
	ctx: ExtensionContext;
	renderers: Map<string, (entry: { data: unknown }, options: { expanded: boolean }, theme: Theme) => unknown>;
	setStatusKey: () => string | undefined;
	fire: (command: string, args: string) => Promise<void>;
}

function makeHarness(): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
	const entries: AppendedEntry[] = [];
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const renderers: Harness["renderers"] = new Map();
	let modalCalls = 0;
	let statusKey: string | undefined;

	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus(key: string, value: string | undefined) {
				statusKey = key;
				statuses.push(value);
			},
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			custom() {
				modalCalls += 1;
				return Promise.resolve(undefined);
			},
		},
	};

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
		registerEntryRenderer(customType: string, renderer: Harness["renderers"] extends Map<string, infer R> ? R : never) {
			renderers.set(customType, renderer as never);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		entries,
		statuses,
		notifications,
		get modalCalls() {
			return modalCalls;
		},
		renderers,
		ctx: ctx as unknown as ExtensionContext,
		emit: async (event, payload) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		setStatusKey: () => statusKey,
		fire: async (command, args) => {
			const entry = commands.get(command);
			assert.ok(entry, `command ${command} registered`);
			await entry.handler(args, ctx);
		},
	} as Harness;
}

function kbPayload(chunks = ["z".repeat(800), "y".repeat(400)]) {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					collection: "lotus-notes",
					query: "NotesDocument GetItemValue",
					total_chunks: 38736,
					elapsed: 0.94,
					results: chunks.map((text, index) => ({
						text,
						source_file: `C:\\kb\\doc_${index}.html`,
						chunk_type: "html",
						page_title: "GetItemValue (NotesDocument)",
						section_title: "Usage",
						relevance: 1 - index * 0.05,
					})),
				}),
			},
		],
	};
}

function useTempEnvironment(params: { variants?: Partial<Record<"entry" | "modal" | "status", boolean>> } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "mcp-viz-e2e-"));
	process.env[CONFIG_ENV] = join(dir, "pi-mcp-viz.json");
	process.env[LOG_ENV] = join(dir, "mcp-viz.log");
	const mcpJson = join(dir, "mcp.json");
	writeFileSync(mcpJson, JSON.stringify({ mcpServers: { knowledge_base: {}, openrouter: {} } }), "utf8");
	process.env[MCP_JSON_ENV] = mcpJson;
	// Variants are pinned explicitly so the wiring tests do not depend on which
	// variant the package ships as its default.
	saveConfig({ ...DEFAULT_CONFIG, variants: { entry: true, modal: false, status: true, ...params.variants } });
	resetServerCache();
	return dir;
}

test("the shipped defaults are modal-only with a 3 s delay", () => {
	assert.deepEqual(DEFAULT_CONFIG.variants, { entry: false, modal: true, status: false });
	assert.equal(DEFAULT_CONFIG.modalDelayMs, 3000);
});

test("a KB search produces a card, a status line, totals and a trace", async () => {
	const dir = useTempEnvironment({});
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		await h.emit("session_start", { type: "session_start" });
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "knowledge_base_kb_search",
			args: { collection: "lotus-notes", query: "NotesDocument GetItemValue", n: 3 },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "knowledge_base_kb_search",
			result: kbPayload(),
			isError: false,
		});

		const card = h.entries.find((entry) => entry.customType === CALL_ENTRY_TYPE);
		assert.ok(card, "card entry appended");
		const payload = card.data as CallEntryPayload;
		assert.equal(payload.record.docs, 2);
		assert.equal(payload.record.docTokens, 300);
		assert.equal(payload.record.target.badge, "KB");
		assert.equal(payload.record.collections[0], "lotus-notes");
		assert.ok((payload.record.durationMs ?? -1) >= 0);

		const totalsEntry = h.entries.find((entry) => entry.customType === STATS_ENTRY_TYPE);
		assert.ok(totalsEntry, "totals entry appended");
		const totals = totalsEntry.data as { calls: number; kbDocs: number; kbDocTokens: number };
		assert.equal(totals.calls, 1);
		assert.equal(totals.kbDocs, 2);
		assert.equal(totals.kbDocTokens, 300);

		assert.ok(h.statuses.some((value) => value?.includes("kb_search…")), "live status written");
		assert.ok(
			h.statuses.some((value) => value?.includes("KB") && value?.includes("2 docs")),
			`done status written: ${JSON.stringify(h.statuses)}`,
		);
		assert.equal(h.setStatusKey(), "mcp-viz");

		const trace = readFileSync(join(dir, "mcp-viz.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(trace.at(0)?.event, "session_start");
		assert.equal(trace.at(-1)?.event, "end");
		assert.equal(trace.at(-1)?.record.docs, 2);
		assert.equal(trace.at(-1)?.totals.kbDocs, 2);
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});

test("non-MCP tools are ignored entirely", async () => {
	useTempEnvironment({});
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "ls" },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "lots of output" }] },
			isError: false,
		});
		assert.equal(h.entries.length, 0);
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});

test("the gateway tool and non-KB servers are visualized too", async () => {
	useTempEnvironment({ variants: { entry: true, status: false } });
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "g1",
			toolName: "mcp__knowledge_base",
			args: { name: "kb_read_source", arguments: { source_file: "x.html" } },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "g1",
			toolName: "mcp__knowledge_base",
			result: { content: [{ type: "text", text: JSON.stringify(kbPayload(["w".repeat(400)])) }] },
			isError: false,
		});
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "o1",
			toolName: "openrouter_list-models",
			args: { q: "gemini" },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "o1",
			toolName: "openrouter_list-models",
			result: { content: [{ type: "text", text: "m".repeat(4000) }] },
			isError: false,
		});

		const cards = h.entries.filter((entry) => entry.customType === CALL_ENTRY_TYPE);
		assert.equal(cards.length, 2);
		const first = cards[0];
		const second = cards[1];
		assert.ok(first && second, "both cards appended");
		assert.equal((first.data as CallEntryPayload).record.target.server, "knowledge_base");
		assert.equal((second.data as CallEntryPayload).record.target.server, "openrouter");
		assert.equal((second.data as CallEntryPayload).record.docTokens, 1000);
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});

test("modal variant opens an overlay and the status variant can be disabled", async () => {
	useTempEnvironment({ variants: { entry: false, modal: true, status: false } });
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "m1",
			toolName: "knowledge_base_kb_search",
			args: { query: "x" },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "m1",
			toolName: "knowledge_base_kb_search",
			result: kbPayload(),
			isError: false,
		});
		assert.equal(h.modalCalls, 1);
		assert.equal(
			h.entries.filter((entry) => entry.customType === CALL_ENTRY_TYPE).length,
			0,
			"entry variant is off",
		);
		assert.equal(h.statuses.length, 0, "status variant is off");
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});

test("the registered renderer renders the stored card", async () => {
	useTempEnvironment({});
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		const renderer = h.renderers.get(CALL_ENTRY_TYPE);
		assert.ok(renderer);
		await h.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "knowledge_base_kb_search",
			args: { query: "GetItemValue" },
		});
		await h.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "knowledge_base_kb_search",
			result: kbPayload(),
			isError: false,
		});
		const payload = h.entries.find((entry) => entry.customType === CALL_ENTRY_TYPE)?.data as CallEntryPayload;
		// SAFETY: the renderer returns a pi-tui Component (Box) — render() is part
		// of that interface and is what the TUI itself calls.
		const component = renderer({ data: payload }, { expanded: false }, STUB_THEME) as {
			render: (width: number) => string[];
		};
		const text = component.render(100).join("\n");
		assert.match(text, /kb_search/);
		assert.match(text, /2 docs/);
		// A card built directly from a record must render too (used as fallback
		// when an entry carries no data).
		const fallback = renderCallEntry({ detail: 1, maxHits: 3, record: payload.record }, false, STUB_THEME);
		assert.ok(fallback.render(80).length > 0);
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});

test("/mcp-viz status reports the counters and toggles variants", async () => {
	useTempEnvironment({});
	const h = makeHarness();
	try {
		mcpViz(h.pi);
		await h.fire("mcp-viz", "");
		assert.match(h.notifications.at(-1)?.message ?? "", /MCP activity visualization/);

		await h.fire("mcp-viz", "status");
		assert.match(h.notifications.at(-1)?.message ?? "", /KB only/);

		await h.fire("mcp-viz", "variant modal on");
		await h.fire("mcp-viz", "status");
		assert.match(h.notifications.at(-1)?.message ?? "", /modal\+status/);

		await h.fire("mcp-viz", "off");
		assert.equal(h.notifications.at(-1)?.type, "info");
		assert.match(h.notifications.at(-1)?.message ?? "", /vypnuto/);

		await h.fire("mcp-viz", "banana");
		assert.equal(h.notifications.at(-1)?.type, "warning");
	} finally {
		for (const key of [CONFIG_ENV, LOG_ENV, MCP_JSON_ENV]) delete process.env[key];
	}
});
