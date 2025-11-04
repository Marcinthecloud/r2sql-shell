import chalk from 'chalk';
import Table from 'cli-table3';
import asciichart from 'asciichart';
import { format } from 'sql-formatter';

export class ResultFormatter {
  formatSQL(sql: string): string {
    try {
      return format(sql, {
        language: 'sql',
        keywordCase: 'upper',
      });
    } catch {
      return sql;
    }
  }

  formatError(error: string): string {
    const lines = [
      chalk.red.bold('✗ Error'),
      chalk.red(error),
    ];

    // Add helpful suggestions based on error patterns
    if (error.includes('syntax')) {
      lines.push('');
      lines.push(chalk.yellow('💡 Tip: Check your SQL syntax. R2 SQL has some limitations.'));
      lines.push(chalk.dim('   See: https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/'));
    } else if (error.includes('table') || error.includes('not found')) {
      lines.push('');
      lines.push(chalk.yellow('💡 Tip: Use SHOW TABLES to see available tables.'));
    } else if (error.includes('unauthorized') || error.includes('auth')) {
      lines.push('');
      lines.push(chalk.yellow('💡 Tip: Check your API token has the correct permissions.'));
    }

    return lines.join('\n');
  }

  formatTable(data: any[]): string {
    if (data.length === 0) {
      return chalk.yellow('No results');
    }

    const columns = Object.keys(data[0]);
    const table = new Table({
      head: columns.map(col => chalk.cyan.bold(col)),
      style: {
        head: [],
        border: ['grey'],
      },
      wordWrap: true,
    });

    for (const row of data) {
      table.push(columns.map(col => {
        const value = row[col];
        if (value === null) return chalk.dim('NULL');
        if (typeof value === 'number') return chalk.green(value.toString());
        if (typeof value === 'boolean') return chalk.blue(value.toString());
        return String(value);
      }));
    }

    return table.toString();
  }

  formatMetadata(metadata?: { rowCount?: number; executionTime?: number; bytesScanned?: number }): string {
    if (!metadata) return '';

    const lines: string[] = [];

    if (metadata.rowCount !== undefined) {
      lines.push(chalk.dim(`Rows: ${chalk.white(metadata.rowCount.toLocaleString())}`));
    }

    if (metadata.executionTime !== undefined) {
      lines.push(chalk.dim(`Time: ${chalk.white(metadata.executionTime.toFixed(2))}ms`));
    }

    if (metadata.bytesScanned !== undefined) {
      const kb = metadata.bytesScanned / 1024;
      const mb = kb / 1024;
      const sizeStr = mb >= 1 ? `${mb.toFixed(2)} MB` : `${kb.toFixed(2)} KB`;
      lines.push(chalk.dim(`Scanned: ${chalk.white(sizeStr)}`));
    }

    return lines.join(' | ');
  }

  tryAutoChart(data: any[]): string | null {
    if (data.length < 2) return null;

    const columns = Object.keys(data[0]);

    // Look for time series data (date/time column + numeric column)
    const timeColumn = columns.find(col =>
      col.toLowerCase().includes('time') ||
      col.toLowerCase().includes('date') ||
      col.toLowerCase().includes('timestamp')
    );

    const numericColumns = columns.filter(col =>
      typeof data[0][col] === 'number' && col !== timeColumn
    );

    if (timeColumn && numericColumns.length > 0) {
      // Time series chart
      const series = data.map(row => row[numericColumns[0]]);
      const chart = asciichart.plot(series, {
        height: 10,
        colors: [asciichart.blue],
      });

      return '\n' + chalk.cyan.bold(`Chart: ${numericColumns[0]} over ${timeColumn}`) + '\n' + chart;
    }

    // Simple bar chart for categorical data
    if (columns.length === 2 && numericColumns.length === 1 && data.length <= 20) {
      const labelColumn = columns.find(col => col !== numericColumns[0])!;
      const maxValue = Math.max(...data.map(row => row[numericColumns[0]]));
      const barWidth = 50;

      const lines = data.map(row => {
        const label = String(row[labelColumn]).padEnd(15).slice(0, 15);
        const value = row[numericColumns[0]];
        const barLength = Math.round((value / maxValue) * barWidth);
        const bar = chalk.green('█'.repeat(barLength));
        return `${chalk.cyan(label)} ${bar} ${chalk.white(value)}`;
      });

      return '\n' + chalk.cyan.bold(`Bar Chart: ${numericColumns[0]} by ${labelColumn}`) + '\n' + lines.join('\n');
    }

    return null;
  }
}
