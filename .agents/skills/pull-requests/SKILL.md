---
name: pull-requests
description: How a change to arcadekit is finished and proposed. Use when a change works and is about to be committed as done, when writing its changeset, or when opening or updating a pull request.
---

A pull request is ready when a reviewer can judge the change from it, without running it.

## Workflow

1. **One purpose each**, small enough to be checked and reverted alone. A cleanup found on the way is a PR of its own, unless it is small and in the module being changed.
2. **Give the change what it owes**, and nothing else in markdown:
   - a changeset, for a change to a published package: `.changeset/README.md` says how one is written, and what a bump means below 1.0;
   - the guide and the doc comments that the roadmap, issue [#173](https://github.com/lucasthevenet/arcadekit/issues/173), asks of a finished item, and `Closes #<n>` for the issue of each item or problem it finishes;
   - an issue for what the change leaves to do later, named in the description and never a file of the repository: one labelled `silent-failure`, a sub-issue of the roadmap, for what goes wrong with no error, and a line under its area of the roadmap's "Not built yet" for what is not built;
   - the site's pages, when what they show changed, with the `website-docs` skill, and the doc comment of each export that was added or changed, with the `jsdocs` skill.
3. **Run the checks** that the table in `AGENTS.md` lists for the change, and fix what they find in the change, never in the check.
4. **Show the evidence** in the description:
   - the checks that were run and what they said, and which could not be run;
   - the benchmark before and after, for a hot path;
   - a screenshot of a page or of what is drawn, when either changed;
   - for a change to a flow (a session, the stages of a frame, states, a game that ticks when needed), a short diagram of it when that is clearer than prose;
   - the engine a design was borrowed from, with a link to the part that was used.
5. **Do not make it slower.** A slowdown on purpose says so in a commit's message, `Bench-slower: <variants>`, with the reason above it.
6. **Say what breaks**, in the changeset, the commit and the PR: what a game wrote before, and what it writes now. A change that only adds says that nothing breaks.
7. **Say what was left**: a workaround that was found and not fixed, a check that seems wrong, a rule this change could not turn into a check.

The task is complete when each of these holds, the description matches the final diff, and nothing in it defends a decision the code or a check could have made plain.
