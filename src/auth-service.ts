import fs from 'fs';
import path from 'path';
import os from 'os';
import open from 'open';
import chalk from 'chalk';

export interface AuthToken {
  accessToken: string;
  source: 'r2sql-shell' | 'env' | 'manual';
  configPath?: string; // Path where the token was found
}

export interface StoredCredentials {
  access_token: string;
  account_id?: string;
  bucket_name?: string;
}

/**
 * Authentication service that implements the priority chain:
 * 1. Check ~/.r2sql-shell/config.json (our stored tokens)
 * 2. Check CLOUDFLARE_API_TOKEN env var
 * 3. Check .env file
 * 4. Return null if nothing found
 */
export class AuthService {
  private static CONFIG_DIR = path.join(os.homedir(), '.r2sql-shell');
  private static CONFIG_FILE = path.join(AuthService.CONFIG_DIR, 'config.json');


  /**
   * Get authentication token following the priority chain
   */
  static async getAuthToken(): Promise<AuthToken | null> {
    // 1. Try our stored tokens
    const r2sqlToken = await this.getR2SQLToken();
    if (r2sqlToken) {
      return r2sqlToken;
    }

    // 2. Try CLOUDFLARE_API_TOKEN env var
    const envToken = process.env.CLOUDFLARE_API_TOKEN;
    if (envToken) {
      return {
        accessToken: envToken,
        source: 'env',
      };
    }

    // 3. .env file is already loaded by dotenv in config.ts
    // So if we reach here and nothing is found, return null
    return null;
  }

  /**
   * Read our own stored API token
   */
  private static async getR2SQLToken(): Promise<AuthToken | null> {
    try {
      if (!fs.existsSync(this.CONFIG_FILE)) {
        return null;
      }

      const content = fs.readFileSync(this.CONFIG_FILE, 'utf-8');
      const credentials: StoredCredentials = JSON.parse(content);

      if (!credentials.access_token) {
        return null;
      }

      return {
        accessToken: credentials.access_token,
        source: 'r2sql-shell',
        configPath: this.CONFIG_FILE,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Interactive login - guide user to create API token and store it
   */
  static async login(): Promise<AuthToken> {
    console.log(chalk.blue.bold('🔐 Setting up r2sql-shell\n'));

    const inquirer = (await import('inquirer')).default;

    // Step 1: Ask for Account ID
    console.log(chalk.white.bold('Step 1: Account ID'));
    console.log(chalk.dim('You can find your Account ID in the Cloudflare dashboard URL'));
    console.log(chalk.dim('or on the right side of your dashboard homepage.\n'));

    const { accountId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'accountId',
        message: 'Enter your Cloudflare Account ID:',
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return 'Account ID is required';
          }
          if (input.trim().length < 10) {
            return 'This doesn\'t look like a valid Account ID';
          }
          return true;
        },
      },
    ]);

    const trimmedAccountId = accountId.trim();

    // Step 2: Ask if they have an R2 API token
    console.log(chalk.white.bold('\nStep 2: R2 API Token'));
    console.log(chalk.dim('You need an R2 API token with Admin Read & Write permissions.\n'));

    // Ask with immediate y/n response (no Enter required)
    const hasToken = await new Promise<boolean>((resolve) => {
      const readline = require('readline');

      // Give terminal a moment to reset after inquirer
      setTimeout(() => {
        // Set up readline to emit keypress events
        readline.emitKeypressEvents(process.stdin);

        if (process.stdin.isTTY && !process.stdin.isRaw) {
          process.stdin.setRawMode(true);
        }

        process.stdin.resume();

        process.stdout.write(chalk.white('Do you already have an R2 API token with Admin Read & Write permissions? ') + chalk.cyan('[y/n] '));

        const onKeypress = (str: string, key: any) => {
          if (!key) return;

          const char = str ? str.toLowerCase() : (key.name || '').toLowerCase();

          if (char === 'y') {
            cleanup();
            process.stdout.write(chalk.green('y') + '\n\n');
            resolve(true);
          } else if (char === 'n') {
            cleanup();
            process.stdout.write(chalk.yellow('n') + '\n\n');
            resolve(false);
          } else if (key.ctrl && key.name === 'c') {
            cleanup();
            process.stdout.write('\n');
            process.exit(0);
          }
          // Ignore other keys
        };

        const cleanup = () => {
          // Remove our keypress listener
          process.stdin.removeListener('keypress', onKeypress);

          // Remove ALL keypress listeners to fully clean up readline
          process.stdin.removeAllListeners('keypress');

          // Restore normal mode
          if (process.stdin.isTTY) {
            try {
              process.stdin.setRawMode(false);
            } catch (e) {
              // Ignore if already not in raw mode
            }
          }

          // Don't pause - let it stay active for subsequent inquirer prompts
        };

        process.stdin.on('keypress', onKeypress);
      }, 150);
    });

    let apiToken: string;

