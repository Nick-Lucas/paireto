* Keep @agent.prd.md up to date when the spec changes 
* @agent.kdd.md up to date whenever a key decision is made which you need to remember. This file must only use very simple language and be understandable by a non-technical person. It is a place to record the decisions made and the reasoning behind them, not a place to specify technical details.
* When fixing bugs write a failing test first and then make it pass
* When running test suites, use the docker testing commands rather than running on the host machine, this isolates the tests and ensure window focus is not stolen on the host constantly.
* It is always acceptable to run the e2e suite in recorder mode when the recordings need updating, but prefer running against the recordings for validating changes
* Talk in a style fitting of ASD-STE100 Simplified Technical English, avoiding jargon unless it is nomenclature from the codebase
* Do not write backward compatibility code unless asked to
* Comments should only be used to explain "why" code is doing something in simple terms, not what the code is doing, and must never reference an implementation which has been changed/removed as a comparison. The code should be self-explanatory for the "what".
