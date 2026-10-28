# KMJ CodeBridge — Locked Hyperspeed AI Workspace (v1)

**Design approval:** Owner-approved visual direction in the conversation on 2026-10-28, using the generated dark-neon three-panel AI chat workspace image.  
**Status:** DESIGN LOCKED — change layout, palette, interaction semantics or official KMJ branding only with new owner approval.  
**Target product:** KMJ CodeBridge's own web dashboard and MCP Apps Mission Control; **not** the ChatGPT.com host application.  
**Implementation status:** SPECIFICATION ONLY. This document does **not** claim the screenshot is implemented, the new chat backend works, a local/cloud model is connected, or production is deployed.

## Locked visual identity

- **Brand:** KMJ TECHNO / KMJ CodeBridge. Keep the existing official product artwork and identity. Never import or impersonate the ChatGPT/OpenAI name, icons, logo or proprietary styling assets.
- **Theme:** premium, high-contrast navy/black; subtle blue/cyan highlights, restrained violet gradients and green verified-success signals. No distracting continuous glow or large moving backgrounds.
- **Desktop anatomy:** persistent collapsible left navigation (projects, recent chats, pinned workspaces); broad center chat/streaming canvas; compact, optional right context drawer (tools, verified status, connection/model availability). Composer pinned to the center pane bottom.
- **Small screens:** one useful content column; left drawer and right inspector closed by default; composer remains accessible without covering messages. Keyboard and screen-reader behavior first-class.
- **Typography/layout:** readable 14–16px message text, 1.45–1.7 line height, accessible contrast, 8px spacing scale, cards with subtle 1px edges and 10–16px radii. Do not shrink body text to replicate a screenshot.
- **Components:** well-spaced user/assistant message bubbles, streamed Markdown/code/citations, grouped tool-call receipt timeline, collapsible verbose progress, searchable conversations, compact project/workstream chips, optional keyboard palette, quick follow-up chips, model/provider picker that only lists actually connected providers.
- **Status colors:** green = independently verified success, amber = waiting/attention, red = verified failure, cyan = running, grey = unknown. No arbitrary completion percentages or synthetic running counts.

## Locked information architecture

```text
CodeBridge app viewport
├── Left nav        Projects · Conversations · Tasks · Devices · Settings
├── Center          Workspace header (project + session) · Chat history · Live tool receipts
│                   Helpful result cards · Stream control · Sticky multiline composer
└── Right inspector Device/job status · Model/provider availability · Permissions · Audit
```

The right inspector must remain optional and never narrow the center chat below readable width. A compact "Mission Control" view summarizes verified tasks; it must not be a copy of ChatGPT's native control panels.

## What "full ChatGPT-style" means here

**Implement in CodeBridge-owned UI:** multi-conversation chat, search, keyboard shortcuts, rich Markdown, code copy, attachments with backend approval, tool-call receipts, live run status, resumable streams, stop/retry controls, authorized project context, pinned lanes and collaboration-oriented layout.

**Not possible in a third-party host:** replace ChatGPT.com global navigation/chrome/sidebar, native model selector, built-in memory controls or account settings from a CodeBridge MCP app. MCP Apps must render inside the host-provided, permissioned frame; do not attempt browser CSS injection, unapproved extensions, spoofed native controls or client security bypass.

**Do not misrepresent the backend:** a polished chat screen is not proof of working provider connectivity, inference, autonomous coding, payment or production deployment. Model choices use verified availability; unavailable providers are not presented as working.

## Hyperspeed performance contract (targets, not current measured results)

- First useful UI shell quickly from locally bundled assets; prefer native HTML/CSS and minimal JS over large imported UI libraries. Zero new paid services.
- Input remains responsive during streaming. Isolate animation from state updates, batch stream tokens by animation frame or bounded throttle, and avoid rerendering the entire thread for each token.
- Virtualize/window long conversations; never mount thousands of expanded tool rows simultaneously. Lazy-render code highlighting/Markdown blocks and defer heavy inspectors.
- Stream incrementally with explicit reconnect/retry/cancel, bounded buffers and backpressure. Never replay commands automatically on reconnect or on a failed acknowledgment.
- Collapse old tool logs by default; show at most recent summaries unless user expands. Preserve exact timestamps and audit/job IDs, not fake elapsed times or guessed percentages.
- Avoid polling storms: use scoped streaming events where authorized, bounded retries/jitter and pause hidden tabs. Throttle updates, respect `prefers-reduced-motion` and low-power mobile.
- Initial targets to validate on test devices: no long tasks over 50ms during typical text streaming, target 60 FPS interactions on a modern desktop, keyboard response under 100ms in normal operation, and 1000+ messages with bounded rendered DOM. **Record measurements; never claim achieved until benchmarked.**
- Safe failure: no fabricated "AI is thinking" status when no provider/executor is connected; render an actionable disabled state. No raw secret, private path, host environment or tool token in HTML or receipts.

## Implementation slices and honest gates

1. **A — Lock & shell:** persistent layout, official logo, design tokens, responsive/accessibility snapshots, empty/unknown state, no new backend.
2. **B — Chat engine:** authorized session list and resume, streamed assistant text, cancel/retry, Markdown sanitization and copy. Only after real host/provider capability check.
3. **C — Workstream receipts:** existing CodeBridge job journal, live tool timeline, exact project/device scopes, structured failure states; avoid fake percentages and job claims.
4. **D — Optional inspector:** model/provider availability, permission state, current agent/device status, contextual controls; all read from verified backend.
5. **E — Release:** exact-head Linux/Windows CI, UI accessibility QA, mobile/desktop visual QA against owner visual baseline, staging proof, security review, owner approval and rollback. Production status is independent of GitHub merge.

## Open-source inspiration and adoption policy

Review documented ideas rather than blindly copying dependency trees or designs:

- [Lumi UI](https://github.com/mrigankad/Lumi-UI) — chat streaming/composer/theming patterns; inspect source license before reuse.
- [Cognipeer Chat UI](https://github.com/Cognipeer/chat-ui) — collapsible tool activity and streaming; only protocol-compatible ideas.
- [Serkanbyx Chat UI](https://github.com/Serkanbyx/chat-ui) — conversation navigation, shortcuts and fine-grained state management.
- [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) — hosted-client-specific UI protocol and permission boundaries.

No upstream assets, icons, logos, code, library package or paid API is imported by this spec. Any future code reuse must pass per-file licensing, attribution, dependency audit and product compatibility review.

## Non-negotiable QA

- Desktop/tablet/mobile, keyboard-only, screen reader and reduced-motion coverage.
- Long-chat benchmark: history pagination/windowing + streaming input responsiveness; publish measured profiles, not estimates.
- Cross-chat state: no duplicate tool execution; idempotent receipts, isolated project permissions, handled disconnect/reconnect.
- Dark/light readability, graceful narrow-width rendering, empty and disconnected states.
- Official KMJ branding exact identity preserved; no ChatGPT/OpenAI logos or impersonation.
- Source-only PR ≠ production activation; healthy connected device ≠ real autonomous coder; generic signed Beta ≠ Stable release.

**Lock rule:** these sections are the acceptance baseline. A material deviation must be reviewed and explicitly approved by the owner before changing the design.
