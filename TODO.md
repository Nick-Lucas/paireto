Do not ever edit this, this is for humans only to edit!

# WIP 1

* When the user causes ExitPlan to complete by approving or otherwise in the agent itself, close plan mode in the editor. Detect any closed connection for any reason and reset the extension state.
* When closing a plan tab warn and ask what the user wants to do (Approve, Send Feedback)
* After approving/rejecting/sending feedback etc on a Plan, close the tab automatically
* Need to be able to Edit existing comments in both modes
* When our Plan mode is entered, hide the terminal bar automatically and re-show when submitting
* Remove "Reject Plan" since "Send Feedback" overlaps significantly
* Review should have "Send Feedback" and "Approve" as the outcomes, same as Plan mode
* The extension should have a 1-at-a-time queue for tasks, a Plan and a Review should not be able to be active at the same moment for instance. In order for another instance of either to start the previous state must be resolved/cleared

# WIP 2

* LSP / type awareness seems to be broken in editable Working Tree review files
* The active agents section should list what agents are awaiting which mode to return, indicating the queue. Clicking on them should switch the extension connection over to that agent
* Make the emulator also emulate a connected agent session properly
* The changes tree is colouring all files instead of just their M/U/D indicators etc, we should only colour the indicators

# WIP 3

* notification sound / indicator when an agent finishes
  * in extension sidebar agents section
  * in the Repo/Worktree switcher (summarise the states of agents in each location as well indicating if the repo/worktree even has an open editor)

# WIP 4

* when staging or unstaging a file which has its tab open, automatically update the tab to look at the new location
* Extract a better sessionId for presentation that the project/CWD name - it's the same for every agent right now
* For claude code when approving a plan there's a way to tell the agent what mode to enter next. Make sure it defaults to auto-mode
* When there is feedback queued remove or disable "approve" button, and before feedback is queued remove/disable the Send Feedback button instead
* support code-reviewing from UI before the agent is in review mode, allow the agent to request a review before finishing, and keep the skill so that a review can be started manually

# WIP 5

* notifications are being sent for subagents, for instance in plan mode. We don't currently care about the status of sub agents at all
* when prompted for a question I think the notification sound didn't fire, but need to check
* Make the user in comments match the VS Code signed in user name, PC login name, or just "Developer" as the fallback

# WIP 6

* Notification ticker on extension, ideally a blue count for changes and a yellow Bell for agent notifications
* Update readme with docs

# WIP 7

* Onboarding flow with setup for recommended keyboard shortcuts?
  * Onboarding screen on install (and command to open it in the future)
    * Setup buttons for each agent
    * "The Paireto way" with each keyboard shortcut's current binding, a button to set the recommended binding
      * Cmd+' to focus terminal
      * Cmd+J to toggle bottom bar
      * Cmd+Shift+= to toggle fullscreen terminal
      * Cmd+Shift+[ and ] to switch terminal tabs
      * Ctrl+Shift+` to quick-launch a TUI agent (also include setup for each agent in this menu)
      * Plan, Feedback and Approve
      * Review on stop, Feedback and Approve

# WIP 8

* When starting a review in the editor and then calling the agent skill to adopt the review, a new review is queued instead and only after submitting the first and "approving" the second does the agent get its comments
* detection of changed files is not working properly or gating the review
* Whenever I send a message to the agent with changes already made, but none made by the agent, the review workflow starts.

# WIP 9

* Trim down settings, most of them seem nonsensical and we're missing important ones like the ability to disable automatic Review mode
* A shortcut to open Paireto tab (Cmd+Shift+C)

# WIP 10

* Make the Staged, Unstaged, Committed, sections much clearer with some icons/colours for easy scannability (probably just copy how the native git panel does it with a blue notification circle and files count on the far right of each)
* When a Plan or Review is automatically started, pop up a VS Code notification explaining this, with the option to "Approve Immediately" or (for plan only) "View Plan" (which focuses the plan tab and changes list in sidebar) or (for Review only) "Start Reviewing" (which just opens the changes list/sidebar) - disabling sets a setting which makes the review skill the way to trigger a review from the agent
* Name Plan virtual files more clearly than just the title: `PLAN: $PARSED_FIRST_LINE - $DATETIME`
* When a Plan or Review starts the extension should be focused in the sidebar

# WIP 11

* I still get notifications at weird times, they should only fire when the parent agent has finished and has no child agents running, needs permission, or some other input for the user. Notably happens when I see "Waiting for 1 background agent to finish" and presumably the parent agent has indeed stopped with some listener to start again?
* ensure that the project switcher does not list the same directory twice, and displays the branch name rather than the worktree name
* The changes list also randomly goes blank sometimes, are we using a source control API incorrectly? Here are logs:
```
refresh(git) #298: staged=0 unstaged=8 committed=0
refresh(manual) #299: staged=0 unstaged=0 committed=0
```
I think it could be that an agent running in a worktree's events are being processed here? could it be the cwd/branchname mismatch from the switcher is also affecting the connection to worktrees? 
* allow an agent to be disabled/ignored on click (use a visibility toggle icon)
* the plugin's WorktreeCreate hook breaks Claude Code's worktree creation entirely: WorktreeCreate is a delegation hook (the hook must create the worktree and echo its path; registering it replaces the default git behaviour and there is no observer mode), so our passthrough on-event.js makes every worktree operation fail with "hook succeeded but returned no worktree path". Unregister WorktreeCreate/WorktreeRemove and fetch the switcher's worktree list fresh instead of caching on those events.

# WIP 12

* Approving a plan is no longer moving claudecode on to implementing it
* I saw a blocking review start for this:
```
refresh(git) #58: no change
refresh(save) #59: staged=0 unstaged=1 committed=11
refresh(git) #60: no change
refresh(manual) #61: staged=1 unstaged=0 committed=11
refresh(git) #62: no change
subagent SubagentStart for agent 84a1ce04: 1 running
stop ignored for agent 84a1ce04: 1 background agents still running
refresh(manual) #63: no change
refresh(manual) #64: no change
```
also
```
refresh(git) #351: no change
subagent SubagentStart for agent d8566da2: 1 running
stop ignored for agent d8566da2: 1 background agents still running
subagent SubagentStop for agent d8566da2: 0 running
subagent SubagentStop for agent d8566da2: 0 running
notification for agent d8566da2: finished its turn (Stop)
refresh(git) #352: no change

