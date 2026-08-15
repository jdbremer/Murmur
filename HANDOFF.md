# Handoff — product-wide remaining work

**Scope: the whole app** (macOS + Windows + shared). Platform-specific queues:

| Doc                                            | Scope                                                        |
| ---------------------------------------------- | ------------------------------------------------------------ |
| **[HANDOFF.md](./HANDOFF.md)** (this file)     | Cross-platform product, UX, catalog, security, CI            |
| **[MAC-HANDOFF.md](./MAC-HANDOFF.md)**         | macOS-only (native module, Metal, notarization, field proof) |
| **[WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md)** | Windows-only (native hook/paste, sidecars, agent loop)       |

Canonical product/engineering spec remains **[PLAN.md](./PLAN.md)**. Layout and
IPC conventions: **[README.md](./README.md)**.

---

## Product backlog (app-wide) — **do these next**

### 1. Spoken-language selection → STT

**Ask:** Would it help to let the user pick which language they expect to speak,
and pass that into the model?

**Answer / work:** Yes — especially for Whisper (and later Parakeet). Today
`settings.language` exists and is used in polish prompts / some STT paths, but
the UX is easy to miss and first-run does not guide it.

**Ship:**

- Clear Settings (and onboarding) control: **language I speak** (and optional
  “auto / multilingual”).
- Wire that value into every STT engine call that accepts a language hint
  (`whisper-server` language / initial prompt; ONNX decode when applicable).
- Document which catalog models are `en` vs `multi` so the picker can warn when
  the model cannot honor the choice.

### 2. NVIDIA Parakeet in the catalog

**Ask:** Why isn’t NVIDIA’s Parakeet listed? It should be performant.

**Answer (current policy):** PLAN §6.2 wants Parakeet-TDT as the recommended
default, but NVIDIA ships **`.nemo` checkpoints**, not ONNX. Catalog rules
require pinned, origin-auditable downloads — community NeMo→ONNX re-uploads
are not listed as NVIDIA. See **[scripts/models/export-parakeet.md](./scripts/models/export-parakeet.md)**.

**Ship:**

- Run the first-party NeMo→ONNX export, verify against NVIDIA reference
  transcripts, host weights with SHA-256 pins.
- Add a catalog entry (US origin, license labels) and make it the default STT
  recommendation on capable machines once validated.
- Until then, keep Whisper family as the honest recommended STT defaults.

### 3. ~~Dedicated History tab for transcriptions~~ — **done**

Home is now **History**, a first-class sidebar entry, and each row names the app
it landed in rather than only its tone category. The three headline numbers that
used to sit on top of it moved to the new **Insights** section, where they have
room to be more than three numbers.

Still open from the original ask: expand-a-row for the full raw-vs-polished
transcript and the model ids, and re-copy / re-insert / re-polish from a row
(PLAN M4+).

### 4. Transient “clipboard insurance” UI after dictation

**Ask:** Show the finished text for a moment with a **Copy** button, in case
insert into the focused app fails.

**Ship:**

- On `inserted` **and** on `insert-failed` (and optionally always): a short-lived
  Hub toast and/or Bar affordance showing the final text + **Copy**.
- On insert failure, keep the toast until dismissed (not only 3 s).
- Prefer the same text that would have been pasted (polished if any, else raw).
- Do not log the text to disk beyond normal history rules.

---

## Privacy / network (app-wide)

- **No offload of speech or transcripts.** Dictation and polish run on-device
  (or on a user-configured loopback/external endpoint the user opted into).
- **Outbound network is pull-only and user-initiated:**
  - Model weights: Hugging Face allowlist (`net/fetch.ts`).
  - Optional Windows sidecar install: GitHub Releases for `whisper-server` /
    `llama-server` after an explicit confirm in Models UI.
- No accounts, analytics, or crash uploads.

---

## Other shared follow-ups

| Item                      | Notes                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vibe coding on Windows    | `readFocusedEditorText` is macOS-only; needs the UI Automation `TextPattern` equivalent. The setting and UI already exist and say so plainly (PLAN §18.3)             |
| Insights: WPM percentile  | Compared against a static published typing-speed table. Worth revisiting if a better offline reference exists — it must never become a comparison against other users |
| Scratchpad polish         | Markdown preview, drag-to-reorder, "send last dictation to a note"                                                                                                    |
| Onboarding polish         | Mac path more complete; Windows still needs platform-true permission copy                                                                                             |
| Streaming partials in Bar | PLAN M5                                                                                                                                                               |
| CI matrix                 | macOS exists; add Windows leg (`typecheck` / `test` / `native:build`)                                                                                                 |
| Packaging                 | DMG (Mac) / NSIS (Windows) still release-track                                                                                                                        |

---

## How the handoff docs relate

```
PLAN.md              product + architecture (durable)
HANDOFF.md           cross-platform product queue  ← you are here
MAC-HANDOFF.md       macOS residual / field notes
WINDOWS-HANDOFF.md   Windows residual / agent gates
```
