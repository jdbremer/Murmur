# Overnight loop prompt (paste this to the agent)

Copy everything below the line into a new agent turn (or scheduled job).  
Prerequisites on the machine: `npm install` already done, agent deps present.

---

```
You are continuing the Murmur Windows port overnight. Do not wait for me.

## Contract
1. Read and obey:
   - WINDOWS-HANDOFF.md
   - scripts/agent/DEFINITION-OF-DONE.md
   - scripts/agent/README.md
2. “Done” only when gates **G0–G10** pass (human lock: hardened perfect).
   Defaults: **Right Ctrl** hold; **whisper.cpp .exe** STT first; paste proof = **Notepad**;
   injectPcm ok but also achieve a **pasted recognizable word** (G5b).
3. Shared contract changes allowed if needed; still prefer additive win/ files.
   Do not rewrite PLAN.md or the Mac HANDOFF.md work queue content.
4. After every meaningful change: typecheck, re-run the relevant agent gates,
   screenshot failures to .agent/screenshots/.

## Control plane
- Start control server if needed: npm run agent:server  (port 17321)
- CLI: npm run agent -- <cmd>
- Tools: start/stop, shot, click-text, click-xy, type, keys, play-mic, utterance, snapshot, take_screenshot
- In-app mic: play-mic / inject-pcm (primary). Do not require VB-Cable.

## Loop (repeat until stop condition)
while true:
  1. health + snapshot → identify lowest failing gate G*
  2. Implement the smallest change that can make G* pass
  3. npm run typecheck (and focused tests if you touch logic)
  4. agent start (or reuse session); run gate verification commands
  5. On pass: update WINDOWS-HANDOFF “Where things stand”; advance phase
  6. On fail: read screenshot + snapshot; fix or revert; do not skip gate
  7. If stuck >3 attempts on same gate: document blocker in WINDOWS-HANDOFF and
     move to the next gate that is unblocked (never leave the tree broken)
  8. Stop when G0–G10 all pass, or when the process is killed

## Priority order if multiple failures
A/G0–G2 → B/G3 → C/G4 → D/G5(+G5b word paste) → E/G6 Right Ctrl → G/G7 whisper.exe → F → H/G8–G10

## Safety
- **Commits OK; never `git push` / force-push / open remote PRs** until the human reviews locally
- No secrets, no destructive git unless asked
- Agent userData is isolated (MURMUR_AGENT=1)
- Do not commit .agent/ screenshots

## If gates are green or you are blocked waiting
Walk every Hub section + Bar + Help Dev tools. Ask: would I like this as a user?
Does it advance hold-key → speak → polished text on-device? Ship small UX fixes
(copy, empty states, Windows labels, errors with next actions) before idle.

Begin with: health, start if needed, snapshot, then work the lowest failing gate.
```

---

## One-liner to re-kick the agent

```
Continue overnight Murmur Windows loop per scripts/agent/OVERNIGHT-PROMPT.md and scripts/agent/DEFINITION-OF-DONE.md. Locked: G0–G10 stop, Right Ctrl default, whisper.exe STT first, Notepad paste, injectPcm + recognizable word paste, shared contracts ok, skip gate after 3 fails. Start agent server if down; health/snapshot; implement lowest failing gate; verify with screenshots/snapshot/agent CLI; repeat until G0–G10 pass or process killed.
```
