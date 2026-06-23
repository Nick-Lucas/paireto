Quick fixes:

* When the user causes ExitPlan to complete by approving or otherwise in the agent itself, close plan mode in the editor. Detect any closed connection for any reason and reset the extension state.
* When closing a plan tab warn and ask what the user wants to do (Approve, Send Feedback)
* After approving/rejecting/sending feedback etc on a Plan, close the tab automatically
* Need to be able to Edit existing comments in both modes
* When our Plan mode is entered, hide the terminal bar automatically and re-show when submitting
* Remove "Reject Plan" since "Send Feedback" overlaps significantly
* Review should have "Send Feedback" and "Approve" as the outcomes, same as Plan mode
* The extension should have a 1-at-a-time queue for tasks, a Plan and a Review should not be able to be active at the same moment for instance. In order for another instance of either to start the previous state must be resolved/cleared

Next fixes:

* LSP / type awareness seems to be broken in editable Working Tree review files
* The active agents section should list what agents are awaiting which mode to return, indicating the queue. Clicking on them should switch the extension connection over to that agent
* Make the emulator also emulate a connected agent session properly

Feature Ideas:

* Show me / Explain to me skill, prints a whole lesson on how something works with a UI to navigate you though
