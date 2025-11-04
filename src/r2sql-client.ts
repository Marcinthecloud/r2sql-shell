import fetch from 'node-fetch';
import { R2SQLConfig, R2SQLQueryResult } from './types.js';
import fs from 'fs';
import path from 'path';

export class R2SQLClient {
  private config: R2SQLConfig;
  private debugLog: fs.WriteStream | null = null;

  constructor(config: R2SQLConfig) {
    this.config = config;
    // Create a debug log file only if debug is enabled
    if (config.debugEnabled) {
      const logPath = path.join(process.cwd(), 'r2sql-debug.log');
      this.debugLog = fs.createWriteStream(logPath, { flags: 'a' });
      this.debug('\n\n=== NEW SESSION ===\n');
    }
  }

  private debug(message: string) {
    if (this.debugLog) {
      this.debugLog.write(`${new Date().toISOString()} - ${message}\n`);
    }
  }

  async executeQuery(sql: string): Promise<R2SQLQueryResult> {
    // Correct R2 SQL endpoint format
    const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${this.config.accountId}/r2-sql/query/${this.config.bucketName}`;

    const requestBody = {
      query: sql,
    };

    // Debug: Log the request details
    this.debug('\n=== R2 SQL REQUEST DEBUG ===');
    this.debug(`URL: ${url}`);
    this.debug('Method: POST');
    this.debug(`Headers: ${JSON.stringify({
      'Authorization': `Bearer ${this.config.apiToken.substring(0, 10)}...`,
      'Content-Type': 'application/json',
    })}`);
    this.debug(`Body: ${JSON.stringify(requestBody, null, 2)}`);
    this.debug('===========================\n');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      this.debug('\n=== R2 SQL RESPONSE DEBUG ===');
      this.debug(`Status: ${response.status} ${response.statusText}`);
      this.debug(`Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2)}`);
      this.debug('============================\n');

      if (!response.ok) {
        const errorText = await response.text();
        this.debug(`Error Response Body: ${errorText}`);
        let errorMessage: string;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.errors?.[0]?.message || errorJson.error || errorText;
        } catch {
          errorMessage = errorText;
        }

        return {
          data: [],
          error: `Query failed: ${errorMessage}`,
        };
      }

      const result = await response.json() as any;

      this.debug(`Response Body: ${JSON.stringify(result, null, 2)}`);

      // Capture response headers
      const headers: any = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // R2 SQL response structure can vary - try multiple paths
      let data: any[] = [];
      let meta: any = {};
      let schema: any = null;

      this.debug(`result is array: ${Array.isArray(result)}`);
      this.debug(`result.result exists: ${!!result.result}`);
      this.debug(`result.result is array: ${Array.isArray(result.result)}`);
      this.debug(`result.result type: ${typeof result.result}`);

      if (result.result && typeof result.result === 'object') {
        this.debug(`result.result keys: ${Object.keys(result.result).join(', ')}`);
      }

      // R2 SQL response structure: result.result.rows is the data array
      if (result.result?.rows) {
        data = result.result.rows;
        schema = result.result.schema;
        meta = result.result.metrics || result.result.meta || {};
        this.debug('Using result.result.rows (R2 SQL format)');
      } else if (Array.isArray(result)) {
        // Response is directly an array
        data = result;
        this.debug('Using direct array');
      } else if (result.result) {
        // Cloudflare wrapper with result object
        if (Array.isArray(result.result)) {
          data = result.result;
          this.debug('Using result.result as array');
        } else if (result.result.data) {
          data = result.result.data;
          this.debug('Using result.result.data');
        }
        meta = result.result.meta || result.result.metrics || {};
        schema = result.result.schema;
      } else if (result.data) {
        // Direct data property
        data = result.data;
        meta = result.meta || result.metrics || {};
        schema = result.schema;
        this.debug('Using result.data');
      }

      const metadata = {
        rowCount: data.length,
        r2RequestsCount: meta.r2_requests_count,
        filesScanned: meta.files_scanned,
        bytesScanned: meta.bytes_scanned || meta.bytes_read,
        executionTime: meta.query_time_ms || meta.executionTime,
      };

      this.debug(`Extracted data length: ${data.length}`);
      this.debug(`Extracted metadata: ${JSON.stringify(metadata)}`);
      if (data.length > 0) {
        this.debug(`First row sample: ${JSON.stringify(data[0])}`);
      }

      return {
        data,
        metadata,
        schema,
        headers,
      };
    } catch (error) {
      return {
        data: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
