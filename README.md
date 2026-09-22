# pi-mcp-viz

Visualize MCP activity in Pi: see **when** an MCP server is working, **what** it
returned, and **how many tokens** those documents cost. Built for the knowledge
base (`knowledge_base_kb_search`, `kb_read_source`), but generic — openrouter,
metaculus, the lotusscript LSP and anything else in `~/.pi/agent/mcp.json` show up
the same way.

```text
▸ ▐KB▌ kb_search “NotesDocument GetItemValue array”          3 hits · 1.3k tok · 940ms
  📚 3 docs · 1 334 tok · lotus-notes
    Usage — GetItemValue (NotesDocument) 1.00 800 tok
    Examples                             0.90 434 tok
```

## Is this general or KB-specific?

Both, split deliberately:

| Concern | Scope |
|---|---|
| Detection (`classifyTool`) | **General** — server names are read from `~/.pi/agent/mcp.json`, so a new MCP server needs no code change. All three name shapes pi produces are handled: `knowledge_base_kb_search`, `knowledge-base_kb_search`, `mcp__knowledge_base`, and the `mcp` gateway. |
| Token counter (`payloadTokens`) | **General** — every text byte an MCP tool returned. |
| Document counter (`docs`, `docTokens`) | **KB-specific by shape, general in practice** — documents are recognized from the payload itself: `results[]` (one document per hit) or a whole-document payload (`text` + `chars`). Servers without that shape report their payload as one document. |
| Rendering | **General** — one card/modal/status format for all servers; the KB just gets the 📚 icon and per-document detail, because for a documentation server "how much context did this pull in?" is answerable per document. |

Nothing in the plugin overrides an MCP tool or modifies its result. It only
listens.

## The three visualization variants

All three are independent and can be combined. `/mcp-viz variant <name>` toggles
them at runtime. **The shipped default is the modal alone** (3 s delay); the other
variants are opt-in.

### 1. `entry` — transcript card (default off)

Durable, inline in the conversation like a built-in tool row, expandable with the
tools-expand keybinding, and **never sent to the model** (it is a custom entry,
not a message). Persisted in headless runs too, so a session exported with
`pi --export` still shows what MCP returned; the modal and the status badge are
interactive-only.

```text
▸ ▐KB▌ kb_search “NotesDocument GetItemValue array”          3 hits · 1.3k tok · 940ms
  📚 3 docs · 1 334 tok · lotus-notes
    Usage — GetItemValue (NotesDocument) 1.00 800 tok
    Examples                             0.90 434 tok
    Values property                      0.80 100 tok
    args {"collection":"lotus-notes","query":"NotesDocument GetItemValue array"}
```

Detail level is configurable: `0` = one line, `1` = documents listed, `2` = also
the raw arguments.

### 2. `modal` — auto-dismissing overlay (default on)

A floating card in the top-right corner that removes itself after `modalDelayMs`
(**3 s by default**). Any key dismisses it early. It never takes keyboard focus,
so it cannot swallow typing, and it hides itself on terminals narrower than 72
columns.

The card is styled through the active theme's semantic colour keys, which under
the Linkarzu palette resolve to that theme's own colours: the double frame and
the title use its green (`borderAccent`/`accent`), the tool name its cyan
(`toolTitle`), the header bar sits on `selectedBg` and the body on
`userMessageBg`. Inner colour resets are re-opened so the background fill stays
solid across the whole row.

```text
╔══════════════════════════════════════════════════════════════════════╗
║ MCP · KB                                             1 939 tok       ║
╟──────────────────────────────────────────────────────────────────────╢
║ kb_search “NotesDocument GetItemValue array of strings”              ║
║ 10 hits · 10 docs · 1 939 tok · 2.8s · lotus-notes                   ║
║   Examples: GetItemValueDateTimeArray method 1.00 329 tok            ║
║   Usage — GetItemValue (NotesDocument - LotusScript) 0.97 177 tok    ║
║   GetItemValueDateTimeArray (NotesDocument - LotusScript) 0.97 82 tok║
║   … +7 more                                                          ║
║ Esc · 3.0s                                                 mcp-viz   ║
╚══════════════════════════════════════════════════════════════════════╝
```

It is 90 columns wide (a third wider than the original 68) and clamps to the
terminal width, so the frame stays aligned on smaller screens. A failed call
switches the frame and title to the theme's `error` colour.

