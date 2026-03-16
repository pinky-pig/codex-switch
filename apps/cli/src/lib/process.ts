import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function summarizeCommand(rawCommand: string): string {
  const tokens = rawCommand.split(/\s+/).filter(Boolean);
  const summary: string[] = [];

  for (const token of tokens) {
    if (token.includes("=") && !token.startsWith("--")) {
      continue;
    }

    if (summary.length === 0 && token.includes("/")) {
      summary.push(path.basename(token));
      continue;
    }

    summary.push(token);

    if (summary.length >= 4) {
      break;
    }
  }

  return summary.join(" ");
}

export async function listCodexProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-fal", "codex"]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.includes("codex-switch"))
      .map((line) => {
        const matched = line.match(/^(\d+)\s+(.+)$/);
        if (!matched) {
          return line;
        }

        const [, pid, command] = matched;
        return `${pid} ${summarizeCommand(command)}`;
      });
  } catch {
    return [];
  }
}
