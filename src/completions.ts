import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { VARIANT_NAMES } from "./config.js";
import type { McpVizConfig, VariantName } from "./types.js";
import type { CommandDeps } from "./command.js";

export const COMMAND_DOCS: Record<string, string> = {
	"--global": "uložit následující nastavení globálně (~/.pi/agent/)",
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

export const NON_TERMINAL = new Set(["--global", "variant", "modal", "ttl", "detail", "server"]);
export const LAZY_EXPAND = new Set(["variant", "server", "detail"]);

function variantsOn(config: McpVizConfig): string {
	const on = VARIANT_NAMES.filter((name) => config.variants[name]);
	return on.length > 0 ? on.join("+") : "none";
}

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

function completeVariant(deps: CommandDeps, normalized: string): AutocompleteItem[] {
	const config = deps.getConfig();
	return VARIANT_NAMES.map((name: VariantName) => {
		const active = config.variants[name];
		return {
			value: `variant ${name}`,
			label: active ? `${name} ✓` : name,
			description: `${active ? "Zapnuto" : "Vypnuto"} — Tab přepne${active ? " · ● AKTIVNÍ" : ""}`,
		};
	}).filter((item) => item.value.toLowerCase().startsWith(normalized));
}

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

function completeServer(
	deps: CommandDeps,
	tokens: string[],
	normalized: string,
	trailingSpace: boolean,
): AutocompleteItem[] {
	const config = deps.getConfig();
	const action = (tokens[1] ?? "").toLowerCase();
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

export function createCompletions(deps: CommandDeps) {
	return (prefix: string): AutocompleteItem[] | null => {
		const trimmed = prefix.trimStart();

		const getCompletionsClean = (cleanPrefix: string): AutocompleteItem[] | null => {
			const tokens = cleanPrefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(cleanPrefix);
			const normalized = cleanPrefix.toLowerCase();
			const head = (tokens[0] ?? "").toLowerCase();
			const deeper =
				tokens.length > 1 ||
				(trailingSpace && tokens.length === 1) ||
				(tokens.length === 1 && LAZY_EXPAND.has(head) && head !== "--global");

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

		if (trimmed.startsWith("--global")) {
			const afterGlobal = trimmed.slice(8).trimStart();
			const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);

			if (!hasTrailingSpace && afterGlobal === "") {
				return [{
					value: "--global ",
					label: "--global",
					description: COMMAND_DOCS["--global"] ?? "uložit globálně",
				}];
			}

			const subCompletions = getCompletionsClean(afterGlobal);
			if (!subCompletions) return null;

			return subCompletions
				.filter((item) => item.label !== "--global")
				.map((item) => ({
					value: `--global ${item.value}`,
					label: item.label,
					description: item.description,
				}));
		}

		return getCompletionsClean(trimmed);
	};
}
