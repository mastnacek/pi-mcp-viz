/**
 * pi-mcp-viz — visualize MCP activity in Pi.
 *
 * Nothing here is KB-specific: any server in `~/.pi/agent/mcp.json` is matched,
 * so the knowledge base, openrouter, metaculus and the lotusscript LSP all show
 * up. The KB is simply the case where the returned documents are counted one by
 * one (`docs`), because that is what "how much context did this pull in?" means
 * for a documentation server.
 *
 * Three independent variants, all off/on-able at runtime via /mcp-viz:
 *
 *   1. entry  — durable transcript card (pi.appendEntry + registerEntryRenderer)
 *   2. modal  — floating overlay that dismisses itself after a delay
 *   3. status — one dim footer line, cleared on a timer
 *
 * Events used: tool_execution_start / tool_execution_end (lifecycle, available
 * for every tool including MCP), session_start (restore), session_shutdown
 * (cleanup). No tool is overridden and no tool result is modified.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, saveConfig, serverAllowed } from "./src/config.js";
import { classifyTool, knownServers, resetServerCache } from "./src/mcp.js";
import { CALL_ENTRY_TYPE, PendingCalls, RecentCalls, STATS_ENTRY_TYPE, accumulate, emptyTotals, restoreTotals } from "./src/stats.js";
import { analyzeResult, summarizeArgs } from "./src/tokens.js";
import type { McpCallRecord, McpVizConfig, SessionTotals } from "./src/types.js";
import { registerMcpVizCommand } from "./src/command.js";
import { type CallEntryPayload, renderCallEntry } from "./src/visuals/entry.js";
import { showCallModal } from "./src/visuals/modal.js";
import { STATUS_KEY, composeDoneStatus, composeLiveStatus } from "./src/visuals/status.js";

/** Trace file for headless runs and post-mortems. */
export const LOG_ENV = "PI_MCP_VIZ_LOG";
const LIVE_TICK_MS = 500;

function logPath(): string {
	return process.env[LOG_ENV] ?? join(homedir(), ".pi", "agent", "mcp-viz.log");
}

