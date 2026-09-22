/**
 * Variant 2 — the auto-dismissing modal.
 *
 * A floating overlay that appears when an MCP call finishes and removes itself
 * after `modalDelayMs`, so it can never become a dialog the user has to close.
 * Any key dismisses it early; it never takes keyboard focus (`handle.unfocus()`),
 * because a notification must not swallow typing.
 *
 *   ╭─ MCP · KB ─────────────────────────────────╮
 *   │ kb_search  “NotesDocument GetItemValue”    │
 *   │ 3 hits · 3 docs · 1 334 tok · 0.9s         │
 *   │   GetItemValue (NotesDocument)      1.00   │
 *   │   Values property                   0.95   │
 *   ╰─ Esc / 2.4s ───────────────────────────────╯
 *
 * The card renders itself; the timer lives in the component so unmounting ends
 * the countdown.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
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

const MIN_WIDTH = 34;
const MAX_WIDTH = 68;
const TICK_MS = 200;

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

	private bodyLines(innerWidth: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const query = this.record.argsSummary ? ` “${clip(this.record.argsSummary, innerWidth - 16)}”` : "";
		lines.push(`${th.fg("toolTitle", this.record.target.tool)}${th.fg("dim", query)}`);

		const facts: string[] = [];
		if (this.record.resultSummary) facts.push(this.record.resultSummary);
		if (this.record.docs > 0) {
			facts.push(`${fmtInt(this.record.docs)} ${this.record.target.knowledgeBase ? "docs" : "payload"}`);
		}
		facts.push(`${fmtInt(this.record.docTokens)} tok`);
		if (this.record.durationMs !== undefined) facts.push(fmtMs(this.record.durationMs));
		lines.push(th.fg(this.record.isError ? "error" : "text", facts.join(" · ")));

		if (this.record.collections.length > 0) {
			lines.push(th.fg("dim", this.record.collections.join(", ")));
		}

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

		const th = this.theme;
		// Total width of every rendered line: "│ " + body + " │".
		const total = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width - 2));
		const bodyWidth = total - 4;

		return this.draw(th, total, bodyWidth, width);
	}

	private draw(th: Theme, total: number, bodyWidth: number, width: number): string[] {
		const title = `${th.fg("accent", "MCP")} ${th.fg("muted", "·")} ${th.fg("accent", this.record.target.badge)}`;
		// Frame math: ╭ + a + "↔ title ↔" + b + ╮ must be exactly `total` wide,
		// measured with visibleWidth because the title carries ANSI codes.
		const titleCell = ` ${title} `;
		const dashes = Math.max(0, total - 2 - visibleWidth(titleCell));
		const left = Math.floor(dashes / 2);
		const right = dashes - left;
		const top = `${th.fg("border", `╭${"─".repeat(left)}`)}${titleCell}${th.fg("border", `${"─".repeat(right)}╮`)}`;

		const row = (content: string): string => {
			const padded = truncateToWidth(content, bodyWidth);
			const filler = " ".repeat(Math.max(0, bodyWidth - visibleWidth(padded)));
			return `${th.fg("border", "│")} ${padded}${filler} ${th.fg("border", "│")}`;
		};

		const lines = [top];
		for (const body of this.bodyLines(bodyWidth)) lines.push(row(body));

		const hint = this.record.isError ? "Esc · failed" : `Esc · ${(this.remaining() / 1000).toFixed(1)}s`;
		lines.push(row(th.fg("dim", hint)));
		lines.push(th.fg("border", `╰${"─".repeat(total - 2)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
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
			(tui: TUI, theme: Theme, _keybindings, done) =>
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
				onHandle: (handle) => handle.unfocus(),
			},
		)
		.catch(() => undefined);
}
