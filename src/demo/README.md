# Paireto product demo

Records a product demo of Paireto in a real VS Code window and renders it as an edited video, with
auto-zoom on each interaction, a drawn cursor with click ripples, chapter cards, and an intro and outro.
The whole process is repeatable: edit the config, then record again.

## Commands

All three run in the Docker `tests` service (see `docker/README.md`), so no window opens on the host.

```sh
pnpm demo:record   # live agent: saves a new cassette, captures the screen, renders the video
pnpm demo:replay   # replays the cassette, no credentials: captures the screen, renders the video
pnpm demo:render   # renders the video again from the last capture, for style-only changes
```

The output is `demo-out/paireto-demo.mp4`. The same folder holds the raw capture (`capture.mp4`) and the
event timeline (`timeline.json`) that the renderer edits.

## Which command to run

| You changed                                                                   | Run                |
| ----------------------------------------------------------------------------- | ------------------ |
| Video style: zoom, timing, chapter titles, colours, intro, outro              | `pnpm demo:render` |
| Something the agent does not see: pacing, camera focus, hover or peek targets | `pnpm demo:replay` |
| Something the agent sees: prompts, comment text, edits, the sample project    | `pnpm demo:record` |

A replay fails, with a diff, when the agent sends a request that the cassette does not hold. Record
again to fix it. If the request only differs in a value that changes on each run, normalize that value
in `src/e2e/proxy/normalize.ts` instead. Run `PAIRETO_SHIM_DUMP=.shimdump pnpm demo:replay` to write
each request the shim sees to `.shimdump/`.

`pnpm demo:record` uses your Claude subscription the same way `pnpm e2e:record:docker` does. It stages
your Claude credentials with `docker/prepare-e2e.sh`. A record run takes about 15 minutes.

## How it works

1. `docker/demo.sh` boots the container, builds the VSIX, and creates the demo user. VS Code runs as a
   normal user, because as root it shows `[Superuser]` in the title. The user name is the comment
   author shown in the video. Set `PAIRETO_DEMO_USER` to change it.
2. `record.ts` builds the sample project (`sandbox/`) as a git repo with a `main` commit and a feature
   branch commit. It installs the Paireto Claude plugin with the `claude plugin` CLI, the same way the
   Welcome screen does.
3. Claude Code runs in the VS Code terminal. Its traffic goes through the E2E normalizing proxy and
   MockServer (`src/e2e/mockserver`). Record mode saves the traffic to
   `src/demo/cassettes/demo.claudecode.json`. Replay mode answers from that file.
4. Playwright drives VS Code with real mouse and keyboard input on a virtual 2x display. ffmpeg records
   the display. The `Director` logs every move, click, key, focus area, chapter and agent wait to the
   timeline.
5. `render.ts` renders `video/` with Remotion. Agent waits are fast-forwarded, a chapter card holds the
   frame at each chapter start, and the camera zooms to each focus area.

## Files

| File          | Purpose                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `config.ts`   | Everything you edit: prompts, comments, anchors, chapter titles, pacing, video style |
| `scenario.ts` | The order of the steps in each chapter                                               |
| `ui.ts`       | How to find and use each VS Code and Paireto surface                                 |
| `director.ts` | Mouse, keyboard and timeline logging                                                 |
| `edit.ts`     | Time remapping, camera and cursor maths shared by the renderer                       |
| `sandbox/`    | The sample project the agent changes                                                 |
| `video/`      | The Remotion composition                                                             |

## Writing anchors

The agent writes different text on each record run, so steps find their targets by pattern, not by
line number. For example `planning.comment.anchor` is the plan line the comment goes on. Keep each
pattern to a name the spec in `sandbox/main/docs/specs/discount-codes.md` asks for, so it exists in
every run. Steps that only show something off (the type hover, the peek, the review checkboxes) are
skipped with a warning if their target is missing. Steps that the agent sees fail the run.

## Licences

The renderer uses [Remotion](https://www.remotion.dev/license). Remotion is free for individuals and
for companies of up to three people. Larger companies need a company licence.
