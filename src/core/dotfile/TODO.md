https://chatgpt.com/c/6886b6b2-a264-832f-8906-2bf6d7741bec


Please implement the following:

We need to change the way we create git repositories and ensure a set of scripts are added to the repo on creation. This means that we might need to create a full repo in dotfiles, add our template files, then add dotfiles.git bare repo as a remote and commit-push our changes (or maybe have a prepared template repo that we could just clone?)

Every dotfile repo should contain the following files:
- A universal .gitignore file containing the most common files we do not want to store in this use-case like *.log, sockets/sock, temporary or cache files etc (lets start conservatively here)
- a special .dot folder with .dot/install-hooks.sh script that will install git hooks locally for the user after the canvas-cli application clones the dotfile repo, hooks should be simple and hosted in .dot/hooks/:

After git pull
- Find all *.encrypted files → ask for password once → store temporarily (in-memory, or OS keychain if available).
- Decrypt and remove .encrypted suffix.
- If decryption fails for any file, abort early to avoid leaving partially decrypted state.

Before git push
- Read .dot/encrypted.index (simple newline list of relative paths).
- For each file:
  - Encrypt → rename to filename.ext.encrypted.
  - Remove unencrypted version from working tree (we are already keeping backups of dotfiles locally)
  Important: Encrypt to a temp path first → atomically replace file after success → prevents corrupt partial encryption.
  
If user Ctrl-C’s mid-process during push, you might leave decrypted files lying around → trap signals and restore .encrypted state on exit.

We'll make it executable via "$ dot install-hooks" (so as to avoid manual script execution for 90% of users).
You should make install-hooks.sh idempotent:
- Skip install if hooks are already present.
- Overwrite only if --force is passed.

When a dotfile is created
$ dot add ~/.bashrc user@remote:workspace/shell/bashrc --encrypt
we'd add shell/bashrc into the .dot/encrypted.index
Treat paths as relative to repo root.
.gitignore these files’ decrypted versions automatically.
Auto-update the index with dot encrypt <file> or dot decrypt <file> so it stays consistent.
We should make this as transparent to the user as possible


Potential pitfalls
- Git merge conflicts on encrypted files are useless — you’ll need to detect this and warn the user before decrypting.
- Binary vs text encryption — lets go with AES-GCM for binary
- If we run the hooks inside the user’s git process, any prompt (for password) will block until they answer — so make sure they know to run interactively

