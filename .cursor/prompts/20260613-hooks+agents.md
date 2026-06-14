Lets talk Agents and Workspace hooks

Our pi-based agent runtime prototype currently runs - IIRC - in-process, simillar to workspaces. The post-MVP plan is to create a common canvas-role management module that would run agents, roles(services) and workspaces either via pm2 or as docker containers - with a common canvas-edge layer, canvas-edge would be able to autoregister to a server from behind NAT(STUN). Till then, we need to implement a sane way how agents can become deeply integrated into the canvas application.

Lets start by a few use-cases and then discuss the implementation details:

Usecase #1: Plain ol' hooks
User syncs/indexes a link from his browser(browser tab - data/abstraction/tab schema document), a hook triggered by the document.inserted event checks the data.url and finds out that the link is a youtube video, spins up a bash script from WORKSPACE_ROOT/git/scripts and downloads that video into WORKSPACE_ROOT/home/Videos/some-name.mp4 using ytdl creating a temporary .metadata.json file containing all paths the video should be linked to once registered. 
Download triggers another document.inserted event - all newly added files are automatically added into the virtual directory-type tree under .incoming/fs/home/<real-path-on-disk> - hook detects that a metadata file exists(we do not auto-index hidden files - files starting with .) hence links that file to all virtual paths defined in metadata, then removes metadata
Simillar use-case for picture URLs, arxiv papers etc, I may want to trigger an agent to summarize each arxhiv paper I index and store that summary as a note in the same virtual path the link was indexed in or a subpath /Notes

Another hook - Emails from foo@bar.baz that contain subject "DC Migration" are to be linked under /projects/dc-migration
Emais from bar@baf.baz to /path/to-read and /path/something/else and tagged custom/tag/urgent

Usecase #2: Hooks + Agents
A bunch of browser tabs get synced into the /to-sort virtual context or directory tree, triggering a documents.inserted hook. Hook checks the path and triggers the "lucy" agent to categorize those tabs, fetches the current workspace tree paths array, optionaly uses a web tool to analyze those pages if url title or url does not provide enough context and link those tabs to respective context paths, removing them from to-sort once done.
document.inserted into /projects/dc-migration triggers an agent to read that email and evaluate whether to notify me over slack or teams or by sending an in-app notification ("please let me know if any emails about foo bar and baz arrive, also notify me when I get any comm regarding that intune ts case")

Usecase #3: Agentic workloads
I bind my "Lucy" agents to my "mbag" context. Switching my context url(focus) to /projects/dc-migration/fmo will update all my context-bound apps (browsers will load relevant tabs, obsidian will show relecant notes etc), since Lucy is also allowed to access my context, asking "Do we have any new emails?" or "can you tell me to what server ldap master was migrated to" - should trigger a targetted in-context search of all emails or a query across all documents pre-filted for the current context url for a standard RAG reply

THere are some nuances to the above, if Lucy also has access to the whole tree, agents can query directories above the current context url for example

Usecase #4: Canvas/UI integration(MCPUI/A2UI like)
"Lucy, show me all emails since Monday and all tasks for today on the tv canvas"
"show me all messages from canonical we received this year"

Implementation details:

We need to check and probably fix our current hooks architecture, hooks should be editable using our webui but they are by default hosted in the per-workspace git repo and should be stored and read from-disk(git push of new hooks should trigger a re-read, save from webui should trigger a git push)

We also need a MVP permission model. 
Contexts, canvases and workspaces can be shared, IIRC we implemented a user-email based ACL for registered users and a token based ACL for everyone else. 

Agent runtime will at some point be separate but we are deep in MVP land, KISSing is healthy esp when you need to shipp asap, the idea was to create a per-resource token with basic, later fine-grain ACLs (
- tree:ro
- insert tree "nodes"
- insert and remove/edit tree nodes
- documents:ro
- insert documents
- insert and remove documents from index
- delete/destroy documents 
- delete documents from backends
)

This is the conservative skeleton, a follow-up on that would be opening a chat in our webui toolbox should auto-inject / auto-allow the agent to access whatever path I'm at (lets say I'm in workspace mode and looking at a filtered content view in /foo/bar/baz, asking an agent in my toolbox what are these should allow agent to fetch the current list and optionally the source documents for eval. - agents will probably have to have a skill to work with canvas or use MCP tools with a ACL tokens (a skill could use our CLI, in both cases agents should not really be able to read their ACL tokens)
