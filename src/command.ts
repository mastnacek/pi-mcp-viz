/**
 * /mcp-viz — control surface.
 *
 * Follows the house pattern: a documentation dictionary drives the first-level
 * autocomplete and the help banner, deeper levels load data lazily (variant
 * names are static, server names come from mcp.json on demand). The command
 * never throws at the user: unknown input gets a warning with the help hint.
 *
 * Subcommands are dispatched through a table of small handlers rather than one
 * large switch, so each of them stays readable and independently testable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { VARIANT_NAMES, describeConfig } from "./config.js";
import { fmtInt, fmtMs, fmtTokens } from "./tokens.js";
import type { McpCallRecord, McpVizConfig, SessionTotals, VariantName } from "./types.js";

export const COMMAND_DOCS: Record<string, string> = {
	on: "enable MCP visualization",
	off: "disable MCP visualization",
	variant: "toggle a visual variant (entry | modal | status)",
	modal: "set modal auto-dismiss delay in ms",
	ttl: "set how long the status badge stays (ms, 0 = until next call)",
	detail: "set card detail level (0 compact | 1 show documents | 2 show args)",
	server: "include or exclude an MCP server",
	status: "show config and session token counters",
	tail: "list the most recent MCP calls",
	reset: "reset session counters",
	help: "show this reference",
};

export interface CommandDeps {
	getConfig: () => McpVizConfig;
	patchConfig: (patch: Partial<McpVizConfig>) => McpVizConfig;
	getTotals: () => SessionTotals;
	getRecent: () => McpCallRecord[];
	resetTotals: () => void;
	getServers: () => string[];
}

type SubHandler = (deps: CommandDeps, rest: string[], ctx: ExtensionCommandContext) => void;

function flagOnOff(value: string | undefined): boolean | undefined {
	if (value === undefined || value === "") return undefined;
	if (value === "on" || value === "1" || value === "true") return true;
	if (value === "off" || value === "0" || value === "false") return false;
	return undefined;
}

function parseVariant(value: string): VariantName | undefined {
	return (VARIANT_NAMES as readonly string[]).includes(value) ? (value as VariantName) : undefined;
}

function numberArg(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function tailLines(records: readonly McpCallRecord[], limit: number): string {
	if (records.length === 0) return "Žádná MCP volání v této session.";
	return records
		.slice(-limit)
		.map((record) => {
			const mark = record.isError ? "✗" : "·";
			const when = new Date(record.startedAt).toLocaleTimeString();
			return `${mark} ${when} ${record.target.badge} ${record.target.tool} — ${fmtInt(
				record.docs,
			)} docs · ${fmtTokens(record.docTokens)} tok · ${fmtMs(record.durationMs ?? 0)}`;
		})
		.join("\n");
}

function statusLines(config: McpVizConfig, totals: SessionTotals, servers: readonly string[]): string {
	const perServer = Object.entries(totals.byServer)
		.map(([server, value]) => `  ${server}: ${value.calls} calls · ${fmtTokens(value.docTokens)} tok`)
		.join("\n");
	return [
		"# MCP visualization",
		describeConfig(config),
		`servers: ${servers.join(", ") || "(none from mcp.json)"}`,
		"",
		`session: ${fmtInt(totals.calls)} calls · ${fmtInt(totals.docs)} docs · ${fmtTokens(
			totals.docTokens,
		)} tok (${fmtTokens(totals.payloadTokens)} tok in payloads)`,
		`KB only: ${fmtInt(totals.kbDocs)} docs · ${fmtTokens(totals.kbDocTokens)} tok`,
		perServer ? `per server:\n${perServer}` : "per server: (nothing yet)",
	].join("\n");
}

function helpLines(config: McpVizConfig): string {
	const variantLine = (name: VariantName) => `  ${name.padEnd(6)} ${config.variants[name] ? "✔ on " : "  off"}`;
	return [
		"# /mcp-viz — MCP activity visualization",
		"Shows when an MCP server (knowledge base, openrouter, …) is working, what it",
		"returned and how many tokens those documents were worth.",
		"",
		"### Variants",
		"  entry  — transcript card per call",
		"  modal  — floating card, auto-dismisses",
		"  status — footer badge with the token counter",
		VARIANT_NAMES.map(variantLine).join("\n"),
		"",
		"### Commands",
		"  /mcp-viz on | off                  — master switch",
		"  /mcp-viz variant <name> [on|off|toggle]",
		"  /mcp-viz modal <ms>                — auto-dismiss delay (300–60000)",
		"  /mcp-viz ttl <ms>                  — status badge lifetime (0 = until replaced)",
		"  /mcp-viz detail <0|1|2>            — compact / documents / arguments",
		"  /mcp-viz server include <name> | exclude <name> | clear",
		"  /mcp-viz status                    — config + token counters",
		"  /mcp-viz tail [n]                  — last calls",
		"  /mcp-viz reset                     — zero the session counters",
		"",
		"Counters are estimates (chars/4, the same heuristic pi uses for context).",
	].join("\n");
}

// ------------------------------------------------------------- subcommands

const handleVariant: SubHandler = (deps, rest, ctx) => {
	const name = parseVariant((rest[0] ?? "").toLowerCase());
	if (name === undefined) {
		ctx.ui.notify(`Neznámá varianta. Použij: ${VARIANT_NAMES.join(" | ")}`, "warning");
		return;
	}
	const enabled = flagOnOff(rest[1]) ?? !deps.getConfig().variants[name];
	deps.patchConfig({ variants: { ...deps.getConfig().variants, [name]: enabled } });
	ctx.ui.notify(`varianta ${name} ${enabled ? "on" : "off"}`, "info");
};

const handleModal: SubHandler = (deps, rest, ctx) => {
	const value = numberArg(rest[0]);
	if (value === undefined) {
		ctx.ui.notify("Použití: /mcp-viz modal <ms>", "warning");
		return;
	}
	ctx.ui.notify(`modal auto-dismiss: ${deps.patchConfig({ modalDelayMs: value }).modalDelayMs}ms`, "info");
};

const handleTtl: SubHandler = (deps, rest, ctx) => {
	const value = numberArg(rest[0]);
	if (value === undefined) {
		ctx.ui.notify("Použití: /mcp-viz ttl <ms> (0 = držet do dalšího volání)", "warning");
		return;
	}
	ctx.ui.notify(`status ttl: ${deps.patchConfig({ statusTtlMs: value }).statusTtlMs}ms`, "info");
};

const handleDetail: SubHandler = (deps, rest, ctx) => {
	const value = numberArg(rest[0]);
	if (value !== 0 && value !== 1 && value !== 2) {
		ctx.ui.notify("Použití: /mcp-viz detail <0|1|2>", "warning");
		return;
	}
	deps.patchConfig({ detail: value });
	ctx.ui.notify(`detail: ${value}`, "info");
};

const handleServer: SubHandler = (deps, rest, ctx) => {
	const [rawAction = "", name = ""] = rest.map((token) => token.toLowerCase());
	const config = deps.getConfig();

	if (rawAction === "clear") {
		deps.patchConfig({ includeServers: [], excludeServers: [] });
		ctx.ui.notify("filtry serverů vyčištěny (vše povoleno)", "info");
		return;
	}
	if ((rawAction !== "include" && rawAction !== "exclude") || name === "") {
		ctx.ui.notify("Použití: /mcp-viz server include|exclude|clear [name]", "warning");
		return;
	}

	const include = new Set(config.includeServers);
	const exclude = new Set(config.excludeServers);
	if (rawAction === "include") {
		include.add(name);
		exclude.delete(name);
	} else {
		exclude.add(name);
		include.delete(name);
	}
	deps.patchConfig({ includeServers: [...include], excludeServers: [...exclude] });
	ctx.ui.notify(`server ${name}: ${rawAction}`, "info");
};

const handleStatus: SubHandler = (deps, _rest, ctx) => {
	ctx.ui.notify(statusLines(deps.getConfig(), deps.getTotals(), deps.getServers()), "info");
};

const handleTail: SubHandler = (deps, rest, ctx) => {
	const requested = numberArg(rest[0]) ?? 10;
	const limit = Math.max(1, Math.min(50, requested));
	ctx.ui.notify(tailLines(deps.getRecent(), limit), "info");
};

const handleReset: SubHandler = (deps, _rest, ctx) => {
	deps.resetTotals();
	ctx.ui.notify("čítadla session vynulována", "info");
};

const SUBCOMMANDS: Record<string, SubHandler> = {
	variant: handleVariant,
	modal: handleModal,
	ttl: handleTtl,
	detail: handleDetail,
	server: handleServer,
	status: handleStatus,
	tail: handleTail,
	reset: handleReset,
};

// ---------------------------------------------------------- autocompletion

function completeVariant(deps: CommandDeps, normalized: string, trailingSpace: boolean, tokenCount: number) {
	const items = VARIANT_NAMES.map((name) => ({
		value: `variant ${name}`,
		label: `variant ${name}`,
		description: deps.getConfig().variants[name] ? "currently on" : "currently off",
	}));
	void trailingSpace;
	void tokenCount;
	return items.filter((item) => item.value.toLowerCase().startsWith(normalized));
}

function completeServer(deps: CommandDeps, tokens: string[], normalized: string, trailingSpace: boolean) {
	const action = (tokens[1] ?? "").toLowerCase();
	if (!trailingSpace && tokens.length === 2) {
		return ["include", "exclude", "clear"]
			.filter((value) => value.startsWith(action))
			.map((value) => ({
				value: value === "clear" ? `server ${value}` : `server ${value} `,
				label: `server ${value}`,
				description: "",
			}));
	}
	return deps
		.getServers()
		.map((server) => ({
			value: `server ${action} ${server}`,
			label: `server ${action} ${server}`,
			description: "server from mcp.json",
		}))
		.filter((item) => item.value.toLowerCase().startsWith(normalized));
}

function completeFirstLevel(normalized: string): AutocompleteItem[] {
	const NON_TERMINAL = new Set(["variant", "server", "modal", "ttl", "detail"]);
	const items: AutocompleteItem[] = [];
	for (const [name, description] of Object.entries(COMMAND_DOCS)) {
		if (name.startsWith(normalized)) {
			items.push({
				value: NON_TERMINAL.has(name) ? `${name} ` : name,
				label: name,
				description,
			});
		}
	}
	return items;
}

/** Register the control command. */
export function registerMcpVizCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("mcp-viz", {
		description: "Visualize MCP activity: transcript cards, modal or status badge + token counters",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			const normalized = tokens.join(" ").toLowerCase();
			const [head = ""] = tokens;
			const deeper = tokens.length > 1 || (trailingSpace && tokens.length === 1);

			if (!deeper) {
				const items = completeFirstLevel(normalized);
				return items.length > 0 ? items : null;
			}

			let items: AutocompleteItem[] = [];
			if (head.toLowerCase() === "variant") items = completeVariant(deps, normalized, trailingSpace, tokens.length);
			else if (head.toLowerCase() === "server") items = completeServer(deps, tokens, normalized, trailingSpace);

			return items.length > 0 ? items : null;
		},

		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [sub = ""] = tokens;
			const command = sub.toLowerCase();
			const rest = tokens.slice(1);
			const config = deps.getConfig();

			if (command === "" || command === "help" || command === "-h" || command === "--help") {
				ctx.ui.notify(helpLines(config), "info");
				return;
			}

			if (command === "on" || command === "off") {
				const next = deps.patchConfig({ enabled: command === "on" });
				ctx.ui.notify(`MCP viz ${next.enabled ? "zapnuto" : "vypnuto"} — ${describeConfig(next)}`, "info");
				return;
			}

			const handler = SUBCOMMANDS[command];
			if (handler === undefined) {
				ctx.ui.notify(`Neznámý příkaz „${sub}“. Použij: /mcp-viz help`, "warning");
				return;
			}
			handler(deps, rest, ctx);
		},
	});
}