### 3. `status` — footer badge (default off)

One dim line, updated live while the call runs (with elapsed time) and replaced
by the summary afterwards, then cleared on `statusTtlMs`:

```text
📚 KB kb_search… 1.2s
📚 KB 3 docs · 1.3k tok · 940ms · session 7 calls 12k tok (12k KB)
🔌 OR 3 payloads · 1.0k tok · 410ms
```

## Token counter

| Field | Meaning |
|---|---|
| `payloadTokens` | every text byte the tool returned (chars/4) |
| `docTokens` | only the documents: each KB hit's `text`, or the whole document from `kb_read_source` |
| `docs` | number of documents (KB hits, or 1 for a whole-document read) |
| `kbDocs`, `kbDocTokens` | session totals for the knowledge base only |

Estimation uses pi's own heuristic (chars/4, the one `estimateTokens` in
`core/compaction` uses), so the numbers are directly comparable with the context
usage in the footer. It overestimates slightly, and it counts **what the tool
returned**, not what pi kept after truncation.

Session totals are persisted as a hidden custom entry, so `/reload`, `/tree`
navigation and resume all rebuild the same numbers from the branch.

## Install

```bash
# settings.json (global) — local path form
{
  "packages": [
    { "source": "D:/01_programovani/pi/plugins/pi-mcp-viz" }
  ]
}
```

No `extensions` filter is needed: the package manifest points at `./index.ts`.
Restart pi afterwards.

## Commands

```text
/mcp-viz                            # help
/mcp-viz on | off                   # master switch
/mcp-viz variant entry|modal|status [on|off|toggle]
/mcp-viz modal <ms>                 # overlay auto-dismiss delay
/mcp-viz ttl <ms>                   # status badge lifetime (0 = keep until replaced)
/mcp-viz detail <0|1|2>             # card detail level
/mcp-viz server include|exclude|clear <name>
/mcp-viz status                     # config + session counters, per server
/mcp-viz tail [n]                   # last calls
/mcp-viz reset                      # zero the session counters
```

Config lives in `~/.pi/agent/pi-mcp-viz.json`; every option has a default, and an
invalid value is clamped rather than rejected.

## How it hooks into pi

| pi API | Use |
|---|---|
| `pi.on("tool_execution_start"/"tool_execution_end")` | timing, result, error flag — fires for every tool, MCP included, without overriding anything |
| `pi.appendEntry` + `pi.registerEntryRenderer` | variant 1: durable card that stays out of the model context |
| `ctx.ui.custom(..., { overlay: true, onHandle })` | variant 2: floating card, `handle.unfocus()` so input is never stolen |
| `ctx.ui.setStatus(key, text)` | variant 3: footer badge, cleared on a timer |
| `ctx.sessionManager.getBranch()` | restore session totals from the current branch |
| `pi.registerCommand` | `/mcp-viz`, with lazy autocompletion (servers are read from mcp.json on demand) |

Events fire in parallel-tool mode too: a start event that never matches an end
event is recovered by tool name, so a card is still produced with real duration.

## Testing

```bash
npm test        # tsc && node --test dist/test/*.test.js
```

30 tests, no terminal required:

| File | Covers |
|---|---|
| `test/detect.test.ts` | classification against tool names copied from real sessions, fixture mcp.json, config clamping |
| `test/tokens.test.ts` | chars/4 estimation, KB `results[]` and whole-document payloads, gateway unwrapping, malformed input |
| `test/visuals.test.ts` | rendered card/modal strings, width safety, auto-dismiss timer, status line wording |
| `test/extension.test.ts` | the real extension driven by a mock ExtensionAPI: entries, status writes, modal call, trace log, non-MCP tools ignored, `/mcp-viz` subcommands |

Set `PI_MCP_VIZ_LOG`, `PI_MCP_VIZ_CONFIG` and `PI_MCP_VIZ_MCP_JSON` to redirect
the trace, config and server list (used by the tests and by headless runs).

## Limitations

- Interleaved parallel MCP calls are matched by `toolCallId`; only when an end
  event arrives without its start is the oldest same-tool call used instead.
- The `mcp` gateway tool is reported as its own server (`MCP`), because its
  arguments name the target server and the tool result does not.
- Token counts are estimates; a document counted here may be truncated later by
  compaction, and this plugin does not model that.
- The modal is hidden below 72 columns; the terminal cards remain.
