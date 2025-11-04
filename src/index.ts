#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, promptForConfig } from './config.js';
import { R2SQLREPL } from './repl.js';
import { R2SQLTUI } from './tui.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('r2sql')
  .description('Interactive shell for querying R2 Data Catalog with R2 SQL')
  .version('1.0.0')
  .option('--account-id <id>', 'Cloudflare Account ID')
  .option('--bucket <name>', 'R2 Bucket Name')
  .option('--token <token>', 'Cloudflare API Token')
  .option('-e, --execute <query>', 'Execute a SQL query on startup')
  .option('--history [enabled]', 'Save query history to r2sql-history.txt', false)
  .option('--debug', 'Enable debug logging to r2sql-debug.log', false)
  .option('--tui', 'Use TUI mode (default)', true)
  .option('--simple', 'Use simple REPL mode instead of TUI')
  .addHelpText('after', `
Examples:
  $ r2sql
    Start with interactive prompts for credentials

  $ r2sql --account-id abc123 --bucket my-bucket --token xyz789
    Start with credentials from command line

  $ r2sql -e "SELECT * FROM default.logs LIMIT 10"
    Execute a query on startup (uses .env for credentials)

  $ r2sql --account-id abc123 --bucket my-bucket --token xyz789 -e "SELECT * FROM default.logs"
    Combine credentials and query execution

  $ r2sql --history
    Enable query history logging to r2sql-history.txt

  $ r2sql --debug
    Enable debug logging to r2sql-debug.log

  $ r2sql --simple
    Use simple REPL mode instead of TUI

Configuration:
  You can also set credentials in a .env file:
    CLOUDFLARE_ACCOUNT_ID=your_account_id
    R2_BUCKET_NAME=your_bucket_name
    CLOUDFLARE_API_TOKEN=your_api_token

  Priority: Command-line args > Environment variables > Interactive prompts

For more information, visit: https://github.com/marcinthecloud/r2sql-shell
`)
  .action(async (options) => {
    try {
      let config;

      // Try to load config from args/env
      try {
        config = loadConfig({
          accountId: options.accountId,
          bucketName: options.bucket,
          apiToken: options.token,
          debugEnabled: options.debug,
        });
      } catch (error) {
        // If config is missing and no args provided, prompt interactively
        if (!options.accountId && !options.bucket && !options.token) {
          console.log(chalk.yellow('No configuration found. Let\'s get started!\n'));
          config = await promptForConfig(options.debug);
          // Give the terminal a moment to fully reset after inquirer
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          throw error;
        }
      }

      // Convert --history to boolean - accept any value except false/'false'
      const historyEnabled = options.history !== false && options.history !== 'false' && options.history !== undefined;

      if (options.simple) {
        const repl = new R2SQLREPL(config);
        await repl.start();
      } else {
        const tui = new R2SQLTUI(config, {
          executeOnStart: options.execute,
          historyEnabled,
        });
        await tui.start();
      }
    } catch (error) {
      console.error(chalk.red.bold('✗ Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
