/**
 * Command menu tests for `/mcp-viz`.
 *
 * Locks the three rules the pi-plugin-dev skill makes mandatory:
 *   - the trailing-space contract (non-terminal rows end with a space)
 *   - lazy parameter expansion (a fully-typed non-terminal token already
 *     yields its children, because Tab closes the picker)
 *   - current-value annotation (`✓` in `label`, `● AKTIVNÍ` in `description`,
 *     never in `value`, never as ANSI)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createCompletions, type CommandDeps } from "../src/command.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { McpVizConfig } from "../src/types.js";

const SERVERS = ["knowledge_base", "openrouter", "metaculus"];

function deps(overrides: Partial<McpVizConfig> = {}): CommandDeps {
	const config: McpVizConfig = { ...DEFAULT_CONFIG, ...overrides };
	return {
		getConfig: () => config,
		patchConfig: (patch) => Object.assign(config, patch),
		getTotals: () => ({
			calls: 0,
			errors: 0,
			payloadTokens: 0,
			docTokens: 0,
			docs: 0,
			kbDocs: 0,
			kbDocTokens: 0,
			byServer: {},
		}),
		getRecent: () => [],
		resetTotals: () => {},
		getServers: () => SERVERS,
	};
}

function complete(prefix: string, overrides: Partial<McpVizConfig> = {}): AutocompleteItem[] {
	return createCompletions(deps(overrides))(prefix) ?? [];
}

function row(items: AutocompleteItem[], label: string): AutocompleteItem {
	const found = items.find((item) => item.label === label || item.label.startsWith(`${label} `));
	assert.ok(found, `no completion row for ${label}: ${JSON.stringify(items.map((i) => i.label))}`);
	return found;
}

/** `description` is optional on AutocompleteItem; every assertion here wants text. */
function desc(item: AutocompleteItem | undefined): string {
	return item?.description ?? "";
}

test("first level annotates the master switch with the live state", () => {
	const on = row(complete("on"), "on");
	assert.equal(desc(on).includes("● ZAPNUTO"), true);

	const offWhileEnabled = complete("off");
	const off = row(offWhileEnabled, "off");
	assert.equal(desc(off).includes("VYPNUTO"), false);

	const disabled = complete("off", { enabled: false });
	assert.equal(desc(row(disabled, "off")).includes("○ VYPNUTO"), true);
	assert.equal(desc(complete("on", { enabled: false })[0]).includes("ZAPNUTO"), false);
});

test("first level annotates value settings with (nyní: …)", () => {
	const items = complete(
		"",
		{ modalDelayMs: 2500, statusTtlMs: 7000, detail: 2, includeServers: ["knowledge_base"] },
	);
	assert.equal(desc(row(items, "modal")).includes("nyní: 2500 ms"), true);
	assert.equal(desc(row(items, "ttl")).includes("nyní: 7000 ms"), true);
	assert.equal(desc(row(items, "detail")).includes("nyní: 2"), true);
	assert.equal(desc(row(items, "variant")).includes("nyní: modal"), true);
	assert.equal(desc(row(items, "server")).includes("include knowledge_base"), true);
});

test("trailing space contract: non-terminal rows get a space, terminal rows do not", () => {
	const items = complete("");
	for (const name of ["variant", "server", "modal", "ttl", "detail"]) {
		assert.equal(row(items, name).value, `${name} `, `${name} must be non-terminal`);
	}
	for (const name of ["on", "off", "status", "tail", "reset", "help"]) {
		assert.equal(row(items, name).value, name, `${name} must be terminal`);
	}
});

test("a fully typed non-terminal token already expands to its parameters", () => {
	const variants = complete("variant");
	assert.deepEqual(
		variants.map((item) => item.value),
		["variant entry", "variant modal", "variant status"],
	);

	const details = complete("detail");
	assert.deepEqual(
		details.map((item) => item.value),
		["detail 0", "detail 1", "detail 2"],
	);

	const actions = complete("server");
	assert.deepEqual(
		actions.map((item) => item.value),
		["server include ", "server exclude ", "server clear"],
	);
});

test("variant rows mark the active variant with ✓ and ● AKTIVNÍ", () => {
	const items = complete("variant", { variants: { entry: false, modal: true, status: false } });
	assert.equal(desc(row(items, "modal ✓")).includes("● AKTIVNÍ"), true);
	assert.equal(desc(row(items, "entry")).includes("● AKTIVNÍ"), false);
	assert.equal(desc(row(items, "status")).includes("● AKTIVNÍ"), false);
});

test("detail rows mark the active level with ✓", () => {
	const items = complete("detail", { detail: 1 });
	assert.equal(row(items, "1 ✓").value, "detail 1");
	assert.equal(row(items, "0").value, "detail 0");
	assert.equal(row(items, "2").value, "detail 2");
});

test("server name rows mark an included server with ✓", () => {
	const items = complete("server include ", { includeServers: ["openrouter"] });
	assert.deepEqual(
		items.map((item) => item.value),
		["server include knowledge_base", "server include openrouter", "server include metaculus"],
	);
	assert.equal(desc(row(items, "openrouter ✓")).includes("● AKTIVNÍ"), true);
	const filtered = complete("server include kn", { includeServers: ["openrouter"] });
	assert.deepEqual(
		filtered.map((item) => item.value),
		["server include knowledge_base"],
	);
});

test("a partial action token stays at the action level", () => {
	const items = complete("server inc");
	assert.deepEqual(
		items.map((item) => item.value),
		["server include "],
	);
});

test("markers never leak into item.value and no ANSI is embedded", () => {
	for (const prefix of ["", "variant", "detail", "server", "server include ", "on"]) {
		for (const item of complete(prefix, { variants: { entry: false, modal: true, status: false } })) {
			assert.equal(/[✓●○]/.test(item.value), false, `marker in value: ${item.value}`);
			assert.equal(/\u001b/.test(item.value + item.label + (item.description ?? "")), false);
		}
	}
});

test("--global prefix preserves child completions", () => {
	const items = complete("--global ");
	assert.ok(items.length > 0);
	assert.ok(items.some((i) => i.value === "--global variant "));
	assert.ok(items.some((i) => i.value === "--global modal "));

	const variantItems = complete("--global variant ");
	assert.ok(variantItems.length > 0);
	assert.ok(variantItems.some((i) => i.value === "--global variant entry"));
	assert.ok(variantItems.some((i) => i.value === "--global variant modal"));
});
