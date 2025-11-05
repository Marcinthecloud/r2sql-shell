#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, promptForConfig } from './config.js';
import { R2SQLREPL } from './repl.js';
import { R2SQLTUI } from './tui.js';
import { AuthService } from './auth-service.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('r2sql-shell')
  .description('Interactive shell for querying R2 Data Catalog with R2 SQL')
  .version('1.1.0')
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
  $ r2sql-shell login
    Interactive setup and automatically start the shell (recommended)

  $ r2sql-shell login --no-start
    Set up authentication without starting the shell

  $ r2sql-shell status
    Check authentication status

  $ r2sql-shell
    Start the shell (will use stored credentials)

  $ r2sql-shell --account-id abc123 --bucket my-bucket
    Start with account/bucket from command line (uses stored token)

  $ r2sql-shell --account-id abc123 --bucket my-bucket --token xyz789
    Start with all credentials from command line

  $ r2sql-shell -e "SELECT * FROM default.logs LIMIT 10"
    Execute a query on startup

  $ r2sql-shell --history
    Enable query history logging to r2sql-history.txt

  $ r2sql-shell --debug
    Enable debug logging to r2sql-debug.log

  $ r2sql-shell --simple
    Use simple REPL mode instead of TUI

  $ r2sql-shell logout
    Remove stored authentication credentials

Authentication Priority:
  1. Wrangler credentials (~/.wrangler/config/default.toml)
  2. r2sql-shell OAuth tokens (~/.r2sql-shell/config.json)
  3. CLOUDFLARE_API_TOKEN environment variable
  4. .env file configuration
  5. Command-line arguments (--token)
  6. Interactive prompts

Configuration:
  You can also set credentials in a .env file:
    CLOUDFLARE_ACCOUNT_ID=your_account_id
    R2_BUCKET_NAME=your_bucket_name
    CLOUDFLARE_API_TOKEN=your_api_token

For more information, visit: https://github.com/marcinthecloud/r2sql-shell
`);

// Login command
program
  .command('login')
  .description('Set up authentication and start the shell')
  .option('--no-start', 'Don\'t automatically start the shell after login')
  .action(async (options) => {
    try {
      await AuthService.login();

      // Automatically start the shell unless --no-start is specified
      if (options.start !== false) {
        // Ensure terminal is fully reset after login flow
        if (process.stdin.isTTY) {
          try {
            process.stdin.setRawMode(false);
          } catch (e) {
            // Ignore if already not in raw mode
          }
        }
        process.stdin.removeAllListeners();
        process.stdin.pause();

        // Give the terminal a moment to fully reset after login
        await new Promise(resolve => setTimeout(resolve, 200));

        console.log(chalk.blue('\n🚀 Starting r2sql-shell...\n'));

        // Load config and start TUI
        const config = await loadConfig();
        const tui = new R2SQLTUI(config, {
          historyEnabled: false,
        });
        await tui.start();
        // TUI manages its own exit, don't call process.exit here
      } else {
        // Only exit if we're not starting the shell
        process.exit(0);
      }
    } catch (error) {
      console.error(chalk.red.bold('✗ Authentication failed:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Logout command
program
  .command('logout')
  .description('Remove stored credentials and configuration (token, account ID, bucket)')
  .action(async () => {
    try {
      await AuthService.logout();
      process.exit(0);
    } catch (error) {
      console.error(chalk.red.bold('✗ Logout failed:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Check authentication status')
  .action(async () => {
    try {
      const status = await AuthService.getAuthStatus();
      if (status.authenticated) {
        console.log(chalk.green.bold('✓ Authenticated'));
        console.log(chalk.dim(`  Token source: ${status.source}`));
        if (status.configPath) {
          console.log(chalk.dim(`  Token location: ${status.configPath}`));
        }

        if (status.accountId || status.bucketName) {
          console.log('');
          console.log(chalk.white.bold('Stored Configuration:'));
          if (status.accountId) {
            console.log(chalk.dim('  Account ID: ') + chalk.white(status.accountId));
          }
          if (status.bucketName) {
            console.log(chalk.dim('  Bucket: ') + chalk.white(status.bucketName));
          }
          console.log(chalk.dim('\n  You can run: ') + chalk.white('r2sql-shell'));
        } else {
          console.log('');
          console.log(chalk.yellow('⚠ No stored account/bucket configuration'));
          console.log(chalk.dim('  Run ') + chalk.white('r2sql-shell login') + chalk.dim(' to store your configuration'));
          console.log(chalk.dim('  Or specify: ') + chalk.white('r2sql-shell --account-id <id> --bucket <name>'));
        }
      } else {
        console.log(chalk.yellow.bold('⚠ Not authenticated'));
        console.log(chalk.dim('\n  To authenticate, you have several options:'));
        console.log(chalk.white('  1. Run: r2sql-shell login') + chalk.dim(' (recommended - sets up everything)'));
        console.log(chalk.white('  2. Set CLOUDFLARE_API_TOKEN') + chalk.dim(' environment variable'));
        console.log(chalk.white('  3. Create a .env file') + chalk.dim(' with CLOUDFLARE_API_TOKEN'));
        console.log(chalk.white('  4. Pass --token') + chalk.dim(' as a command-line argument\n'));
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red.bold('✗ Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Default action for starting the shell
program
  .action(async (options) => {
    try {
      let config;

      // Try to load config from args/env
      try {
        config = await loadConfig({
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
