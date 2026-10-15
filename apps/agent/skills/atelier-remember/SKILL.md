---
name: atelier-remember
description: Save a lasting fact about this project to the workspace memory in .atelier/memory, so every later session starts out knowing it. Use when the user says remember, note that, keep in mind, or corrects a fact about the environment, a name, or how they want work done. Also removes an entry when the request starts with forget.
---

# Atelier Remember

Everything after the command is what to remember, in the user's own words.
Turn it into one entry of this workspace's memory. If nothing was given,
ask what to remember and stop.

The memory is in `.atelier/memory/` under the directory this session was
started in. This skill's own files ship inside the Atelier app and are not
part of the project: never search or read the folder they live in.

This only writes memory. Do not change source code, do not trace or
investigate the fact, and do not run tools beyond listing, reading, and
writing files in `.atelier/memory/`. List, read, and write with your file
tools, not a shell command.

## Saving a fact

1. List `.atelier/memory/` and read the frontmatter of each entry.
2. Find the entry that covers the same subject (the same service, setting,
   name, or habit), even when worded differently.
   - Found, and the entry is about exactly this fact: rewrite that file
     with the new fact.
   - Found inside a broader entry that also says other things: edit only
     the lines the new fact changes, and keep every other line as it was.
     When the new fact contradicts a line, the new fact wins: correct or
     remove that line, nothing more. Never shrink an entry to the new
     fact alone.
   - Not found: create a new file.
3. Pick the type:
   - `correction`: the user is correcting something an agent got wrong.
   - `environment`: what runs, is configured, or exists in which
     environment (local, dev, prod): services, ports, env values.
   - `naming`: what a word means here: which repo, app, or module a name
     refers to.
   - `preference`: how the user wants work done.
   - `fact`: any other lasting project fact.
4. Write `.atelier/memory/<kebab-name>.md`. The name is a few lowercase
   words joined by hyphens, naming the subject (for example
   `no-redis-locally`). The file is:

       ---
       name: <kebab-name>
       description: <one line, without quotes at either end>
       type: <type>
       ---

       <the fact, stated plainly in a few lines>

   Keep the user's meaning exactly. Say which environment it applies to
   when that matters ("locally", "on dev"). Add why it holds only when the
   user gave a reason. Do not add anything the user did not say.

## Forgetting

When the request starts with `forget`, find the entry that covers what
follows and delete its file. If no entry matches, say so; if more than one
might, name them and ask which.

## What not to save

Memory is for lasting facts, not for this task. If the request is task
progress, a guess, or a description of how some code works (that belongs in
a flow report), say in one line why it was not saved instead of writing it.

## Reply

One line, nothing else:

    Remembered: <kebab-name> (<type>): <description>

or `Updated: ...`, or `Forgot: <kebab-name>`. Do not repeat the file's
contents or explain the memory system.
