Do not ever edit this, this is for humans only to edit!

# WIP 14

* support git conflicts just like the main git panel
* When the extension rejects an older plugin version, show a debounced VS Code notification with a one-click update action and instructions to restart the agent
* If possible: when doing a Go To Definition from within a diff, if the target file also has a diff we should open the diff instead by default
* Allow file feedback to be sent in a plan review. When submitting the review if there is code feedback ask if it should be included and do so like normal if yes
* support a paireto-review-consume skill which consumes the already added comments instead of starting a blocking review
* When staging a file with unsaved changes, the file is currently closed and prompts to save. If you choose to save you should also commit the unsaved changes
* Enter on a changes entry support renaming of the file
* Support "stackBase" as well as "mergeBase" which compares to the commit the branch was branched from instead of the merge base

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
* keep user feedback around so they can easily review the changes and follow-up, give the agent a tool to reply to each with their fix plan
* Claude WorktreeCreate etc could be used to manage a CoW system?
* Include an endpoint which lets the agent group changed files into structured reviews with descriptions of each
* Store user todos and feedback repo+branch-wise with an option to have it in the homedir or in the repo, permit the agent to respond to question feedback and to resolve comments

# Refactoring ideas:

* Use real MCP server instead of the dependency free one
* compile the claude hooks from TS so they're type-safe and can import shared code between both sides of the bridge
* Consider consolidating the bridge so the MCP server provides everything
