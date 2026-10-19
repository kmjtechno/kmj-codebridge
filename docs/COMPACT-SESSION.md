# Compact Session — durable small engineering handoffs

**Scope: CodeBridge only, user opt-in, no paid AI or external service.**

## Goal

Lower repeated chat context payloads without claiming to expand any ChatGPT,
Claude, Gemini or third-party model context window. CodeBridge cannot modify
provider token ceilings, host UI or hidden model chat-history management.

Already available: `chat_continuity_save`, `multi_chat_sync`,
`context_resume`, `large_prompt_plan`, `context_pack` and
`fast_read_batch`. The new `compact_session_save` and
`compact_session_resume` expose a richer **structured, durable** handoff.

## Chat client usage

After a major engineering milestone, or before a chat becomes too long:

1. Call `compact_session_resume({device,project,lane})` to obtain the current
   `revision` or null. A lane name is a stable caller-chosen label.
2. Collect only verified constraints, decisions, objectives and user-authorized
   facts from the chat already visible to the client. Do not silently omit
   critical requirements; do not send transcript text, secrets or personal data.
3. Call `compact_session_save` with `requestKey` and the observed
   `expectedRevision`, `objective`, `summary`, `decisions`, `constraints`,
   `evidence`, `blockers` and `nextSteps`. This is a device-local write and
   requires project write permission. A stale revision fails rather than
   overwriting another chat's checkpoint.
4. Start another chat if desired; call `compact_session_resume` with the
   same authorized `device`, `project` and `lane`. Its `handoff` text is
   portable; it includes the revision and explicitly labels claims unverified.
5. In the resumed chat, **call `context_resume`** and fresh GitHub/CI reads
   for actual current progress. Never treat old handoff text as live production
   evidence or instructions that supersede current user approvals.
6. For polling within the same chat, pass `ifNoneMatch` as prior revision for
   a small `unchanged` response if no checkpoint changed.

## Security and design

- Separate device-local `compact-sessions` directory (0700), hashed
  project/lane file names and 0600 data, atomic rename and fsync.
- Checksum revision guards corruption; CAS and idempotent request keys guard
  stale multi-chat updates. **Checksum is not authentication** of facts.
- Strict text and section bounds; no silent truncation; no URLs, emails,
  credentials, multi-line transcripts, passwords or secret-looking tokens.
- The write is not an LLM summarizer and **cannot access the ChatGPT conversation**;
  its arguments must be supplied by the calling assistant/client.
- Human-reviewed locked constraints always take precedence over compact
  hints. Source, claimed evidence and completion status are untrusted until
  independently checked.
- No automatic memory injection into future chats, no host chat reset,
  unlimited-context claims, background jobs, model download, AI charges,
  DNS/production changes or automatic ChatGPT waking.

## Exact-head tests

`node --test tests/compact-session.test.js`

`npm run check`

`npm test`

`npm run scan:secrets`

A green GitHub PR requires an approved CodeBridge gateway/agent rollout before
these tools are visible to a connected ChatGPT/Claude/Gemini client. A
GitHub merge **alone is not deployment**. Preserve existing dirty P720 files.

## Not yet included

Native ChatGPT UI `/compact` command, host-controlled context window size,
automatic model summarization, chat transcript ingestion, or periodic scheduled
compactions. Clients can opt in to call the new tools, but cannot override
the provider's underlying chat memory controls.
