import fetch, { RequestInit } from 'node-fetch';
import { R2SQLConfig, IcebergNamespace, IcebergTable, TableMetadata } from './types.js';
import fs from 'fs';
import path from 'path';

export class IcebergCatalogClient {
  private config: R2SQLConfig;
  private baseUrl: string;
  private prefix: string | null = null;
  private initialized: boolean = false;
  private debugLog: fs.WriteStream | null = null;

  constructor(config: R2SQLConfig) {
    this.config = config;
    this.baseUrl = config.catalogEndpoint;

    // Create a debug log file only if debug is enabled
    if (config.debugEnabled) {
      const logPath = path.join(process.cwd(), 'r2sql-debug.log');
      this.debugLog = fs.createWriteStream(logPath, { flags: 'a' });
    }
  }

  private debug(message: string) {
    if (this.debugLog) {
      this.debugLog.write(`${new Date().toISOString()} - [Iceberg] ${message}\n`);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Call /v1/config to get the prefix
      const url = new URL(`${this.baseUrl}/v1/config`);
      url.searchParams.set('warehouse', this.config.warehouse);

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const configResult = await response.json() as any;

        // Extract prefix from overrides or defaults
        let prefix = configResult.overrides?.prefix || configResult.defaults?.prefix;

        if (prefix) {
          // URL decode the prefix and only use it if it doesn't match warehouse
          this.prefix = decodeURIComponent(prefix);
          if (this.prefix === this.config.warehouse) {
            this.prefix = null; // Don't duplicate warehouse in path
          }
        }
      }
    } catch (error) {
      // Ignore config errors and continue without prefix
      this.debug(`Warning: Could not fetch catalog config: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.initialized = true;
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    await this.initialize();

    // Inject prefix if it exists
    let finalPath = path;
    if (this.prefix && path.startsWith('/v1/') && this.prefix !== this.config.warehouse) {
      finalPath = `/v1/${this.prefix}${path.substring(3)}`;
    }

    // Add warehouse parameter to path
    const separator = finalPath.includes('?') ? '&' : '?';
    finalPath = `${finalPath}${separator}warehouse=${encodeURIComponent(this.config.warehouse)}`;

    // Build full URL
    const fullUrl = `${this.baseUrl}${finalPath}`;

    this.debug(`\n=== ICEBERG REQUEST ===`);
    this.debug(`URL: ${fullUrl}`);
    this.debug(`Method: ${options?.method || 'GET'}`);

    try {
      const response = await fetch(fullUrl, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...options?.headers,
        },
      });

      this.debug(`Response Status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.debug(`Error Response: ${errorText}`);
        throw new Error(`Iceberg API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      this.debug(`Response: ${JSON.stringify(result, null, 2)}`);
      return result;
    } catch (error) {
      this.debug(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Failed to call Iceberg API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listNamespaces(): Promise<string[]> {
    try {
      const result = await this.request('/v1/namespaces');
      // Response format: { namespaces: [["ns1"], ["ns2"], ...] }
      const namespaces: string[][] = result.namespaces || [];
      return namespaces.map(ns => ns.join('.'));
    } catch (error) {
      // 404 might mean no namespaces exist yet, which is OK - silently return empty array
      if (error instanceof Error && error.message.includes('404')) {
        this.debug('No namespaces found (404)');
        return [];
      }
      // Only log non-404 errors
      this.debug(`Error listing namespaces: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async listTables(namespace: string): Promise<string[]> {
    try {
      // Use ASCII unit separator (\u001f) for namespace path, then URL encode
      const namespaceParts = namespace.split('.');
      const namespacePath = namespaceParts.map(part => encodeURIComponent(part)).join('%1F');
      const result = await this.request(`/v1/namespaces/${namespacePath}/tables`);
      const tables: IcebergTable[] = result.identifiers || [];
      return tables.map(t => t.name);
    } catch (error) {
      this.debug(`Error listing tables in namespace ${namespace}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async getTableMetadata(namespace: string, tableName: string): Promise<TableMetadata | null> {
    try {
      // Use ASCII unit separator (\u001f) for namespace path, then URL encode
      const namespaceParts = namespace.split('.');
      const namespacePath = namespaceParts.map(part => encodeURIComponent(part)).join('%1F');
      const result = await this.request(`/v1/namespaces/${namespacePath}/tables/${encodeURIComponent(tableName)}`);

      return {
        name: tableName,
        namespace: namespace.split('.'),
        schema: result.metadata?.['current-schema'] || result.metadata?.schemas?.[0],
        fullMetadata: result.metadata, // Include the full Iceberg metadata
      };
    } catch (error) {
      this.debug(`Error getting metadata for table ${namespace}.${tableName}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
