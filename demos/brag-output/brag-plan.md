# Paireto — launch video plan

**What it is:** A VS Code extension that brings pair-programming to terminal coding agents: plan review, code review, guided review and Git-native change views, all inside the editor.
**For:** Engineers who run Claude Code, Codex, OpenCode, Kiro or Pi in a VS Code terminal and still hold their code to a human standard.
**What sets it apart:** No second app. Plans and diffs open as real VS Code editors, with LSP and linters still on.
**Best claim:** "Agents do 80% of the work. What's left is understanding, judgement, and coherence." (Paireto the Parrot)
**Visual hook:** The line builds on the beat, and the three words that matter land big and blue.
**Share caption:** see `share-copy.txt`.

## Angle
App Store feature tour. Each card has a blue eyebrow, a short headline and one support line on the left. On the right, a VS Code window does the job live: the cursor moves, text types, buttons click and the agent status changes.

## Tone and identity
- Tone: `app-store`. Clean cards and smooth horizontal slides, staggered (old content out, then new content in).
- Background `#191a1e` (exact logo background), with a soft blue glow.
- Accent `rgb(0,159,255)` parrot blue, coral `rgb(255,118,86)` beak, approve green `#2ea043` and feedback orange `#d17914` (from `media/*.svg`).
- Real assets: `ThePairotSvg.svg`, the wordmark cut from `PairetoLogo2x.png`, `approve.svg`, `send-feedback.svg`, `paireto.svg`, `media/status/*.svg` and VS Code's own `codicon.ttf`.
- The VS Code chrome is rebuilt in HTML with Dark Modern colours, because the product is native VS Code UI.
- UI strings and behaviour are the real ones from `package.json`, `MainTreeProvider.ts`, `ReviewController.ts` and `reviewSelectors.ts`:
  - The plan editor shows Approve until a comment exists, then Send Feedback in its place (`paireto.gateHasFeedback`).
  - In code review, Approve is in the Paireto view title.
  - The View Modes picker (Staging, Delta, Review, Tree, Flat) and the Compare To picker (HEAD, Stack base, Merge base, default branch, Branch/Ref…) use their real labels and details.
  - `merge-base(main)` and `N/M seen` follow the real formats.
- Fictional stand-ins: the repo `webhooks-service`, branches, file names, session id `a1b2c3d4`, plan text, comment text and terminal output. No real user data.

## Music
96 BPM (beat = 0.625 s), 72 beats = 45 s, D dorian. The style is trip-hop:
- Swung boom-bap drums (60% 16th swing) on a dusty low-passed bus.
- A Rhodes-style FM electric piano with auto-pan, comping Dm9 – G13 – Dm9 – Bbmaj9/A7.
- A sub bass and a soft pad.

The hook has only the piano. The drums enter filtered in bar 3 and open up on the drop at the reveal. The outro resolves to Dmaj9. The effects (clicks, key thocks, typing ticks, whooshes, approve chime) are tuned to the key and quantized to the grid. Every cut is on a beat.

## Storyboard (46 s)

The times below are music times. The video starts with a 1 s intro, so add 1 s to get the video time.

| # | Time | Beats | Scene | Content |
|---|---|---|---|---|
| 0 | −1.0–0.0 | — | Intro | The settled outro frame (the poster) holds, then fades out. A soft D swell rises into the first beat. |
| 1 | 0.0–7.5 | 12 | Hook | "Agents do **80%** of the work." builds word by word. "What's left is" comes in as one line that tracks in from wide letter spacing over the same 2 beats, then **understanding / judgement / coherence** land one per beat. Attribution "— Paireto (the Parrot)". |
| 2 | 7.5–11.25 | 6 | Reveal (drop) | The parrot slides up and the wordmark wipes in. "Pair-programming for your TUI coding agents, in VS Code." Agent chips: Claude Code · Codex · OpenCode · Kiro · Pi. |
| 3 | 11.25–21.25 | 16 | Plan Review — "Iterate on plans." | A comment types into the plan. On save, the Approve tick swaps for Send Feedback, in the tab and in the view title. The cursor clicks Send Feedback and the agent thinks. Round two: the plan reopens as `PLAN: … (revised)`, an inline diff of the previous plan against the revised one. Approve is back; the cursor clicks it and the agent starts work. |
| 4 | 21.25–28.75 | 12 | Code Review — "Review code in your editor." | The agent's diff calls a vague `policy.check(attempt)`. The user clicks it and presses ⇧F2. The rename box opens, "shouldRetry" types in, and ⏎ renames it everywhere: the changed files flash. The user clicks Approve in the Paireto view title and the agent goes idle. |
| 5 | 28.75–35.0 | 10 | Guided Review — "Follow the thread." | `/paireto:guided-review` types into the agent terminal. The agent thinks, then the Review Plan fills changeset by changeset and the plan document opens. The cursor opens the first changeset. |
| 6 | 35.0–41.25 | 10 | Git Native Views — "Git diffs with super powers." | Staging view at HEAD. Compare To → Merge base adds the Committed group. View Modes → Delta, then Review, with seen checkboxes ticked (2/7 seen). |
| 7 | 41.25–45.0 | 6 | Outro | Parrot and wordmark, "Pair-program with your agents, in VS Code.", "Install “Paireto” from the VS Code Marketplace". The final Dmaj9 rings out. |

Poster: the settled outro frame, which is also frame 0.
