# @openparachute/cli

**One command for the @openparachute family.** `parachute` is a thin dispatcher that discovers every `parachute-*` binary on your PATH and exposes each as a subcommand — so `parachute vault query`, `parachute agent runs list`, and any future `parachute-whatever` you install all share a single entry point.

## How it works

When you run `parachute`, it scans every directory on your `PATH` for executables named `parachute-<something>` and treats each one as a subcommand.

- `parachute <sub> [args...]` execs `parachute-<sub>` with the remaining args, inheriting stdio and forwarding the exit code.
- `parachute` or `parachute --help` lists the subcommands it found, with each package's `description` pulled from its `package.json` when discoverable.
- `parachute --version` prints this package's own version.

Add a subcommand by dropping any executable `parachute-*` on PATH — no registration, no config file.

## Install

```sh
bun add -g @openparachute/cli
bun add -g @openparachute/agent   # provides parachute-agent
bun add -g @openparachute/vault   # provides parachute-vault (when it ships)
```

## Usage

```sh
parachute                              # list discovered subcommands
parachute agent runs list --limit 10   # → parachute-agent runs list --limit 10
parachute agent --help                 # → parachute-agent --help
parachute vault query "..."            # → parachute-vault query "..."
```

## Extensibility

Any `parachute-*` executable is a subcommand. Ship your own:

```sh
# ~/bin/parachute-weather (chmod +x)
#!/usr/bin/env bash
curl -s "wttr.in/${1:-}?format=3"
```

Then `parachute weather Portland` works. If you publish it as an npm package with a `description`, that description shows up in `parachute --help`.

## License

AGPL-3.0, matching the rest of the @openparachute family.