-- and claude code, it happend somewhere in here:

I'll wait for the exploration to complete before deciding on the refactor.
  Ran 1 shell command
I'll pause and resume when the exploration agent reports back.
  Ran 1 shell command
Waiting for the exploration agent to finish mapping the existing session-boot machinery.
✻ Waiting for 1 background agent to finish
```
* please add timestamps to all logs, also add more logs for interactions like: plan/code review started by $REASON, user approved/sent feedback
* When clicking the "Open File" button on a diff which is already open, we should still open the underlying file, the diff is not the same thing.
* when staging or unstaging a file, don't refocus it in the new location or auto expand any ancestor if collapsed, don't change scroll position of the panel at all


# WIP 13

* refresh diffs when opening the diff for a file, rather than possibly showing an outdated version at first
* Add a "Compare To" control in virtual diff file tabs, when starting to edit an up-stream (committed / staged) file the new diff should remain compared to the original comparison point, and this button should let you change it freely for any virtual file

# WIP 14

* support git conflicts just like the main git panel
* tie the version of the plugin into both the extension and the plugin itself, send the plugin version with all events, check it, if it's older than the extension wants then prompt the user to update their plugin (VS Code notification, debounced, 1 click update then instruction to reboot the agent)
* If possible: when doing a Go To Definition from within a diff, if the target file also has a diff we should open the diff instead by default
* Allow file feedback to be sent in a plan review. When submitting the review if there is code feedback ask if it should be included and do so like normal if yes
* support multi-repo vs code workspaces

# Feature Ideas:

* Replace the Plan view with a proper WYSIWYG Markdown experience similar to Plannotator
* Show me / Explain to me skill, prints a whole lesson on how something works with a UI to navigate you though
* a TODOs and task tracker which you can track and dispatch tasks or grouped of tasks with 
  * with GitHub PR import
* when addressing feedback, the agent can send back answers in the same thread, and then the user can continue those threads
* when receiving a new plan, if there was a previous plan from the same agent, put both states into a diff view
* support the plan and review gates automatically forwarding to another agent to propose some comments
* revisit the currently in-progress plan at any point in the future
* plugins for Codex, Opencode, Pi
* Support feedback on UIs in in-editor browser
* Look at the agent providing review feedback to the user during coding, reacting to user interactions, reacting to compile and lint errors with quick fixes, etc.
* keep user feedback around so they can easily review the changes and follow-up, give the agent a tool to reply to each with their fix plan
* Claude WorktreeCreate etc could be used to manage a CoW system?

# Refactoring ideas:

* Use real MCP server instead of the dependency free one
* compile the claude hooks from TS so they're type-safe and can import shared code between both sides of the bridge
* Consider consolidating the bridge so the MCP server provides everything
