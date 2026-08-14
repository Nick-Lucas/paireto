Do not ever edit this, this is for humans only to edit!

# WIP Feedback Enhancements

* Store feedback items per repo+branch persistently
* Add an MCP tool for the agent to respond to question feedback and to resolve comments
* Add an MCP tool for the agent to resolve comments
* Remove the "Problem" feedback type, question and comment are enough
* When the agent replies to a question or comment it should be marked clearly with activity 
* When the agent marks a comment resolved it should be marked clearly with this activity
* Only once a user has approved changes without additional feedback should the feedback be cleared, we should also have a clear all feedback button on the Feedback tree directory (must confirm)


# WIP 14

* support git conflicts just like the main git panel
* If possible: when doing a Go To Definition from within a diff, if the target file also has a diff we should open the diff instead by default

# Feature Ideas:

* Since Claude now allows `updatedInput` to be passed back on plan exit permission, can we use that to support direct manual editing of the plan?
* Replace the Plan view with a proper WYSIWYG Markdown experience similar to Plannotator
* Show me / Explain to me skill, prints a whole lesson on how something works with a UI to navigate you though
* a TODOs and task tracker which you can track and dispatch tasks or grouped of tasks with 
  * with GitHub PR import
* when addressing feedback, the agent can send back answers in the same thread, and then the user can continue those threads
* when receiving a new plan, if there was a previous plan from the same agent, put both states into a diff view
* support the plan and review gates automatically forwarding to another agent to propose some comments
* revisit the currently in-progress plan at any point in the future
* plugin for Pi
* Support feedback on UIs in in-editor browser
* Look at the agent providing review feedback to the user during coding, reacting to user interactions, reacting to compile and lint errors with quick fixes, etc.
* Claude WorktreeCreate etc could be used to manage a CoW system?
