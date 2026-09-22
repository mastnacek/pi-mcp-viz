/**
 * Variant 2 — the auto-dismissing modal.
 *
 * A floating overlay that appears when an MCP call finishes and removes itself
 * after `modalDelayMs`, so it can never become a dialog the user has to close.
 * Any key dismisses it early; it never takes keyboard focus (`handle.unfocus()`),
 * because a notification must not swallow typing.
 *
 * Styling follows the active theme through semantic colour keys, which under the
 * Linkarzu palette resolve to that theme's identity: `borderAccent`/`accent` are
 * its green (#37f499), `toolTitle` its cyan (#04d1f9), the header bar is
 * `selectedBg` (#013e4a) and the body sits on `userMessageBg` (#141b22).
 *
 *   ╔══════════════════════════════════════════════════════════╗
 *   ║ MCP · KB                        3 docs · 1 334 tok       ║
 *   ╟──────────────────────────────────────────────────────────╢
 *   ║ kb_search “NotesDocument GetItemValue array of strings”  ║
 *   ║ 3 hits · 3 docs · 1 334 tok · 940ms · lotus-notes        ║
 *   ║   Usage — GetItemValue (NotesDocument) 1.00 800 tok      ║
 *   ║ Esc · 2.0s                                      MCP viz  ║
 *   ╚══════════════════════════════════════════════════════════╝
 */

