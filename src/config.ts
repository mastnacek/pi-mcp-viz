/**
 * Config for pi-mcp-viz: ~/.pi/agent/pi-mcp-viz.json
 *
 * Kept deliberately flat so `/mcp-viz` can write single keys without rewriting
 * the file from a partial object. Missing keys fall back to defaults, and an
 * unknown variant name in the file is ignored instead of dropping the whole
 * config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpVizConfig, VariantName } from "./types.js";

export const VARIANT_NAMES: readonly VariantName[] = ["entry", "modal", "status"] as const;

export const DEFAULT_CONFIG: McpVizConfig = {
	enabled: true,
	// Shipped default: the modal card only. It is the variant that makes an MCP
	// call visible without touching the transcript or the footer.
	variants: { entry: false, modal: true, status: false },
	modalDelayMs: 3000,
	statusTtlMs: 8000,
	liveStatus: true,
	includeServers: [],
	excludeServers: [],
	logToFile: true,
	detail: 1,
	maxHits: 5,
};

/** Override for tests; unset in normal use. */
export const CONFIG_ENV = "PI_MCP_VIZ_CONFIG";
export const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-mcp-viz.json");

export function globalConfigPath(): string {
	return process.env[CONFIG_ENV] ?? GLOBAL_CONFIG_FILE;
}

export function configPath(): string {
	return globalConfigPath();
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-mcp-viz.json");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (typeof item === "string" ? [item.trim()] : []));
}

/** Merge a raw parsed object over the defaults. */
export function normalizeConfig(raw: unknown): McpVizConfig {
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const variantsRaw = (source.variants && typeof source.variants === "object" ? source.variants : {}) as Record<
		string,
		unknown
	>;

	const variants = { ...DEFAULT_CONFIG.variants };
	for (const name of VARIANT_NAMES) {
		if (typeof variantsRaw[name] === "boolean") variants[name] = variantsRaw[name] as boolean;
	}

	const detailRaw = source.detail;

	return {
		enabled: asBoolean(source.enabled, DEFAULT_CONFIG.enabled),
		variants,
		modalDelayMs: asNumber(source.modalDelayMs, DEFAULT_CONFIG.modalDelayMs, 300, 60_000),
		statusTtlMs: asNumber(source.statusTtlMs, DEFAULT_CONFIG.statusTtlMs, 0, 10 * 60_000),
		liveStatus: asBoolean(source.liveStatus, DEFAULT_CONFIG.liveStatus),
		includeServers: asStringArray(source.includeServers),
		excludeServers: asStringArray(source.excludeServers),
		logToFile: asBoolean(source.logToFile, DEFAULT_CONFIG.logToFile),
		detail: detailRaw === 0 || detailRaw === 1 || detailRaw === 2 ? detailRaw : DEFAULT_CONFIG.detail,
		maxHits: asNumber(source.maxHits, DEFAULT_CONFIG.maxHits, 1, 50),
	};
}

/** Read the config with cascade: defaults <- global <- project. */
export function loadConfig(cwd?: string): McpVizConfig {
	let base = normalizeConfig({});
	const gPath = globalConfigPath();
	if (existsSync(gPath)) {
		try {
			base = normalizeConfig({ ...base, ...JSON.parse(readFileSync(gPath, "utf8")) });
		} catch {
			// fallback
		}
	}
	if (cwd) {
		const pPath = projectConfigPath(cwd);
		if (existsSync(pPath)) {
			try {
				base = normalizeConfig({ ...base, ...JSON.parse(readFileSync(pPath, "utf8")) });
			} catch {
				// fallback
			}
		}
	}
	return base;
}

/** Write the config with cascade support (global if isGlobal, else project). */
export function saveConfig(config: McpVizConfig, isGlobal = false, cwd?: string): void {
	const path = isGlobal || !cwd ? globalConfigPath() : projectConfigPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Human one-liner for /mcp-viz status and the help banner. */
export function describeConfig(config: McpVizConfig): string {
	const on = VARIANT_NAMES.filter((name) => config.variants[name]);
	return [
		config.enabled ? "on" : "off",
		on.length > 0 ? `variants: ${on.join("+")}` : "variants: none",
		`modal ${config.modalDelayMs}ms`,
		`status ttl ${config.statusTtlMs}ms`,
		`detail ${config.detail}`,
	].join(" · ");
}

/** Whether a server passes the include/exclude filters. */
export function serverAllowed(config: McpVizConfig, server: string): boolean {
	if (config.excludeServers.includes(server)) return false;
	if (config.includeServers.length === 0) return true;
	return config.includeServers.includes(server);
}
