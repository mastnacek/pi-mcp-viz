/**
 * Detection of MCP tool calls.
 *
 * Pi surfaces MCP tools in three shapes, all three observed in real sessions:
 *
 *   knowledge_base_kb_search        — direct tool from a server with directTools
 *   knowledge-base_kb_search        — same, server key with a hyphen
 *   mcp__knowledge_base             — namespace proxy for a non-direct server
 *   mcp                             — the gateway tool itself (arguments name the server)
 *
 * Plus non-MCP builtins (bash, read, ...) that must be ignored. Detection is
 * therefore data-driven: server names come from `~/.pi/agent/mcp.json`, so a
 * newly added MCP server is visualized without touching this plugin.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpTarget } from "./types.js";

/** Badges for servers we know; anything else gets derived initials. */
const KNOWN_BADGES: Record<string, string> = {
	knowledge_base: "KB",
	openrouter: "OR",
	metaculus: "MC",
	hf_mcp_server: "HF",
	lotusscript_lsp: "LSP",
	context7: "C7",
};

export const KB_SERVER = "knowledge_base";

function normalizeServer(name: string): string {
	return name.trim().toLowerCase().replace(/-/g, "_");
}

function badgeFor(server: string): string {
	const known = KNOWN_BADGES[server];
	if (known) return known;
	const parts = server.split("_").filter(Boolean);
	const initials = parts.map((p) => p[0] ?? "").join("").slice(0, 3);
	return (initials || server.slice(0, 2)).toUpperCase();
}

/** Server names declared in pi's mcp.json (config file may be absent). */
export function loadMcpServerNames(mcpJsonPath?: string): string[] {
	const path = mcpJsonPath ?? join(homedir(), ".pi", "agent", "mcp.json");
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			mcpServers?: Record<string, unknown>;
		};
		return Object.keys(parsed.mcpServers ?? {}).map(normalizeServer);
	} catch {
		return [];
	}
}

/** Environment variable used by the tests to point at a fixture config. */
export const MCP_JSON_ENV = "PI_MCP_VIZ_MCP_JSON";

/** Resolve the server list once per process, honoring the test override. */
let cachedServers: string[] | undefined;
export function knownServers(): string[] {
	if (cachedServers === undefined) {
		cachedServers = loadMcpServerNames(process.env[MCP_JSON_ENV]);
	}
	return cachedServers;
}

/** Reset the cached server list (tests). */
export function resetServerCache(): void {
	cachedServers = undefined;
}

/** Build a normalized target for a server name. */
export function targetFor(server: string, tool: string, rawTool: string, via: McpTarget["via"]): McpTarget {
	const normalized = normalizeServer(server);
	return {
		server: normalized,
		badge: badgeFor(normalized),
		tool,
		rawTool,
		via,
		knowledgeBase: normalized === KB_SERVER,
	};
}

/**
 * Classify a pi tool name as an MCP call, or return undefined for non-MCP tools.
 *
 * `servers` defaults to the names read from mcp.json; passing it explicitly
 * keeps the function pure for tests.
 */
export function classifyTool(toolName: string, servers: string[] = knownServers()): McpTarget | undefined {
	if (!toolName) return undefined;

	// Gateway tool: name says nothing, arguments carry the target. Treat it as
	// its own server so the call is still visible.
	if (toolName === "mcp") {
		return targetFor("mcp", "gateway", toolName, "gateway");
	}

	// Namespace proxy: mcp__<server>
	if (toolName.startsWith("mcp__")) {
		const server = toolName.slice("mcp__".length);
		if (!server) return undefined;
		return targetFor(server, server, toolName, "namespace");
	}

	// Direct tool: <server>_<tool> or <server>-<tool>, where the server itself may
	// be spelled with either separator (knowledge-base_kb_search).
	for (const server of servers) {
		const spellings = new Set([server, server.replace(/_/g, "-")]);
		for (const spelling of spellings) {
			for (const separator of ["_", "-"]) {
				const prefix = `${spelling}${separator}`;
				if (toolName.startsWith(prefix) && toolName.length > prefix.length) {
					return targetFor(server, toolName.slice(prefix.length), toolName, "prefix");
				}
			}
		}
	}

	return undefined;
}
