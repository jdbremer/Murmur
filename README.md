# Murmur

**Local-first dictation for macOS.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose from a **US-only catalog** — every listed model comes from a US-based organization, enforced by the catalog's origin policy — and no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (hold `fn`) + hands-free mode
- 🧠 Local STT (Parakeet, Whisper, Moonshine, …) and local polishing LLMs (Gemma 3, Phi-4-mini, Llama 3.2, OLMo 2, …) — US-origin only, with origin + license labels
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Status

Planning. The full product & engineering plan lives in **[PLAN.md](./PLAN.md)** — UX spec, architecture, model catalogs, roadmap (M0–M6), risks, and open questions.