export default function mcpViz(pi: ExtensionAPI): void {
	let config: McpVizConfig = loadConfig();
	let totals: SessionTotals = emptyTotals();
	const pending = new PendingCalls();
	const recent = new RecentCalls(20);

	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let statusKey = STATUS_KEY;

	const patchConfig = (patch: Partial<McpVizConfig>): McpVizConfig => {
		config = { ...config, ...patch };
		saveConfig(config);
		return config;
	};

	const writeTrace = (payload: Record<string, unknown>): void => {
		if (!config.logToFile) return;
		try {
			const path = logPath();
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
		} catch {
			// Tracing must never break a session.
		}
	};

	const stopLiveTimer = (): void => {
		if (liveTimer !== undefined) {
			clearInterval(liveTimer);
			liveTimer = undefined;
		}
	};

	const refreshLiveStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !config.enabled || !config.variants.status) return;
		const active = pending.list();
		if (active.length === 0) {
			stopLiveTimer();
			return;
		}
		ctx.ui.setStatus(statusKey, composeLiveStatus(active));
		if (liveTimer === undefined && config.liveStatus) {
			liveTimer = setInterval(() => {
				const still = pending.list();
				if (still.length === 0) {
					stopLiveTimer();
					return;
				}
				ctx.ui.setStatus(statusKey, composeLiveStatus(still));
			}, LIVE_TICK_MS);
			liveTimer.unref?.();
		}
	};

	const clearStatusLater = (ctx: ExtensionContext): void => {
		if (statusTimer !== undefined) clearTimeout(statusTimer);
		if (config.statusTtlMs <= 0) return;
		statusTimer = setTimeout(() => {
			if (pending.size === 0) ctx.ui.setStatus(statusKey, undefined);
		}, config.statusTtlMs);
		statusTimer.unref?.();
	};

	// ------------------------------------------------------------ rendering

	pi.registerEntryRenderer<CallEntryPayload>(CALL_ENTRY_TYPE, (entry, { expanded }, theme: Theme) => {
		const payload = entry.data;
		if (!payload || !payload.record) {
			return renderCallEntry(
				{
					detail: 1,
					maxHits: 5,
					record: {
						id: "unknown",
						target: { server: "mcp", badge: "MCP", tool: "call", rawTool: "mcp", via: "gateway", knowledgeBase: false },
						startedAt: Date.now(),
						argsSummary: "(no data)",
						payloadTokens: 0,
						docTokens: 0,
						docs: 0,
						collections: [],
						hits: [],
					},
				},
				expanded,
				theme,
			);
		}
		return renderCallEntry(payload, expanded, theme);
	});

	// ---------------------------------------------------------------- events

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		resetServerCache();
		totals = restoreTotals(ctx.sessionManager.getBranch());
		pending.clear();
		recent.clear();
		writeTrace({ event: "session_start", servers: knownServers(), totals });
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!config.enabled) return;
		const target = classifyTool(event.toolName);
		if (target === undefined) return;
		if (!serverAllowed(config, target.server)) return;

		const record: McpCallRecord = {
			id: event.toolCallId,
			target,
			startedAt: Date.now(),
			argsSummary: summarizeArgs(event.args),
			args: event.args,
			payloadTokens: 0,
			docTokens: 0,
			docs: 0,
			collections: [],
			hits: [],
		};
		pending.start(record);
		writeTrace({ event: "start", id: record.id, server: target.server, tool: target.tool, args: record.argsSummary });
		refreshLiveStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!config.enabled) return;
		const target = classifyTool(event.toolName);
		if (target === undefined) return;
		if (!serverAllowed(config, target.server)) return;

		const started = pending.finish(event.toolCallId) ?? pending.takeByTool(event.toolName);
		// A missing start event leaves no arguments to show — the record still
		// carries the result, duration and token accounting.
		const record: McpCallRecord = started ?? {
			id: event.toolCallId,
			target,
			startedAt: Date.now(),
			argsSummary: "",
			payloadTokens: 0,
			docTokens: 0,
			docs: 0,
			collections: [],
			hits: [],
		};

		record.endedAt = Date.now();
		record.durationMs = record.endedAt - record.startedAt;
		record.isError = event.isError === true;
		const analysis = analyzeResult(target, event.result);
		record.payloadTokens = analysis.payloadTokens;
		record.docTokens = analysis.docTokens;
		record.docs = analysis.docs;
		record.collections = analysis.collections;
		record.hits = analysis.hits;
		record.resultSummary = analysis.resultSummary;

		accumulate(totals, record);
		recent.push(record);
		pi.appendEntry(STATS_ENTRY_TYPE, totals);
		writeTrace({ event: "end", record, totals });

		// The card is durable data, not UI chrome: it is appended headlessly too, so
		// a session that is later exported to HTML still shows what MCP returned.
		if (config.variants.entry) {
			pi.appendEntry<CallEntryPayload>(CALL_ENTRY_TYPE, {
				record,
				detail: config.detail,
				maxHits: config.maxHits,
			});
		}

		if (ctx.hasUI) {
			if (config.variants.modal) {
				showCallModal(ctx, record, config);
			}
			if (config.variants.status) {
				ctx.ui.setStatus(statusKey, composeDoneStatus(record, totals));
				clearStatusLater(ctx);
			}
		}
		refreshLiveStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopLiveTimer();
		if (statusTimer !== undefined) {
			clearTimeout(statusTimer);
			statusTimer = undefined;
		}
		pending.clear();
	});

	// --------------------------------------------------------------- command

	registerMcpVizCommand(pi, {
		getConfig: () => config,
		patchConfig,
		getTotals: () => totals,
		getRecent: () => recent.list(),
		resetTotals: () => {
			totals = emptyTotals();
			recent.clear();
			pi.appendEntry(STATS_ENTRY_TYPE, totals);
		},
		getServers: () => knownServers(),
	});
}
