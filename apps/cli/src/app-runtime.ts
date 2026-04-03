#!/usr/bin/env node

import {
  addCodexAccount,
  completeLoggedInAccount,
  getAppState,
  refreshUsage,
  saveCurrentAccountAuto,
} from "./lib/app.js";
import {
  importAccountFromAuthFile,
  removeStoredAccount,
  switchToAccount,
} from "./lib/accounts.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    throw new Error("Missing command.");
  }

  switch (command) {
    case "app-state": {
      printJson(await getAppState());
      return;
    }

    case "save-current-auto": {
      const includeConfig = args.includes("--with-config");
      const result = await saveCurrentAccountAuto({ includeConfig });
      printJson({
        ok: true,
        created: result.created,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
      return;
    }

    case "complete-login": {
      const result = await completeLoggedInAccount();
      printJson({
        ok: true,
        created: result.created,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
      return;
    }

    case "add-account": {
      const launchMode = args.includes("--inline")
        ? "inline"
        : args.includes("--terminal")
          ? "terminal"
          : "auto";

      printJson(await addCodexAccount({ launchMode }));
      return;
    }

    case "refresh-usage": {
      printJson(await refreshUsage());
      return;
    }

    case "import-auth":
    case "import": {
      const authPath = args[0];
      if (!authPath) {
        throw new Error("Missing auth.json path for import.");
      }

      const nameIndex = args.indexOf("--name");
      const name =
        nameIndex >= 0 && nameIndex + 1 < args.length ? args[nameIndex + 1] : undefined;
      const result = await importAccountFromAuthFile(authPath, { name });
      printJson({
        ok: true,
        created: result.created,
        updated: result.updated,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
      return;
    }

    case "use": {
      const name = args[0];
      if (!name) {
        throw new Error("Missing account name for use.");
      }

      const restoreConfig = args.includes("--restore-config");
      const account = await switchToAccount(name, { restoreConfig });
      printJson({
        ok: true,
        active: account.meta.name,
        restoreConfig,
      });
      return;
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        throw new Error("Missing account name for remove.");
      }

      await removeStoredAccount(name);
      printJson({ ok: true, removed: name });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
