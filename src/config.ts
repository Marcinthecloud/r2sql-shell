import dotenv from 'dotenv';
import inquirer from 'inquirer';
import { R2SQLConfig } from './types.js';
import { AuthService } from './auth-service.js';

dotenv.config();

export async function loadConfig(options?: {
  accountId?: string;
  bucketName?: string;
  apiToken?: string;
  debugEnabled?: boolean;
}): Promise<R2SQLConfig> {
  // Priority: CLI args > stored config > env vars
  // CLI --bucket flag always overrides stored bucket
  let accountId = options?.accountId || await AuthService.getStoredAccountId() || process.env.CLOUDFLARE_ACCOUNT_ID;
  let bucketName = options?.bucketName || await AuthService.getStoredBucketName() || process.env.R2_BUCKET_NAME;

  // Try to get API token from multiple sources with priority chain
  let apiToken = options?.apiToken;

  // If no token provided via options, try the auth service
  if (!apiToken) {
    const authToken = await AuthService.getAuthToken();
    if (authToken) {
      apiToken = authToken.accessToken;
    }
  }

  if (!accountId || !bucketName || !apiToken) {
    throw new Error(
      'Missing required configuration. Please provide:\n' +
      '  - CLOUDFLARE_ACCOUNT_ID\n' +
      '  - R2_BUCKET_NAME\n' +
      '  - CLOUDFLARE_API_TOKEN\n\n' +
      'Easy setup:\n' +
      '  1. Run `r2sql-shell login` - this will guide you through setup\n' +
      '     and store everything for future use (recommended)\n\n' +
      'Alternative methods:\n' +
      '  2. Set environment variables in a .env file\n' +
      '  3. Pass credentials as command line arguments'
    );
  }

  const warehouse = `${accountId}_${bucketName}`;
  const catalogEndpoint = `https://catalog.cloudflarestorage.com/${accountId}/${bucketName}`;

  return {
    accountId,
    bucketName,
    apiToken,
    warehouse,
    catalogEndpoint,
    debugEnabled: options?.debugEnabled || false,
  };
}

export async function promptForConfig(debugEnabled?: boolean): Promise<R2SQLConfig> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'accountId',
      message: 'Enter your Cloudflare Account ID:',
      validate: (input: string) => input.trim().length > 0 || 'Account ID is required',
    },
    {
      type: 'input',
      name: 'bucketName',
      message: 'Enter your R2 Bucket Name:',
      validate: (input: string) => input.trim().length > 0 || 'Bucket name is required',
    },
    {
      type: 'password',
      name: 'apiToken',
      message: 'Enter your Cloudflare API Token:',
      mask: '*',
      validate: (input: string) => input.trim().length > 0 || 'API token is required',
    },
  ]);

  // Clean up stdin after inquirer to prevent double input issues
  // Remove all listeners and reset terminal state
  process.stdin.removeAllListeners();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  const warehouse = `${answers.accountId}_${answers.bucketName}`;
  const catalogEndpoint = `https://catalog.cloudflarestorage.com/${answers.accountId}/${answers.bucketName}`;

  return {
    accountId: answers.accountId,
    bucketName: answers.bucketName,
    apiToken: answers.apiToken,
    warehouse,
    catalogEndpoint,
    debugEnabled: debugEnabled || false,
  };
}