import type { Component, KeybindingsManager, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { clip, fmtInt, fmtMs, fmtTokens } from "../tokens.js";
import type { McpCallRecord } from "../types.js";

export interface ModalOptions {
	delayMs: number;
	maxHits: number;
	/** Called once, when the card dismisses itself or the user closes it. */
	onDone: () => void;
	/** TUI repaint hook for the countdown. */
	requestRender: () => void;
}

const MIN_WIDTH = 40;
/** One third wider than the original 68 columns. */
const MAX_WIDTH = 90;
const TICK_MS = 200;

/** Background colour names accepted by `theme.bg()` (not exported by pi). */
type ThemeBgName = Parameters<Theme["bg"]>[0];

/** Resets that an inner `theme.fg()` may emit, all of which also end the fill. */
const INNER_RESETS = ["\u001b[0m", "\u001b[39m", "\u001b[49m"];

/**
 * Fill a whole row with a background colour, keeping the fill solid across the
 * inner colour resets.
 *
 * `theme.bg()` only wraps the string, so any reset emitted by an inner
 * `theme.fg()` ends the background too — the fill then stops mid-row and the
 * panel gets a ragged right edge. The opening sequence is read back out of a
 * one-character `bg()` call (the only API renderers are guaranteed), and
 * re-opened after every inner reset so the bar stays solid regardless of how the
 * active theme emits its codes.
 */
function fillRow(theme: Theme, key: ThemeBgName, text: string): string {
	const probe = "\u0000";
	const wrapped = theme.bg(key, probe);
	const boundary = wrapped.indexOf(probe);
	const open = boundary >= 0 ? wrapped.slice(0, boundary) : "";
	const close = boundary >= 0 ? wrapped.slice(boundary + probe.length) : "\u001b[0m";
	if (open === "") return theme.bg(key, text);

	let body = text;
	for (const reset of INNER_RESETS) body = body.split(reset).join(`${reset}${open}`);
	return `${open}${body}${close === "" ? "\u001b[0m" : close}`;
}

export class McpModalCard implements Component {
	private readonly theme: Theme;
	private readonly record: McpCallRecord;
	private readonly options: ModalOptions;
	private readonly startedAt = Date.now();
	private timer?: ReturnType<typeof setInterval>;
	private closed = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(theme: Theme, record: McpCallRecord, options: ModalOptions) {
		this.theme = theme;
		this.record = record;
		this.options = options;
		this.timer = setInterval(() => this.tick(), TICK_MS);
		// Never keep the process alive just for the countdown.
		this.timer.unref?.();
	}

	private tick(): void {
		if (this.closed) return;
		if (Date.now() - this.startedAt >= this.options.delayMs) {
			this.dismiss();
			return;
		}
		this.invalidate();
		this.options.requestRender();
	}

	private dismiss(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.options.onDone();
	}

	/** Stop the timer (called on dismiss and by the host on unmount). */
	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	handleInput(): boolean {
		this.dismiss();
		return true;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private remaining(): number {
		return Math.max(0, this.options.delayMs - (Date.now() - this.startedAt));
	}

	/** Facts line: what came back and what it cost. */
	private facts(): string {
		const parts: string[] = [];
		if (this.record.resultSummary) parts.push(this.record.resultSummary);
		if (this.record.docs > 0) {
			const unit = this.record.target.knowledgeBase ? "doc" : "payload";
			parts.push(`${fmtInt(this.record.docs)} ${unit}${this.record.docs === 1 ? "" : "s"}`);
		}
		parts.push(`${fmtInt(this.record.docTokens)} tok`);
		if (this.record.durationMs !== undefined) parts.push(fmtMs(this.record.durationMs));
		if (this.record.collections.length > 0) parts.push(this.record.collections.join(", "));
		return parts.join(" · ");
	}

	private bodyLines(innerWidth: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const query = this.record.argsSummary ? ` “${clip(this.record.argsSummary, innerWidth - 16)}”` : "";
		lines.push(`${th.fg("toolTitle", this.record.target.tool)}${th.fg("muted", query)}`);
		lines.push(th.fg("text", this.facts()));

		for (const hit of this.record.hits.slice(0, this.options.maxHits)) {
			const relevance = hit.relevance === undefined ? "" : ` ${hit.relevance.toFixed(2)}`;
			const tokens = ` ${fmtTokens(hit.tokens)} tok`;
			const title = clip(hit.title, Math.max(8, innerWidth - relevance.length - tokens.length - 4));
			lines.push(`  ${th.fg("text", title)}${th.fg("success", relevance)}${th.fg("dim", tokens)}`);
		}

		const hidden = this.record.hits.length - this.options.maxHits;
		if (hidden > 0) lines.push(th.fg("dim", `  … +${hidden} more`));
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		// Total width of every rendered line: "║ " + body + " ║".
		const total = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width - 2));
		const lines = this.draw(total);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private draw(total: number): string[] {
		const th = this.theme;
		const failed = this.record.isError === true;
		const frameColor = failed ? "error" : "borderAccent";
		const inner = total - 4;

		// A padded, background-filled line between two frame rails.
		const rail = (content: string): string => {
			const clipped = truncateToWidth(content, inner);
			const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
			return `${th.fg(frameColor, "║")} ${fillRow(th, "userMessageBg", padded)} ${th.fg(frameColor, "║")}`;
		};

		const lines: string[] = [];
		lines.push(th.fg(frameColor, `╔${"═".repeat(total - 2)}╗`));

		// Header bar: title left, the token count right — the prominent part.
		const title = `${th.bold(th.fg(failed ? "error" : "accent", "MCP"))} ${th.fg("muted", "·")} ${th.bold(
			th.fg(failed ? "error" : "accent", this.record.target.badge),
		)}`;
		const summary = `${fmtInt(this.record.docTokens)} tok`;
		const gap = Math.max(1, inner - visibleWidth(title) - summary.length - 1);
		const headerContent = `${title}${" ".repeat(gap)}${th.fg("muted", summary)}`;
		const headerPadded =
			truncateToWidth(headerContent, inner) +
			" ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(headerContent, inner))));
		lines.push(`${th.fg(frameColor, "║")} ${fillRow(th, "selectedBg", headerPadded)} ${th.fg(frameColor, "║")}`);

		// Separator between bar and body.
		lines.push(th.fg(frameColor, `╟${"─".repeat(total - 2)}╢`));

		for (const body of this.bodyLines(inner)) lines.push(rail(body));

		const hint = failed ? "Esc · failed" : `Esc · ${(this.remaining() / 1000).toFixed(1)}s`;
		const brand = "mcp-viz";
		const hintGap = Math.max(1, inner - hint.length - brand.length);
		lines.push(rail(`${th.fg("dim", hint)}${" ".repeat(hintGap)}${th.fg("dim", brand)}`));

		lines.push(th.fg(frameColor, `╚${"═".repeat(total - 2)}╝`));
		return lines;
	}
}

/**
 * Show the modal for one finished call. Returns immediately; the promise from
 * `ctx.ui.custom()` is observed only so a rejection cannot become an unhandled
 * rejection in the middle of a session.
 */
export function showCallModal(
	ctx: ExtensionContext,
	record: McpCallRecord,
	config: { modalDelayMs: number; maxHits: number },
): void {
	void ctx.ui
		.custom<undefined>(
			(tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (value: undefined) => void) =>
				new McpModalCard(theme, record, {
					delayMs: config.modalDelayMs,
					maxHits: config.maxHits,
					onDone: () => done(undefined),
					requestRender: () => tui.requestRender(),
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: MAX_WIDTH,
					margin: 1,
					visible: (termWidth: number) => termWidth >= 72,
				},
				// Informational only: release input so typing keeps working.
				onHandle: (handle: OverlayHandle) => handle.unfocus(),
			},
		)
		.catch(() => undefined);
}