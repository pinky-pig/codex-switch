#!/usr/bin/env node

import React from "react";
import { Command } from "commander";
import { render } from "ink";

import {
  addCodexAccount,
  completeLoggedInAccount,
  getAppState,
  refreshUsage,
  saveCurrentAccountAuto,
} from "./lib/app.js";
import {
  getCurrentAccount,
  importAccountFromAuthFile,
  getRuntimeStatus,
  listStoredAccounts,
  removeStoredAccount,
  saveCurrentAccount,
  switchToAccount,
} from "./lib/accounts.js";
import { SwitchApp } from "./ui.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(): Promise<void> {
  const program = new Command();

  program
    .name("codex-switch")
    .description("Manage ChatGPT-auth Codex account snapshots.")
    .version("0.1.0");

  program
    .command("tui")
    .description("Launch the interactive TUI.")
    .action(() => {
      render(<SwitchApp />);
    });

  program
    .command("save")
    .description("Save the current Codex auth into a named snapshot.")
    .argument("<name>", "snapshot name")
    .option("--with-config", "also backup ~/.codex/config.toml")
    .action(async (name: string, options: { withConfig?: boolean }) => {
      const account = await saveCurrentAccount(name, {
        includeConfig: Boolean(options.withConfig),
      });
      printJson(account.meta);
    });

  program
    .command("import-auth")
    .alias("import")
    .description("Import an auth.json file as a saved account snapshot.")
    .argument("<auth-path>", "path to auth.json")
    .option("--name <name>", "saved account name")
    .action(async (authPath: string, options: { name?: string }) => {
      const result = await importAccountFromAuthFile(authPath, {
        name: options.name,
      });
      printJson({
        ok: true,
        created: result.created,
        updated: result.updated,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
    });

  program
    .command("use")
    .description("Switch to a saved account snapshot.")
    .argument("<name>", "snapshot name")
    .option("--restore-config", "restore saved config.toml if present")
    .action(async (name: string, options: { restoreConfig?: boolean }) => {
      const account = await switchToAccount(name, {
        restoreConfig: Boolean(options.restoreConfig),
      });
      printJson({
        ok: true,
        active: account.meta.name,
        restoreConfig: Boolean(options.restoreConfig),
      });
    });

  program
    .command("list")
    .description("List saved account snapshots.")
    .action(async () => {
      const accounts = await listStoredAccounts();
      printJson(
        accounts.map((account) => ({
          name: account.meta.name,
          savedAt: account.meta.savedAt,
          summary: account.meta.summary,
          includesConfig: account.meta.includesConfig,
        })),
      );
    });

  program
    .command("current")
    .description("Show the current live Codex account.")
    .action(async () => {
      const current = await getCurrentAccount();
      printJson(current ?? { ok: false, reason: "No auth.json found" });
    });

  program
    .command("doctor")
    .description("Inspect runtime paths and running Codex processes.")
    .action(async () => {
      const status = await getRuntimeStatus();
      printJson(status);
    });

  program
    .command("app-state")
    .description("Return a compact JSON payload for GUI clients.")
    .action(async () => {
      const state = await getAppState();
      printJson(state);
    });

  program
    .command("save-current-auto")
    .description("Save the current active account with an inferred unique name.")
    .option("--with-config", "also backup ~/.codex/config.toml")
    .action(async (options: { withConfig?: boolean }) => {
      const result = await saveCurrentAccountAuto({
        includeConfig: Boolean(options.withConfig),
      });
      printJson({
        ok: true,
        created: result.created,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
    });

  program
    .command("complete-login")
    .description("Finalize a fresh Codex login by saving the active account.")
    .action(async () => {
      const result = await completeLoggedInAccount();
      printJson({
        ok: true,
        created: result.created,
        name: result.account.meta.name,
        summary: result.account.meta.summary,
      });
    });

  program
    .command("add-account")
    .description("Add another Codex account through the official login flow.")
    .option("--inline", "run codex login in the current terminal")
    .option("--terminal", "open Terminal.app for the login flow")
    .action(async (options: { inline?: boolean; terminal?: boolean }) => {
      const result = await addCodexAccount({
        launchMode: options.inline
          ? "inline"
          : options.terminal
            ? "terminal"
            : "auto",
      });

      printJson(result);
    });

  program
    .command("refresh-usage")
    .description("Refresh remote quota usage for all saved accounts.")
    .action(async () => {
      const result = await refreshUsage();
      printJson(result);
    });

  program
    .command("remove")
    .description("Delete a saved account snapshot.")
    .argument("<name>", "snapshot name")
    .action(async (name: string) => {
      await removeStoredAccount(name);
      printJson({ ok: true, removed: name });
    });

  if (process.argv.length <= 2) {
    render(<SwitchApp />);
    return;
  }

  await program.parseAsync(process.argv);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
