/**
 * Turns off Electron's asar shim for this process.
 *
 * The agent host is forked as an Electron utilityProcess, so it inherits
 * Electron's patched `fs`: any path ending in ".asar" is treated as an
 * archive to be opened rather than a file to be stat'ed. This process reads
 * USER workspaces, where a file called foo.asar is just a file — and a
 * VS Code fork ships one as a test fixture
 * (extensions/css-language-features/.../data/foo.asar). lstat'ing it threw
 * "Invalid package" from inside chokidar's directory walk, which chokidar
 * re-emitted as an 'error' event, which is a process-level throw in Node.
 * The whole agent died seconds after opening that workspace: no file tree,
 * no indexing, no chat, and nothing on screen saying why.
 *
 * Nothing in the agent reads Electron archives, so the shim is pure
 * downside. Call this before anything touches the filesystem.
 */
export function disableAsar(): void {
  (process as NodeJS.Process & { noAsar?: boolean }).noAsar = true;
}
