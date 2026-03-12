---
description: Git repository operations — status, log, diff, commit, push, pull, branch management
always: false
requires:
  binaries: [git]
---

# Git Skill

Use `exec` to run git commands. Always pass `-C <repoPath>` so commands work regardless of the current working directory.

## Configuration

The repo path comes from this skill's `config.json`. If the user asks about a different repo, use its path directly.

Default repo path: `{{config.repoPath}}`

## Common operations

```bash
# Status
git -C <path> status

# Recent commits
git -C <path> log --oneline -20

# Staged and unstaged changes
git -C <path> diff
git -C <path> diff --staged

# Stage all changes
git -C <path> add -A

# Stage specific files
git -C <path> add <file1> <file2>

# Commit
git -C <path> commit -m "message"

# Stage and commit all tracked changes in one step
git -C <path> commit -am "message"

# Push
git -C <path> push

# Pull (rebase to avoid merge commits)
git -C <path> pull --rebase

# Current branch
git -C <path> branch --show-current

# List branches
git -C <path> branch -a

# Switch branch
git -C <path> checkout <branch>

# Create and switch to new branch
git -C <path> checkout -b <branch>

# Stash
git -C <path> stash
git -C <path> stash pop
```

## Guidelines

- Always run `git status` first to understand the current state before making changes.
- When committing, write a concise, meaningful commit message that describes *why* the change was made, not just what files changed.
- Never force-push (`--force`) without explicit user confirmation.
- Never reset or clean working changes without explicit user confirmation.
- If the user asks to "commit everything", stage with `git add -A` then commit.
- If the user asks to "push", check the current branch first and confirm the remote target if it is not `main` or `master`.
