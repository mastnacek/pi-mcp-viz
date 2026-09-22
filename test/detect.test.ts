/**
 * Detection + config tests.
 *
 * The tool names below are copied from real sessions in
 * ~/.pi/agent/sessions, so the matcher is tested against what pi actually
 * emits rather than against invented names.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_ENV, DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig, serverAllowed } from "../src/config.js";
import { MCP_JSON_ENV, classifyTool, loadMcpServerNames, resetServerCache } from "../src/mcp.js";

const SERVERS = ["knowledge_base", "openrouter", "metaculus", "hf_mcp_server", "lotusscript_lsp", "mcp"];

test("direct MCP tools are matched by server prefix", () => {
	const kb = classifyTool("knowledge_base_kb_search", SERVERS);
	assert.equal(kb?.server, "knowledge_base");
	assert.equal(kb?.tool, "kb_search");
	assert.equal(kb?.badge, "KB");
	assert.equal(kb?.knowledgeBase, true);
	assert.equal(kb?.via, "prefix");

	// Same server, hyphenated key — seen in real sessions as knowledge-base_kb_search.
	const hyphen = classifyTool("knowledge-base_kb_search", SERVERS);
	assert.equal(hyphen?.server, "knowledge_base");
	assert.equal(hyphen?.knowledgeBase, true);

	assert.equal(classifyTool("openrouter_list-models", SERVERS)?.server, "openrouter");
	assert.equal(classifyTool("lotusscript_lsp_lsp_diagnostics", SERVERS)?.server, "lotusscript_lsp");
	assert.equal(classifyTool("metaculus_list_questions", SERVERS)?.server, "metaculus");
});

test("namespace proxy and gateway tools are matched", () => {
	const proxy = classifyTool("mcp__knowledge_base", SERVERS);
	assert.equal(proxy?.via, "namespace");
	assert.equal(proxy?.server, "knowledge_base");

	const gateway = classifyTool("mcp", SERVERS);
	assert.equal(gateway?.via, "gateway");
	assert.equal(gateway?.server, "mcp");
});

test("non-MCP tools are ignored", () => {
	for (const name of ["bash", "read", "edit", "web_search", "ctx_execute", "knowledge"]) {
		assert.equal(classifyTool(name, SERVERS), undefined, name);
	}
});

test("unknown server names still get a badge", () => {
	const target = classifyTool("my_new_server_do_thing", ["my_new_server"]);
	assert.equal(target?.server, "my_new_server");
	assert.equal(target?.badge, "MNS");
});

test("servers are read from mcp.json, including a fixture path", () => {
	const dir = mkdtempSync(join(tmpdir(), "mcp-viz-"));
	const path = join(dir, "mcp.json");
	writeFileSync(path, JSON.stringify({ mcpServers: { "knowledge-base": {}, openrouter: {} } }), "utf8");
	assert.deepEqual(loadMcpServerNames(path).sort(), ["knowledge_base", "openrouter"]);

	process.env[MCP_JSON_ENV] = path;
	resetServerCache();
	assert.deepEqual(classifyTool("knowledge_base_kb_search")?.server, "knowledge_base");
	delete process.env[MCP_JSON_ENV];
	resetServerCache();

	assert.deepEqual(loadMcpServerNames(join(dir, "missing.json")), []);
});

test("config defaults, clamping and filters", () => {
	const config = normalizeConfig({});
	assert.equal(config.enabled, true);
	// Shipped defaults: the modal card only, 2 s.
	assert.deepEqual(config.variants, { entry: false, modal: true, status: false });
	assert.equal(config.modalDelayMs, 2000);

	const clamped = normalizeConfig({
		modalDelayMs: 5,
		statusTtlMs: -20,
		detail: 7,
		maxHits: 999,
		variants: { modal: true, nonsense: true },
		includeServers: ["knowledge_base", 42],
	});
	assert.equal(clamped.modalDelayMs, 300);
	assert.equal(clamped.statusTtlMs, 0);
	assert.equal(clamped.detail, 1);
	assert.equal(clamped.maxHits, 50);
	// A partial `variants` object keeps every other default.
	assert.deepEqual(clamped.variants, DEFAULT_CONFIG.variants);
	assert.deepEqual(clamped.includeServers, ["knowledge_base"]);

	assert.equal(serverAllowed(normalizeConfig({}), "anything"), true);
	const filtered = normalizeConfig({ includeServers: ["knowledge_base"] });
	assert.equal(serverAllowed(filtered, "knowledge_base"), true);
	assert.equal(serverAllowed(filtered, "openrouter"), false);
	const excluded = normalizeConfig({ excludeServers: ["openrouter"] });
	assert.equal(serverAllowed(excluded, "openrouter"), false);
});

test("config round-trips through the file override", () => {
	const dir = mkdtempSync(join(tmpdir(), "mcp-viz-cfg-"));
	process.env[CONFIG_ENV] = join(dir, "nested", "pi-mcp-viz.json");
	try {
		assert.equal(loadConfig().enabled, true); // missing file → defaults
		saveConfig({ ...loadConfig(), enabled: false, modalDelayMs: 1234 });
		const loaded = loadConfig();
		assert.equal(loaded.enabled, false);
		assert.equal(loaded.modalDelayMs, 1234);
	} finally {
		delete process.env[CONFIG_ENV];
	}
});
