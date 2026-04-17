Lets completely revamp our "temporary" (cought) web UI, taking into account the fact that we need and want to reuse the same components in our electron app.

We are already slowly moving towards a mono-repo architecture in @monorepo (symlinked from a new github repo)

There are 2 main concepts for the canvas application in general:
- Operational mode: Context(bound) and Workspace(explorer)
    - In Context mode, if your apps are bound to a context, they follows all changes of the context - if a context url changes from /project/foo to /project/bar, they autoload relevant data for that path; all actions in the context are always visible/propagated real-time to all connected(bound) applications => changing the context url (traversing the tree or setting a url manually) causes an update of the views across all bound applications.
    - In Workspace mode, you can freely traverse all workspace trees (context or directory), create contexts or canvases, managing data in workspace mode still emits events for the application to interpret regardless of its mode
    
- Multi-step main menu with a tree view where applicable, Dynamic MCP-UI enabled canvas(es) as the data visualization layer and a Toolbox element that is context and workspace mode aware.

The layout should be a minimalist yin-yang style design with 3 main sections:
- A always-shown icon-only main menu panel on the left with a logo on top thats expandable to a resizeable submenu(the "where we are" or "what are we focusing on" section) - lets call the main manu M0, section 1 as M1, section 2 that can be layerd on top of M1 as M2
- Content section hosting tileable/stackable(tab layout) card like elements with the actual content called Canvases; default canvas always show all unfiltered content with a basic table layout we use currently, its the default "virtual" canvas element.
- A always-visible slim icon-only Toolbox on the right with the main action button on bottom thats also expandable in 2 levels to the right, T0 for the panel/bar view, T1 and T2 for expanded views

Lets start with the main menu (on the left): Menu should contain the following:
- Icon-only slim panel with the root elements as described below - M0, opening up to a larger submenu - M1
    - Contexts(M0)
        Submenu(M1)
        - Section header "Contexts" with a round "+" button to create a Context            
            - Context creation/management form at M2
        - Card-like list of contexts with a left border based on color of the workspace, header with the context id and subheader with the full context path - clicking on the context path should slide to M2 showing the current tree the context is bound to and a context url input box so that we can change the context url easily either using the tree or typing the url. On the right we should have a button for Settings which would slide into the M2 createContext view, this view should contain "destroy context" for existing context
        - Selecting a context will directly show the default canvas(or canvas the context is set to - but this part we'll implement alter)
    - Agents(M0)
    - Workspaces(M0)
        Submenu(M1)
        - Section header "Workspaces" with a round "+" button to create a Workspace
        - Card-like list of workspaces, same schemantics as above with the exception that we need more controlls in the M1 menu directly - namely Start, Stop, Settings - which would enter the createWorkspace view and should contain "destroy workspace"
        - Selecting a workspace will show M2
            - Submenu (M2)
            - Header -Tabbed layout with Tab "Context" (to display the context tree), Tab "Directory" to display the default directory tree, small settings button on the right
            - Content - Tree view for the selected tree with controlls we already have implemented
            - Clicking on any parts of the tree will load the default "virtual" canvas with the content
            - Special handling for documents with schema 'internal/layers/canvas' - canvases are "views" we store in the db and should display within the tree - we'll probably implement this part in one go with canvases
    - Agents(M0)
        Submenu(M1)
        - Section header "Agents" with a round "+" button to create a new Agent at M2
        - Card-like list of all agents, controls Start, Stop, Settings
            - Settings should contain the below(note, the agent runtime will run in docker or toolbx and is not yet implemented, lets focus on the UI here)
                - Agent ID
                    - Name
                    - Photo/Icon
                    - Description
                    - Role
                    - Identity
                    - Instructions
                    - System prompt (compiles {role}, {identity} with {instructions} and additinal harness, user can fine-tune this part, this is whats sent to the backend LLM provider)                    
                - Provider
                    - Host, API Key(s), Limits
                - Model
                    We should support model settings on each category like top_p, temperature, max tokens/context window, system prompt except for the main thinking mode
                    - Main agent model (the model user/integrations "talk to")
                    - Governance model
                    - Memory management model
                    - Subagent / Tool use model
                - Tools (MCP Servers)
                  - Always discovered on-demand using the memory module
                - Skills (management of skills inspired by https://skills.sh/)
                  - Always discovered on-demand using the memory module
                    - example-pdf-skill/
                    ├── SKILL.md (main instructions)
                    ├── FORMS.md (form-filling guide)
                    ├── REFERENCE.md (detailed API reference)
                    └── scripts/
                        └── fill_form.py (utility script)
                - Memory (we run a loop-based memory engine, settings omitted for now)
                - Integrations
                    - Your IMAP, chat, SQL, REST API accounts go here(including ACL tokens for your canvas workspaces/contexts/canbases)
        - Selecting a agent will show a chat interface at M2 (the main entrypoint for agents is via toolbox so this is really ad-hoc)        
    - Roles
        Descoped for now
    --
    Admin menu section
    - Manage Users
    - Workspaces
    - Agents
    - Roles (user and server roles)
    - Server
        Submenu
        - 
    --
    User menu section
    - Settings
    - Logout
