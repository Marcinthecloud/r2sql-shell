import dotenv from 'dotenv';
import inquirer from 'inquirer';
import { R2SQLConfig } from './types.js';

dotenv.config();

export function loadConfig(options?: {
  accountId?: string;
  bucketName?: string;
  apiToken?: string;
  debugEnabled?: boolean;
}): R2SQLConfig {
  const accountId = options?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucketName = options?.bucketName || process.env.R2_BUCKET_NAME;
  const apiToken = options?.apiToken || process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !bucketName || !apiToken) {
    throw new Error(
      'Missing required configuration. Please provide:\n' +
      '  - CLOUDFLARE_ACCOUNT_ID (--account-id)\n' +
      '  - R2_BUCKET_NAME (--bucket)\n' +
      '  - CLOUDFLARE_API_TOKEN (--token)\n\n' +
      'Either set these in a .env file or pass them as command line arguments.'
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
