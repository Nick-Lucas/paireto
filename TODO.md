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
* Trim down settings, most of them seem nonsensical and we're missing important ones like the ability to disable automatic Review mode
* A shortcut to open Paireto tab (Cmd+Shift+C)
* Whenever I send a message to the agent with changes already made, but none made by the agent, the review workflow starts.
* Make the Staged, Unstaged, Committed, sections much clearer with some icons/colours for easy scannability (probably just copy how the native git panel does it with a blue notification circle and files count on the far right of each)
* When a Plan or Review is automatically started, pop up a VS Code notification explaining this, with the option to "Approve Immediately" or (for plan only) "View Plan" (which focuses the plan tab and changes list in sidebar) or (for Review only) "Start Reviewing" (which just opens the changes list/sidebar) - disabling sets a setting which makes the review skill the way to trigger a review from the agent

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