    if (hasToken) {
      // User has a token, let them paste it
      console.log(chalk.dim('\nGreat! Please paste your token below.\n'));

      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiToken',
          message: 'Paste your R2 API Token:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim().length === 0) {
              return 'API token is required';
            }
            if (input.trim().length < 20) {
              return 'This doesn\'t look like a valid Cloudflare API token';
            }
            return true;
          },
        },
      ]);

      apiToken = answers.apiToken.trim();
    } else {
      // User needs to create a token - open browser
      console.log(chalk.dim('\nNo problem! Let\'s create one.\n'));
      console.log(chalk.white('Opening Cloudflare R2 API Tokens page in your browser...\n'));

      const tokenUrl = 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens';

      try {
        await open(tokenUrl);
        console.log(chalk.green('✓ Browser opened successfully\n'));
      } catch (error) {
        console.log(chalk.yellow('⚠ Could not open browser automatically.'));
        console.log(chalk.dim(`Please visit: ${tokenUrl}\n`));
      }

      console.log(chalk.white.bold('Steps to create your R2 API token:'));
      console.log(chalk.dim('  1. Select your account if prompted'));
      console.log(chalk.dim('  2. Click "Create API token"'));
      console.log(chalk.dim('  3. For "Permissions", select:'));
      console.log(chalk.cyan('     • Admin Read & Write'));
      console.log(chalk.dim('  4. (Optional) Set token expiration and restrictions'));
      console.log(chalk.dim('  5. Click "Create API Token"'));
      console.log(chalk.dim('  6. Copy the token and paste it below\n'));

      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiToken',
          message: 'Paste your R2 API Token:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim().length === 0) {
              return 'API token is required';
            }
            if (input.trim().length < 20) {
              return 'This doesn\'t look like a valid Cloudflare API token';
            }
            return true;
          },
        },
      ]);

      apiToken = answers.apiToken.trim();
    }

    // Test the token by making a simple API call
    console.log(chalk.dim('\nValidating token...'));

    try {
      const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
        },
      });

      if (!response.ok) {
        throw new Error('Token validation failed');
      }

      const data = await response.json() as any;

      if (!data.success) {
        throw new Error('Invalid token');
      }

      console.log(chalk.green('✓ Token validated successfully!\n'));

    } catch (error) {
      console.log(chalk.yellow('⚠ Warning: Could not validate token, but proceeding anyway.'));
      console.log(chalk.dim('If you have issues, please verify your token permissions.\n'));
    }

    // Step 3: Ask for bucket name
    console.log(chalk.white.bold('Step 3: R2 Bucket'));
    console.log(chalk.dim('Enter the name of your R2 bucket with Data Catalog enabled.\n'));

    const { bucketName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'bucketName',
        message: 'Enter your R2 Bucket Name:',
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return 'Bucket name is required';
          }
          return true;
        },
      },
    ]);

    // Store everything
    const credentials: StoredCredentials = {
      access_token: apiToken,
      account_id: trimmedAccountId,
      bucket_name: bucketName.trim(),
    };

    await this.storeTokens(credentials);

    console.log(chalk.green.bold('\n✓ Configuration saved successfully!'));
    console.log(chalk.dim(`\nStored in: ${this.CONFIG_FILE}`));
    console.log(chalk.dim('  • Account ID: ') + chalk.white(trimmedAccountId));
    console.log(chalk.dim('  • Bucket: ') + chalk.white(bucketName.trim()));
    console.log(chalk.dim('  • API Token: ') + chalk.white('****** (hidden)'));

    return {
      accessToken: apiToken,
      source: 'r2sql-shell',
      configPath: this.CONFIG_FILE,
    };
  }

  /**
   * Logout - remove stored credentials
   */
  static async logout(): Promise<void> {
    if (fs.existsSync(this.CONFIG_FILE)) {
      fs.unlinkSync(this.CONFIG_FILE);
    }
    console.log(chalk.green('✓ Logged out successfully'));
  }

  /**
   * Store tokens to disk
   */
  private static async storeTokens(credentials: StoredCredentials): Promise<void> {
    // Create config directory if it doesn't exist
    if (!fs.existsSync(this.CONFIG_DIR)) {
      fs.mkdirSync(this.CONFIG_DIR, { recursive: true, mode: 0o700 });
    }

    // Write config file with restricted permissions
    fs.writeFileSync(
      this.CONFIG_FILE,
      JSON.stringify(credentials, null, 2),
      { mode: 0o600 }
    );
  }

  /**
   * Get stored account ID (if available)
   */
  static async getStoredAccountId(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.CONFIG_FILE)) {
        return null;
      }

      const content = fs.readFileSync(this.CONFIG_FILE, 'utf-8');
      const credentials: StoredCredentials = JSON.parse(content);

      return credentials.account_id || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get stored bucket name (if available)
   */
  static async getStoredBucketName(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.CONFIG_FILE)) {
        return null;
      }

      const content = fs.readFileSync(this.CONFIG_FILE, 'utf-8');
      const credentials: StoredCredentials = JSON.parse(content);

      return credentials.bucket_name || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if user is authenticated
   */
  static async isAuthenticated(): Promise<boolean> {
    const token = await this.getAuthToken();
    return token !== null;
  }

  /**
   * Get authentication status information
   */
  static async getAuthStatus(): Promise<{ authenticated: boolean; source?: string; configPath?: string; accountId?: string; bucketName?: string }> {
    const token = await this.getAuthToken();
    const accountId = await this.getStoredAccountId();
    const bucketName = await this.getStoredBucketName();

    return {
      authenticated: token !== null,
      source: token?.source,
      configPath: token?.configPath,
      accountId: accountId || undefined,
      bucketName: bucketName || undefined,
    };
  }
}
