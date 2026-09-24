import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VARIANT_NAMES, describeConfig } from "./config.js";
import { fmtInt, fmtMs, fmtTokens } from "./tokens.js";
import type { McpCallRecord, McpVizConfig, SessionTotals, VariantName } from "./types.js";
import { COMMAND_DOCS, createCompletions } from "./completions.js";

export { COMMAND_DOCS, createCompletions };

export interface CommandDeps {
	getConfig: () => McpVizConfig;
	patchConfig: (patch: Partial<McpVizConfig>, isGlobal?: boolean) => McpVizConfig;
	getTotals: () => SessionTotals;
	getRecent: () => McpCallRecord[];
	resetTotals: () => void;
	getServers: () => string[];
}

type SubHandler = (deps: CommandDeps, rest: string[], ctx: ExtensionCommandContext, isGlobal?: boolean) => void;

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

const handleVariant: SubHandler = (deps, rest, ctx, isGlobal) => {
	const name = parseVariant((rest[0] ?? "").toLowerCase());
	if (name === undefined) {
		ctx.ui.notify(`Neznámá varianta. Použij: ${VARIANT_NAMES.join(" | ")}`, "warning");
		return;
	}
	const enabled = flagOnOff(rest[1]) ?? !deps.getConfig().variants[name];
	deps.patchConfig({ variants: { ...deps.getConfig().variants, [name]: enabled } }, isGlobal);
	ctx.ui.notify(`varianta ${name} ${enabled ? "on" : "off"}${isGlobal ? " (globálně)" : ""}`, "info");
};

const handleModal: SubHandler = (deps, rest, ctx, isGlobal) => {
	const value = numberArg(rest[0]);
	if (value === undefined) {
		ctx.ui.notify("Použití: /mcp-viz modal <ms>", "warning");
		return;
	}
	ctx.ui.notify(`modal auto-dismiss: ${deps.patchConfig({ modalDelayMs: value }, isGlobal).modalDelayMs}ms${isGlobal ? " (globálně)" : ""}`, "info");
};

const handleTtl: SubHandler = (deps, rest, ctx, isGlobal) => {
	const value = numberArg(rest[0]);
	if (value === undefined) {
		ctx.ui.notify("Použití: /mcp-viz ttl <ms> (0 = držet do dalšího volání)", "warning");
		return;
	}
	ctx.ui.notify(`status ttl: ${deps.patchConfig({ statusTtlMs: value }, isGlobal).statusTtlMs}ms${isGlobal ? " (globálně)" : ""}`, "info");
};

const handleDetail: SubHandler = (deps, rest, ctx, isGlobal) => {
	const value = numberArg(rest[0]);
	if (value !== 0 && value !== 1 && value !== 2) {
		ctx.ui.notify("Použití: /mcp-viz detail <0|1|2>", "warning");
		return;
	}
	deps.patchConfig({ detail: value }, isGlobal);
	ctx.ui.notify(`detail: ${value}${isGlobal ? " (globálně)" : ""}`, "info");
};

const handleServer: SubHandler = (deps, rest, ctx, isGlobal) => {
	const [rawAction = "", name = ""] = rest.map((token) => token.toLowerCase());
	const config = deps.getConfig();

	if (rawAction === "clear") {
		deps.patchConfig({ includeServers: [], excludeServers: [] }, isGlobal);
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
	deps.patchConfig({ includeServers: [...include], excludeServers: [...exclude] }, isGlobal);
	ctx.ui.notify(`server ${name}: ${rawAction}${isGlobal ? " (globálně)" : ""}`, "info");
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

/** Register the control command. */
export function registerMcpVizCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("mcp-viz", {
		description: "Visualize MCP activity: transcript cards, modal or status badge + token counters",
		getArgumentCompletions: createCompletions(deps),

		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
			const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");
			const [sub = ""] = cleanTokens;
			const command = sub.toLowerCase();
			const rest = cleanTokens.slice(1);
			const config = deps.getConfig();

			if (command === "" || command === "help" || command === "-h" || command === "--help") {
				ctx.ui.notify(helpLines(config), "info");
				return;
			}

			if (command === "on" || command === "off") {
				const next = deps.patchConfig({ enabled: command === "on" }, isGlobal);
				ctx.ui.notify(`MCP viz ${next.enabled ? "zapnuto" : "vypnuto"} (${isGlobal ? "globálně" : "do projektu"}) — ${describeConfig(next)}`, "info");
				return;
			}

			const handler = SUBCOMMANDS[command];
			if (handler === undefined) {
				ctx.ui.notify(`Neznámý příkaz „${sub}“. Použij: /mcp-viz help`, "warning");
				return;
			}
			handler(deps, rest, ctx, isGlobal);
		},
	});
}
