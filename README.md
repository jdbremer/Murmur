# Murmur

**Local-first dictation for macOS.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose — including models developed outside the US — so no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (hold `fn`) + hands-free mode
- 🧠 Local STT (SenseVoice, Parakeet, Whisper, Paraformer, …) and local polishing LLMs (Qwen3, Mistral, EuroLLM, …) with origin + license labels and a region filter
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Status

Planning. The full product & engineering plan lives in **[PLAN.md](./PLAN.md)** — UX spec, architecture, model catalogs, roadmap (M0–M6), risks, and open questions.
