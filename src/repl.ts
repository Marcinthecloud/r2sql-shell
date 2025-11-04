import * as readline from 'readline';
import chalk from 'chalk';
import { R2SQLClient } from './r2sql-client.js';
import { IcebergCatalogClient } from './iceberg-client.js';
import { ResultFormatter } from './formatter.js';
import { R2SQLConfig } from './types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class R2SQLREPL {
  private sqlClient: R2SQLClient;
  private catalogClient: IcebergCatalogClient;
  private formatter: ResultFormatter;
  private rl: readline.Interface;
  private history: string[] = [];
  private historyFile: string;
  private namespaces: string[] = [];
  private tables: Map<string, string[]> = new Map();

  constructor(config: R2SQLConfig) {
    this.sqlClient = new R2SQLClient(config);
    this.catalogClient = new IcebergCatalogClient(config);
    this.formatter = new ResultFormatter();
    this.historyFile = path.join(os.homedir(), '.r2sql_history');

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.blue.bold('r2sql> '),
      completer: this.completer.bind(this),
    });

    this.loadHistory();
    this.setupReadline();
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        const content = fs.readFileSync(this.historyFile, 'utf-8');
        this.history = content.split('\n').filter(line => line.trim());
      }
    } catch (error) {
      // Ignore history load errors
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(this.historyFile, this.history.join('\n'));
    } catch (error) {
      // Ignore history save errors
    }
  }

  private setupReadline(): void {
    this.rl.on('line', async (line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Add to history
      if (this.history[this.history.length - 1] !== trimmed) {
        this.history.push(trimmed);
        this.saveHistory();
      }

      await this.handleCommand(trimmed);
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log(chalk.cyan('\nGoodbye!'));
      process.exit(0);
    });
  }

  private completer(line: string): [string[], string] {
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT',
      'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
      'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
      'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
      'SHOW TABLES', 'SHOW NAMESPACES', 'DESCRIBE',
    ];

    const allCompletions = [...keywords, ...this.namespaces];

    // Add tables from all namespaces
    for (const tables of this.tables.values()) {
      allCompletions.push(...tables);
    }

    const upperLine = line.toUpperCase();
    const hits = allCompletions.filter(c => c.toUpperCase().startsWith(upperLine));

    return [hits.length ? hits : allCompletions, line];
  }

  private async handleCommand(input: string): Promise<void> {
    const command = input.toLowerCase().trim();

    // Special commands
    if (command === 'exit' || command === 'quit' || command === '.exit') {
      this.rl.close();
      return;
    }

    if (command === 'help' || command === '.help') {
      this.printHelp();
      return;
    }

    if (command === 'show namespaces' || command === '.namespaces') {
      await this.showNamespaces();
      return;
    }

    if (command.startsWith('show tables') || command.startsWith('.tables')) {
      const parts = command.split(/\s+/);
      // Handle "SHOW TABLES", "SHOW TABLES namespace", or "SHOW TABLES IN namespace"
      let namespace: string | undefined;
      if (parts.length >= 3) {
        // Check if there's an "IN" keyword
        if (parts[2].toLowerCase() === 'in' && parts.length >= 4) {
          namespace = parts[3];
        } else if (parts[2].toLowerCase() !== 'in') {
          namespace = parts[2];
        }
      }
      await this.showTables(namespace);
      return;
    }

    if (command.startsWith('describe ') || command.startsWith('.describe ')) {
      const tableName = input.slice(input.indexOf(' ') + 1).trim();
      await this.describeTable(tableName);
      return;
    }

    // Execute SQL query
    await this.executeSQL(input);
  }

  private printHelp(): void {
    const help = `
${chalk.cyan.bold('R2 SQL Shell - Interactive REPL')}

${chalk.yellow('Special Commands:')}
  ${chalk.green('.help')}                     Show this help message
  ${chalk.green('.exit, exit, quit')}         Exit the shell
  ${chalk.green('SHOW NAMESPACES')}           List all namespaces
  ${chalk.green('SHOW TABLES')}               List tables in default namespace
  ${chalk.green('SHOW TABLES [IN] <ns>')}    List tables in specific namespace
  ${chalk.green('DESCRIBE <table>')}          Show table schema

${chalk.yellow('SQL Commands:')}
  Execute any R2 SQL query (SELECT, etc.)

${chalk.yellow('Tips:')}
  - Use TAB for auto-completion
  - Use arrow keys to navigate history
  - R2 SQL has some limitations compared to standard SQL
  - See: ${chalk.dim('https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/')}

${chalk.yellow('Examples:')}
  ${chalk.dim('SELECT * FROM my_table LIMIT 10')}
  ${chalk.dim('SELECT COUNT(*) FROM my_table WHERE status = \'active\'')}
`;
    console.log(help);
  }

  private async showNamespaces(): Promise<void> {
    try {
      console.log(chalk.cyan('Fetching namespaces...'));
      this.namespaces = await this.catalogClient.listNamespaces();

      if (this.namespaces.length === 0) {
        console.log(chalk.yellow('No namespaces found'));
        return;
      }

      console.log(chalk.green.bold('\nNamespaces:'));
      for (const ns of this.namespaces) {
        console.log(chalk.cyan(`  • ${ns}`));
      }
    } catch (error) {
      console.log(this.formatter.formatError(error instanceof Error ? error.message : String(error)));
    }
  }

  private async showTables(namespace?: string): Promise<void> {
    try {
      if (!namespace && this.namespaces.length === 0) {
        this.namespaces = await this.catalogClient.listNamespaces();
      }

      const ns = namespace || this.namespaces[0];

      if (!ns) {
        console.log(chalk.yellow('No namespace specified and no default namespace available'));
        console.log(chalk.dim('Use: SHOW TABLES <namespace>'));
        return;
      }

      console.log(chalk.cyan(`Fetching tables in namespace: ${ns}...`));
      const tables = await this.catalogClient.listTables(ns);
      this.tables.set(ns, tables);

      if (tables.length === 0) {
        console.log(chalk.yellow(`No tables found in namespace: ${ns}`));
        return;
      }

      console.log(chalk.green.bold(`\nTables in ${ns}:`));
      for (const table of tables) {
        console.log(chalk.cyan(`  • ${table}`));
      }
    } catch (error) {
      console.log(this.formatter.formatError(error instanceof Error ? error.message : String(error)));
    }
  }

  private async describeTable(tableName: string): Promise<void> {
    try {
      // Try to find the table in cached namespaces
      let foundNamespace: string | null = null;

      for (const [ns, tables] of this.tables.entries()) {
        if (tables.includes(tableName)) {
          foundNamespace = ns;
          break;
        }
      }

      if (!foundNamespace) {
        // Try first namespace or ask for more info
        if (this.namespaces.length === 0) {
          this.namespaces = await this.catalogClient.listNamespaces();
        }
        foundNamespace = this.namespaces[0];
      }

      if (!foundNamespace) {
        console.log(chalk.yellow('Could not determine namespace for table. Use: DESCRIBE <namespace>.<table>'));
        return;
      }

      console.log(chalk.cyan(`Fetching schema for ${foundNamespace}.${tableName}...`));
      const metadata = await this.catalogClient.getTableMetadata(foundNamespace, tableName);

      if (!metadata || !metadata.schema) {
        console.log(chalk.yellow('Could not fetch table metadata'));
        return;
      }

      console.log(chalk.green.bold(`\nTable: ${foundNamespace}.${tableName}`));
      console.log(chalk.cyan.bold('\nColumns:'));

      for (const field of metadata.schema.fields) {
        const typeStr = typeof field.type === 'string' ? field.type : JSON.stringify(field.type);
        const required = field.required ? chalk.red('NOT NULL') : chalk.dim('NULL');
        console.log(`  ${chalk.cyan(field.name.padEnd(30))} ${chalk.yellow(typeStr.padEnd(20))} ${required}`);
      }
    } catch (error) {
      console.log(this.formatter.formatError(error instanceof Error ? error.message : String(error)));
    }
  }

  private async executeSQL(sql: string): Promise<void> {
    try {
      console.log(chalk.dim('Executing query...'));
      const result = await this.sqlClient.executeQuery(sql);

      if (result.error) {
        console.log(this.formatter.formatError(result.error));
        return;
      }

      if (result.data.length === 0) {
        console.log(chalk.yellow('Query executed successfully. No rows returned.'));
        if (result.metadata) {
          console.log(this.formatter.formatMetadata(result.metadata));
        }
        return;
      }

      // Display table
      console.log('\n' + this.formatter.formatTable(result.data));

      // Try to show a chart
      const chart = this.formatter.tryAutoChart(result.data);
      if (chart) {
        console.log(chart);
      }

      // Show metadata
      if (result.metadata) {
        console.log('\n' + this.formatter.formatMetadata(result.metadata));
      }

      console.log(chalk.green.bold('\n✓ Query completed successfully\n'));
    } catch (error) {
      console.log(this.formatter.formatError(error instanceof Error ? error.message : String(error)));
    }
  }

  async start(): Promise<void> {
    this.printBanner();
    console.log(chalk.dim('Type .help for help, .exit to quit\n'));

    // Pre-fetch namespaces for autocomplete
    this.catalogClient.listNamespaces()
      .then(namespaces => {
        this.namespaces = namespaces;
      })
      .catch(() => {
        // Ignore errors in background fetch
      });

    this.rl.prompt();
  }

  private printBanner(): void {
    const banner = `
${chalk.cyan.bold('╔══════════════════════════════════════╗')}
${chalk.cyan.bold('║')}     ${chalk.white.bold('R2 SQL Interactive Shell')}      ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════╝')}
`;
    console.log(banner);
  }
}
