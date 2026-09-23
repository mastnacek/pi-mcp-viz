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

/** Subcommands that take parameters, so their row keeps the trailing space. */
const NON_TERMINAL = new Set(["variant", "server", "modal", "ttl", "detail"]);

/**
 * Subcommands whose parameters are enumerable. The engine closes the picker on
 * Tab and forces file completion once a space exists, so these MUST return their
 * parameter list as soon as the token is fully typed (the skill's Lazy Parameter
 * Completion rule) instead of waiting for the trailing space.
 */
const LAZY_EXPAND = new Set(["variant", "server", "detail"]);

/** Variants that are currently on, for the parent-level annotation. */
function variantsOn(config: McpVizConfig): string {
	const on = VARIANT_NAMES.filter((name) => config.variants[name]);
	return on.length > 0 ? on.join("+") : "none";
}

/**
 * Current-value suffix for a first-level row. Display only: markers live in
 * `label`/`description`, never in `value` (inserted verbatim), never as ANSI.
 */
function parentState(key: string, config: McpVizConfig): string {
	switch (key) {
		case "on":
			return config.enabled ? " · ● ZAPNUTO" : "";
		case "off":
			return config.enabled ? "" : " · ○ VYPNUTO";
		case "variant":
			return ` (nyní: ${variantsOn(config)})`;
		case "modal":
			return ` (nyní: ${config.modalDelayMs} ms)`;
		case "ttl":
			return ` (nyní: ${config.statusTtlMs} ms)`;
		case "detail":
			return ` (nyní: ${config.detail})`;
		case "server": {
			const parts: string[] = [];
			if (config.includeServers.length > 0) parts.push(`include ${config.includeServers.join(", ")}`);
			if (config.excludeServers.length > 0) parts.push(`exclude ${config.excludeServers.join(", ")}`);
			return ` (nyní: ${parts.length > 0 ? parts.join(" · ") : "vše"})`;
		}
		default:
			return "";
	}
}

function completeFirstLevel(deps: CommandDeps, normalized: string): AutocompleteItem[] {
	const config = deps.getConfig();
	const items: AutocompleteItem[] = [];
	for (const [name, description] of Object.entries(COMMAND_DOCS)) {
		if (!name.startsWith(normalized)) continue;
		items.push({
			value: NON_TERMINAL.has(name) ? `${name} ` : name,
			label: name,
			description: `${description}${parentState(name, config)}`,
		});
	}
	return items;
}

/** `/mcp-viz variant <name>` — the active variant carries `✓` and `● AKTIVNÍ`. */
function completeVariant(deps: CommandDeps, normalized: string): AutocompleteItem[] {
	const config = deps.getConfig();
	return VARIANT_NAMES.map((name) => {
		const active = config.variants[name];
		return {
			value: `variant ${name}`,
			label: active ? `${name} ✓` : name,
			description: `${active ? "Zapnuto" : "Vypnuto"} — Tab přepne${active ? " · ● AKTIVNÍ" : ""}`,
		};
	}).filter((item) => item.value.toLowerCase().startsWith(normalized));
}

/** `/mcp-viz detail <0|1|2>` — enumerable, so it expands without a trailing space. */
function completeDetail(deps: CommandDeps, normalized: string): AutocompleteItem[] {
	const current = deps.getConfig().detail;
	const levels: ReadonlyArray<readonly [0 | 1 | 2, string]> = [
		[0, "kompaktní karta"],
		[1, "karta + seznam dokumentů"],
		[2, "karta + argumenty + dokumenty"],
	];
	return levels
		.map(([value, text]) => ({
			value: `detail ${value}`,
			label: current === value ? `${value} ✓` : String(value),
			description: `${text}${current === value ? " · ● AKTIVNÍ" : ""}`,
		}))
		.filter((item) => item.value.toLowerCase().startsWith(normalized));
}

/** `/mcp-viz server <include|exclude|clear> [name]`. */
function completeServer(
	deps: CommandDeps,
	tokens: string[],
	normalized: string,
	trailingSpace: boolean,
): AutocompleteItem[] {
	const config = deps.getConfig();
	const action = (tokens[1] ?? "").toLowerCase();
	// Name level only once the action token is followed by a space or a name.
	const atNameLevel = tokens.length >= 3 || (tokens.length === 2 && trailingSpace);

	if (!atNameLevel) {
		const actions = [
			{
				name: "include",
				description: `Povolit jen vybrané servery${
					config.includeServers.length > 0 ? ` (nyní: ${config.includeServers.join(", ")})` : ""
				}`,
			},
			{
				name: "exclude",
				description: `Zakázat vybrané servery${
					config.excludeServers.length > 0 ? ` (nyní: ${config.excludeServers.join(", ")})` : ""
				}`,
			},
			{ name: "clear", description: "Zrušit filtry serverů (vše povoleno)" },
		];
		return actions
			.filter((entry) => entry.name.startsWith(action))
			.map((entry) => ({
				value: entry.name === "clear" ? "server clear" : `server ${entry.name} `,
				label: `server ${entry.name}`,
				description: entry.description,
			}));
	}

	const included = new Set(config.includeServers);
	const excluded = new Set(config.excludeServers);
	return deps
		.getServers()
		.map((server) => {
			const active =
				action === "include" ? included.has(server) : action === "exclude" ? excluded.has(server) : false;
			return {
				value: `server ${action} ${server}`,
				label: active ? `${server} ✓` : server,
				description: `server z mcp.json${active ? " · ● AKTIVNÍ" : ""}`,
			};
		})
		.filter((item) => item.value.toLowerCase().startsWith(normalized));
}

/** Build the `getArgumentCompletions` function for `/mcp-viz`. */
export function createCompletions(deps: CommandDeps) {
	return (prefix: string): AutocompleteItem[] | null => {
		const tokens = prefix.split(/\s+/).filter(Boolean);
		const trailingSpace = /\s$/.test(prefix);
		const normalized = tokens.join(" ").toLowerCase();
		const head = (tokens[0] ?? "").toLowerCase();
		const deeper =
			tokens.length > 1 ||
			(trailingSpace && tokens.length === 1) ||
			(tokens.length === 1 && LAZY_EXPAND.has(head));

		if (!deeper) {
			const items = completeFirstLevel(deps, normalized);
			return items.length > 0 ? items : null;
		}

		let items: AutocompleteItem[] = [];
		if (head === "variant") items = completeVariant(deps, normalized);
		else if (head === "detail") items = completeDetail(deps, normalized);
		else if (head === "server") items = completeServer(deps, tokens, normalized, trailingSpace);

		return items.length > 0 ? items : null;
	};
}

/** Register the control command. */
export function registerMcpVizCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("mcp-viz", {
		description: "Visualize MCP activity: transcript cards, modal or status badge + token counters",
		getArgumentCompletions: createCompletions(deps),

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
