/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * Both dispatch here before the full CLI module graph (seconds of evaluation) loads; everything
 * else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { runSpawnHelper, SPAWN_HELPER_COMMAND } from "./spawnHelper/SpawnHelperMain.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === SPAWN_HELPER_COMMAND) {
    // Loads nothing else: its memory size sets the cost of every spawn it makes.
    runSpawnHelper();
  } else {
    await runCliOrFastPath(command);
  }
}

async function runCliOrFastPath(command: string | undefined) {
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    // Before anything reads stdin: the desktop app's Windows launcher starts
    // the CLI without one. Never for the fast paths, whose stdin is a pipe.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
