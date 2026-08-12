Do not ever edit this, this is for humans only to edit!

# WIP NOW

* Make the extension sidebar aware of the plugin versions of agents based on the welcome screen logic. If none are installed then prompt the user to the welcome screen, and if any plugin version is wrong then also prompt the user to update them (link to the welcome screen)
* Allow file feedback to be sent in a plan review. When submitting the review if there is code feedback ask if it should be included and do so like normal if yes
* When staging a file with unsaved changes, the file is currently closed and prompts to save. If you choose to save you should also commit the unsaved changes
* pressing the Enter key on a changes entry should trigger renaming of the file just like in explorer
* Support "stackBase" as well as "mergeBase" which compares to the commit the branch was branched from instead of the merge base

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
* keep user feedback around so they can easily review the changes and follow-up, give the agent a tool to reply to each with their fix plan
* Claude WorktreeCreate etc could be used to manage a CoW system?
* Store user todos and feedback repo+branch-wise with an option to have it in the homedir or in the repo, permit the agent to respond to question feedback and to resolve comments
