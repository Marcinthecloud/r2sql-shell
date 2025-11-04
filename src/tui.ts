// Import blessed - handle both ESM and CJS contexts
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// In CJS bundle, import.meta.url will be undefined, so we use __filename as fallback
let blessed: any;
try {
  const requireFunc = typeof import.meta.url !== 'undefined'
    ? createRequire(import.meta.url)
    : typeof __filename !== 'undefined'
    ? createRequire(__filename)
    : require;
  blessed = requireFunc('blessed');
} catch {
  // Fallback for edge cases
  blessed = require('blessed');
}

import { R2SQLClient } from './r2sql-client.js';
import { IcebergCatalogClient } from './iceberg-client.js';
import { R2SQLConfig } from './types.js';
import { format } from 'sql-formatter';
import fs from 'fs';
import path from 'path';

type Mode = 'navigation' | 'insert' | 'visual';
type ActiveTab = 'query' | 'history' | 'favorites';

export class R2SQLTUI {
  private screen: any;
  private sqlClient: R2SQLClient;
  private catalogClient: IcebergCatalogClient;
  private config: R2SQLConfig;
  private executeOnStart: string | undefined;
  private historyEnabled: boolean;

  // UI Components
  private sidebar: any;
  private queryEditor: any;
  private resultsTable: any;
  private statusBar: any;
  private tabBar: any;
  private historyList: any;
  private autocompleteBox: any;

  // State
  private mode: Mode = 'navigation';
  private activeTab: ActiveTab = 'query';
  private namespaces: Map<string, string[]> = new Map();
  private queryHistory: string[] = [];
  private currentNamespace: string | null = null;
  private autocompleteVisible: boolean = false;
  private autocompleteTimeout: NodeJS.Timeout | null = null;
  private isMac: boolean = process.platform === 'darwin';
  private resultsViewMode: 'table' | 'list' = 'list'; // Default to list view
  private lastResultData: any[] = [];
  private lastResultMetadata: any = null;
  private lastResultSchema: any = null;
  private lastResponseHeaders: any = null;
  private lastTableMetadata: any = null; // Iceberg table metadata
  private resultsDisplayMode: 'data' | 'schema' | 'headers' | 'metadata' = 'data';
  private searchActive: boolean = false;
  private searchTerm: string = '';
  private searchBox: any;
  private searchMatches: number[] = []; // Indices of matching rows/items
  private currentMatchIndex: number = 0; // Current match being viewed
  // R2 SQL supported keywords only (no JOINs, GROUP BY, aggregate functions, etc.)
  private sqlKeywords: string[] = [
    'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'LIMIT',
    'AND', 'OR', 'NOT', 'LIKE', 'IS NULL', 'IS NOT NULL',
    'ASC', 'DESC',
  ];

  constructor(config: R2SQLConfig, options?: { executeOnStart?: string; historyEnabled?: boolean }) {
    this.config = config;
    this.sqlClient = new R2SQLClient(config);
    this.catalogClient = new IcebergCatalogClient(config);
    this.executeOnStart = options?.executeOnStart;
    this.historyEnabled = options?.historyEnabled || false;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'R2 SQL Shell - Powered by Cloudflare',
      fullUnicode: true,
      sendFocus: true, // Enable focus events
    });

    this.setupUI();
    this.setupKeyBindings();
    this.showLoadingScreen();
  }

  private setupUI() {
    // Sidebar (left panel)
    this.sidebar = blessed.list({
      parent: this.screen,
      label: ' Schemas ',
      tags: true,
      top: 0,
      left: 0,
      width: '25%',
      height: '100%-2',
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'default',
        border: { fg: '#F38020' }, // Cloudflare orange
        selected: { bg: '#C85000', fg: 'white', bold: true }, // Darker orange for better contrast
        label: { fg: '#F38020', bold: true },
      },
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      scrollbar: {
        ch: '█',
        style: { fg: '#F38020' },
      },
    });

    // Tab bar
    this.tabBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: '25%',
      width: '75%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    // Query editor
    this.queryEditor = blessed.textarea({
      parent: this.screen,
      label: ' Query <2> ',
      tags: true,
      top: 1,
      left: '25%',
      width: '75%',
      height: '50%-1',
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'default',
        border: { fg: '#F38020' },
        focus: { border: { fg: 'white' } },
        label: { fg: 'cyan', bold: true },
      },
      keys: true,
      mouse: true,
      scrollable: true,
      inputOnFocus: true, // Enable input on focus so cursor shows
      editor: null, // Disable built-in editor to prevent Ctrl+E from opening it
    });

    // Tab key - just prevent default tab insertion
    // Autocomplete has been disabled due to reliability issues
    // Use the sidebar to select and insert tables instead
    this.queryEditor.key(['tab'], () => {
      return false; // Prevent tab insertion
    });

    // Autocomplete box (hidden by default)
    this.autocompleteBox = blessed.list({
      parent: this.screen,
      top: 10,
      left: '30%',
      width: 40,
      height: 10,
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: '#F38020' },
        selected: { bg: '#C85000', fg: 'white', bold: true },
      },
      keys: true,
      vi: true,
      mouse: true,
      hidden: true,
      label: ' Autocomplete ',
    });

    this.autocompleteBox.on('select', (item: any) => {
      const text = this.getItemText(item);
      this.insertAutocomplete(text);
    });

    this.autocompleteBox.key(['escape'], () => {
      this.hideAutocomplete();
    });

    // History list (hidden by default)
    this.historyList = blessed.list({
      parent: this.screen,
      label: ' History <4> ',
      tags: true,
      top: 1,
      left: '25%',
      width: '75%',
      height: '50%-1',
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'default',
        border: { fg: '#F38020' },
        selected: { bg: '#C85000', fg: 'white', bold: true },
        label: { fg: '#F38020', bold: true },
      },
      keys: true,
      vi: true,
      mouse: true,
      hidden: true,
    });

    // Results table
    this.resultsTable = blessed.box({
      parent: this.screen,
      label: ' Results <3> ',
      tags: true,
      top: '50%',
      left: '25%',
      width: '75%',
      height: '50%-2',
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'default',
        border: { fg: '#F38020' },
        label: { fg: 'cyan', bold: true },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        style: { fg: '#F38020' },
      },
      keys: true,
      vi: true,
      mouse: true,
    });

    // Status bar
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 2,
      tags: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    // Search box (hidden by default)
    this.searchBox = blessed.textbox({
      parent: this.screen,
      bottom: 2,
      left: 0,
      width: '50%',
      height: 3,
      border: { type: 'line' },
      label: ' Search/Filter (searches column names & values) ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: '#F38020' },
        focus: { border: { fg: 'white' } },
        label: { fg: '#F38020', bold: true },
      },
      keys: true,
      mouse: true,
      inputOnFocus: true,
      hidden: true,
    });

    // Handle search box input
    let searchTimeout: NodeJS.Timeout | null = null;

    const triggerSearch = () => {
      // Clear any pending timeout
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }

      // Update search term and filter results with debouncing
      searchTimeout = setTimeout(() => {
        const currentValue = this.searchBox.getValue() || '';
        this.searchTerm = currentValue;
        this.filterResults();
        searchTimeout = null;
      }, 100);
    };

    this.searchBox.on('keypress', (ch: string, key: any) => {
      if (!key) return;

      // Allow escape to close search
      if (key.name === 'escape') {
        this.closeSearch();
        return;
      }

      triggerSearch();
    });

    // Explicitly handle backspace and delete keys
    this.searchBox.key(['backspace', 'delete', 'C-h', 'C-d', 'C-u', 'C-w'], () => {
      triggerSearch();
    });

    this.searchBox.key(['C-c'], () => {
      this.closeSearch();
    });

    // Set initial content with subtle guidance
    this.queryEditor.setValue('-- Type your SQL query here\n-- Press F5 or x (in navigation mode) to execute\n-- Press ? for help\n\nSELECT ');

    this.resultsTable.setContent(
      '{center}{#F38020-fg}Welcome to R2 SQL Shell!{/}\n\n' +
      '{#CCCCCC-fg}Press ? for keyboard shortcuts\n' +
      'Navigate the sidebar with j/k and expand namespaces with l{/}'
    );

    this.updateStatusBar();
    this.updateTabBar();
    // Start focused on sidebar in normal mode
    this.sidebar.focus();
  }

  private setupKeyBindings() {
    // Escape key - exit insert mode or close autocomplete or go back
    this.screen.key(['escape'], () => {
      if (this.autocompleteVisible) {
        this.hideAutocomplete();
        return;
      }
      if (this.mode === 'insert' || this.screen.focused === this.queryEditor) {
        this.setMode('navigation');
        // Instead of canceling, just move focus to sidebar
        this.sidebar.focus();
        this.screen.render();
        return;
      }
      // In navigation mode, escape doesn't do anything (prevents crashes)
      return;
    });

    // Ctrl+C or 'q' in navigation mode - quit the application
    this.screen.key(['C-c', 'q'], () => {
      if (this.mode === 'navigation') {
        return this.quit();
      }
    });

    // Tab switching - using number keys in navigation mode (works better on Mac)
    this.screen.key(['1'], () => {
      if (this.mode === 'navigation') {
        this.sidebar.focus();
      }
    });
    this.screen.key(['2'], () => {
      if (this.mode === 'navigation') {
        this.switchTab('query');
      }
    });
    this.screen.key(['3'], () => {
      if (this.mode === 'navigation') {
        this.resultsTable.focus();
      }
    });
    this.screen.key(['4'], () => {
      if (this.mode === 'navigation') {
        this.switchTab('history');
      }
    });
    // Note: Key "5" and favorites are not implemented yet

    // Also keep Alt/Option key shortcuts for terminals that support them
    this.screen.key(['M-1'], () => this.sidebar.focus());
    this.screen.key(['M-2'], () => this.switchTab('query'));
    this.screen.key(['M-3'], () => this.resultsTable.focus());
    this.screen.key(['M-4'], () => this.switchTab('history'));
    // Note: Alt+5 and favorites are not implemented yet

    // Mode switching
    this.screen.key(['i'], () => {
      if (this.mode === 'navigation' && this.activeTab === 'query') {
        this.setMode('insert');
        this.queryEditor.focus();
        this.screen.render();
      }
    });

    // Execute query - multiple keybindings for Mac compatibility
    // F5 is common in SQL tools and works everywhere
    // Cmd+Return (M-return) works on Mac terminals with Option as Meta
    this.screen.key(['C-e', 'f5', 'F5'], () => {
      this.executeQuery();
    });

    // Format query - multiple keybindings
    this.screen.key(['C-f', 'S-f5'], () => {
      this.formatQuery();
    });

    // Clear query - Ctrl+L
    this.screen.key(['C-l'], () => {
      this.clearQuery();
    });

    // Tab key is now handled directly on the queryEditor component
    // (see queryEditor.key(['tab']) in setupUI)

    // Alternative: Use 'x' in navigation mode to execute (vim-style)
    this.screen.key(['x'], () => {
      if (this.mode === 'navigation' && this.activeTab === 'query') {
        this.executeQuery();
      }
    });

    // Navigation in sidebar
    this.screen.key(['h', 'left'], () => {
      if (this.mode === 'navigation') {
        this.sidebar.focus();
      }
    });

    this.screen.key(['l', 'right', 'enter'], () => {
      if (this.mode === 'navigation' && this.screen.focused === this.sidebar) {
        this.onSidebarSelect();
      }
    });

    // Vim-style navigation - only for results pane and top/bottom jumps
    this.screen.key(['j'], () => {
      if (this.mode === 'navigation') {
        const focused = this.screen.focused;
        if (focused === this.resultsTable) {
          this.resultsTable.scroll(1);
          this.screen.render();
        }
        // For lists, let blessed handle j/k with vi mode
      }
    });

    this.screen.key(['k'], () => {
      if (this.mode === 'navigation') {
        const focused = this.screen.focused;
        if (focused === this.resultsTable) {
          this.resultsTable.scroll(-1);
          this.screen.render();
        }
        // For lists, let blessed handle j/k with vi mode
      }
    });

    this.screen.key(['g'], () => {
      if (this.mode === 'navigation') {
        const focused = this.screen.focused;
        if (focused === this.sidebar && this.sidebar.items.length > 0) {
          this.sidebar.select(0);
          this.screen.render();
        } else if (focused === this.historyList && this.historyList.items.length > 0) {
          this.historyList.select(0);
          this.screen.render();
        }
      }
    });

    this.screen.key(['G'], () => {
      if (this.mode === 'navigation') {
        const focused = this.screen.focused;
        if (focused === this.sidebar && this.sidebar.items.length > 0) {
          this.sidebar.select(this.sidebar.items.length - 1);
          this.screen.render();
        } else if (focused === this.historyList && this.historyList.items.length > 0) {
          this.historyList.select(this.historyList.items.length - 1);
          this.screen.render();
        }
      }
    });

    // Refresh
    this.screen.key(['r', 'R'], () => {
      if (this.mode === 'navigation') {
        this.loadNamespacesAndTables();
      }
    });

    // Toggle results view mode (table vs list)
    this.screen.key(['t'], () => {
      if (this.mode === 'navigation') {
        this.resultsViewMode = this.resultsViewMode === 'table' ? 'list' : 'table';
        // Re-render the last results with new view mode
        if (this.lastResultData.length > 0) {
          this.displayResults(this.lastResultData, this.lastResultMetadata);
        }
        this.screen.render();
      }
    });

    // Toggle results display mode (data/schema/headers/metadata)
    this.screen.key(['v'], () => {
      if (this.mode === 'navigation') {
        // Cycle through display modes
        if (this.resultsDisplayMode === 'data') {
          this.resultsDisplayMode = 'schema';
        } else if (this.resultsDisplayMode === 'schema') {
          this.resultsDisplayMode = 'headers';
        } else if (this.resultsDisplayMode === 'headers') {
          this.resultsDisplayMode = 'metadata';
        } else {
          this.resultsDisplayMode = 'data';
        }
        // Re-render with new display mode
        this.displayResults(this.lastResultData, this.lastResultMetadata);
        this.screen.render();
      }
    });

    // Copy results as JSON
    this.screen.key(['c'], () => {
      if (this.mode === 'navigation') {
        this.copyToClipboard('json');
      }
    });

    // Copy results as Markdown table
    this.screen.key(['m'], () => {
      if (this.mode === 'navigation') {
        this.copyToClipboard('markdown');
      }
    });

    // Search/filter results - works for all views
    this.screen.key(['/'], () => {
      if (this.mode === 'navigation') {
        // Allow search if any view has data
        const hasData = this.lastResultData.length > 0 ||
                       (this.lastResultSchema && Array.isArray(this.lastResultSchema)) ||
                       this.lastResponseHeaders ||
                       this.lastTableMetadata;

        if (hasData) {
          this.showSearch();
        }
      }
    });

    // Navigate to next search match
    this.screen.key(['n'], () => {
      if (this.mode === 'navigation' && this.searchActive && this.searchMatches.length > 0) {
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.searchMatches.length;
        this.highlightCurrentMatch();
      }
    });

    // Navigate to previous search match
    this.screen.key(['N'], () => {
      if (this.mode === 'navigation' && this.searchActive && this.searchMatches.length > 0) {
        this.currentMatchIndex = (this.currentMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
        this.highlightCurrentMatch();
      }
    });

    // Help
    this.screen.key(['?'], () => this.showHelp());
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.updateStatusBar();
    this.screen.render();
  }

  private switchTab(tab: ActiveTab) {
    this.activeTab = tab;

    // Hide all panels
    this.queryEditor.hide();
    this.historyList.hide();

    // Show active panel
    switch (tab) {
      case 'query':
        this.queryEditor.show();
        this.queryEditor.focus();
        break;
      case 'history':
        this.historyList.show();
        this.historyList.focus();
        this.updateHistory();
        break;
      case 'favorites':
        // TODO: Implement favorites
        break;
    }

    this.updateTabBar();
    this.screen.render();
  }

  private updateTabBar() {
    const tabs = [
      this.activeTab === 'query' ? '{#C85000-bg}{white-fg} query <2> {/}' : ' query <2> ',
      this.activeTab === 'history' ? '{#C85000-bg}{white-fg} history <4> {/}' : ' history <4> ',
    ];
    this.tabBar.setContent(tabs.join('  '));
  }

  private updateStatusBar() {
    const executeKey = this.isMac ? 'F5 or x' : 'Ctrl+E or F5 or x';

    const modeText = this.mode === 'navigation'
      ? `{yellow-fg}NAVIGATION MODE{/} {#CCCCCC-fg}(press i to enter insert mode, x to execute query){/}`
      : this.mode === 'insert'
      ? `{white-fg}INSERT MODE{/} {#CCCCCC-fg}(press ESC to exit focus and switch to navigation mode, ${executeKey} to execute){/}`
      : '{blue-fg}VISUAL MODE{/}';

    const shortcuts = this.isMac
      ? '{#CCCCCC-fg}[1-4] tabs | [j/k] nav | [F5/x] exec | [Ctrl+L] clear | [t] view | [v] cycle | [/] search [n/N] next/prev | Copy: (c/m) | [?] help{/}'
      : '{#CCCCCC-fg}[1-4] tabs | [j/k] nav | [Ctrl+E/x] exec | [Ctrl+L] clear | [t] view | [v] cycle | [/] search [n/N] next/prev | Copy: (c/m) | [?] help{/}';

    this.statusBar.setContent(`${modeText}\n${shortcuts}`);
  }

  private async onSidebarSelect() {
    const selected = this.sidebar.selected;
    const item = this.sidebar.items[selected];

    if (!item) return;

    const content = this.getItemText(item);
    // Remove blessed tags for parsing
    const plainContent = content.replace(/\{[^}]+\}/g, '');

    const isExpanded = plainContent.startsWith('▾');
    const isCollapsed = plainContent.startsWith('▸');

    if (isCollapsed) {
      // Expand namespace to show tables
      const namespace = plainContent.replace('▸ ', '').trim();
      await this.expandNamespace(selected, namespace);
    } else if (isExpanded) {
      // Collapse namespace
      this.collapseNamespace(selected);
    } else if (plainContent.trim().match(/^[├└]─/)) {
      // It's a table, show schema and insert into query
      const tableName = plainContent.trim().replace(/^└─\s*/, '').replace(/^├─\s*/, '');
      if (this.currentNamespace) {
        const fullName = `${this.currentNamespace}.${tableName}`;
        this.insertIntoQuery(fullName);
        await this.showTableSchema(this.currentNamespace, tableName);
      }
    }
  }

  private async expandNamespace(index: number, namespace: string) {
    try {
      this.currentNamespace = namespace;
      let tables = this.namespaces.get(namespace);

      if (!tables || tables.length === 0) {
        tables = await this.catalogClient.listTables(namespace);
        this.namespaces.set(namespace, tables);
      }

      // Convert all items to plain strings to avoid blessed issues
      const currentItems = this.sidebar.items.map((item: any) => this.getItemText(item));

      // Update the namespace item
      currentItems[index] = `{#F38020-fg}▾{/} {bold}${String(namespace)}{/}`;

      // Add tables below - ensure they're all strings
      const tableItems = tables.map((table, i) => {
        const prefix = i === tables.length - 1 ? '└─' : '├─';
        return `  {white-fg}${prefix}{/} ${String(table)}`;
      });

      currentItems.splice(index + 1, 0, ...tableItems);

      this.sidebar.clearItems();
      this.sidebar.setItems(currentItems);
      this.sidebar.select(index);
      this.screen.render();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.showError('Failed to load tables: ' + errorMsg);
    }
  }

  private collapseNamespace(index: number) {
    // Convert all items to plain strings
    const currentItems = this.sidebar.items.map((item: any) => this.getItemText(item));

    const content = currentItems[index];
    const plainContent = content.replace(/\{[^}]+\}/g, '');
    const namespace = plainContent.replace('▾ ', '').trim();

    // Find how many table items to remove
    let count = 0;
    for (let i = index + 1; i < currentItems.length; i++) {
      const plainText = currentItems[i].replace(/\{[^}]+\}/g, '');
      if (plainText.startsWith('  ')) {
        count++;
      } else {
        break;
      }
    }

    currentItems[index] = `{#F38020-fg}▸{/} ${String(namespace)}`;
    currentItems.splice(index + 1, count);

    this.sidebar.clearItems();
    this.sidebar.setItems(currentItems);
    this.sidebar.select(index);
    this.currentNamespace = null;
    this.screen.render();
  }

  private insertIntoQuery(text: string) {
    const current = this.queryEditor.getValue().trim();

    // If query is empty or doesn't start with SELECT, create a full SELECT statement
    if (!current || !current.toUpperCase().startsWith('SELECT')) {
      this.queryEditor.setValue(`SELECT * FROM ${text}`);
    } else {
      // Append to existing query
      this.queryEditor.setValue(current + ' ' + text);
    }

    this.switchTab('query');
    this.screen.render();
  }

  private async executeQuery() {
    const query = this.queryEditor.getValue().trim();

    if (!query) {
      this.showError('No query to execute');
      return;
    }

    try {
      // Visual feedback that execution started
      this.resultsTable.setLabel(' Results <3> {yellow-fg}(executing...){/}');
      this.resultsTable.setContent('{yellow-fg}Executing query...{/}');
      this.queryEditor.setLabel(' Query <2> {yellow-fg}(running...){/}');
      this.screen.render();

      const result = await this.sqlClient.executeQuery(query);

      // Reset query label
      this.queryEditor.setLabel(' Query <2> ');

      if (result.error) {
        this.resultsTable.setContent(`{red-fg}Error:{/} ${result.error}`);
        this.resultsTable.setLabel(' Results <3> {red-fg}(error){/}');
      } else {
        // Store schema and headers
        this.lastResultSchema = result.schema;
        this.lastResponseHeaders = result.headers;
        this.displayResults(result.data, result.metadata);
        this.queryHistory.push(query);

        // Save to history file if enabled
        if (this.historyEnabled) {
          this.saveQueryToHistoryFile(query);
        }
      }

      this.screen.render();
    } catch (error) {
      this.queryEditor.setLabel(' Query <2> ');
      this.showError('Query execution failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private displayResults(data: any[], metadata?: any, isFiltered: boolean = false) {
    // Store for view toggle - but don't overwrite if this is filtered data
    if (!isFiltered) {
      this.lastResultData = data;
      this.lastResultMetadata = metadata;
    }

    // Check if we should display schema, headers, or metadata instead of data
    if (this.resultsDisplayMode === 'schema') {
      this.displaySchema();
      return;
    } else if (this.resultsDisplayMode === 'headers') {
      this.displayHeaders();
      return;
    } else if (this.resultsDisplayMode === 'metadata') {
      this.displayTableMetadata();
      return;
    }

    if (data.length === 0) {
      let debugInfo = '{yellow-fg}No rows returned{/}\n\n';
      if (metadata) {
        debugInfo += '{#CCCCCC-fg}Query Metadata:{/}\n';
        debugInfo += `  Rows Returned: ${metadata.rowCount || 0}\n`;
        if (metadata.r2RequestsCount) debugInfo += `  R2 Requests: ${metadata.r2RequestsCount}\n`;
        if (metadata.filesScanned) debugInfo += `  Files Scanned: ${metadata.filesScanned}\n`;
        if (metadata.bytesScanned) debugInfo += `  Bytes Scanned: ${metadata.bytesScanned.toLocaleString()}\n`;
        if (metadata.executionTime) debugInfo += `  Execution Time: ${metadata.executionTime} ms\n`;
      }
      this.resultsTable.setContent(debugInfo);
      this.resultsTable.setLabel(' Results <3> {white-fg}(0 rows){/}');
      return;
    }

    const columns = Object.keys(data[0]);
    let output = '';

    // Metadata at the top
    if (metadata) {
      output += '{#F38020-fg}{bold}Query Statistics:{/}\n';
      output += '{#CCCCCC-fg}';
      if (metadata.rowCount !== undefined) output += `Rows: ${metadata.rowCount}  `;
      if (metadata.r2RequestsCount) output += `R2 Requests: ${metadata.r2RequestsCount}  `;
      if (metadata.filesScanned) output += `Files: ${metadata.filesScanned}  `;
      if (metadata.bytesScanned) {
        const kb = metadata.bytesScanned / 1024;
        const mb = kb / 1024;
        output += `Scanned: ${mb >= 1 ? mb.toFixed(2) + ' MB' : kb.toFixed(2) + ' KB'}  `;
      }
      if (metadata.executionTime) output += `Time: ${metadata.executionTime.toFixed(2)} ms`;
      output += '{/}\n';

      // Show filter info if this is filtered data
      if (isFiltered && metadata.rowCount !== undefined) {
        output += `{yellow-fg}Showing ${data.length} of ${metadata.rowCount} rows (filtered){/}\n`;
      }

      output += '{#CCCCCC-fg}' + '─'.repeat(80) + '{/}\n\n';
    }

    // Use the user's selected view mode
    const useListView = this.resultsViewMode === 'list';

    if (useListView) {
      // Display each row vertically
      data.forEach((row, rowIdx) => {
        output += `{#F38020-fg}Row ${rowIdx + 1}:{/}\n`;

        const maxKeyLength = Math.max(...columns.map(c => c.length));

        columns.forEach(col => {
          const value = row[col];
          let displayValue = this.formatValueWithColor(value);

          output += `  {#F38020-fg}${col.padEnd(maxKeyLength)}{/}: ${displayValue}\n`;
        });

        output += '\n';
      });
    } else {
      // Use horizontal table layout
      const columnWidth = Math.floor((this.resultsTable.width as number - 4) / columns.length);

      // Header
      output += '{#F38020-fg}{bold}';
      columns.forEach(col => {
        output += col.padEnd(columnWidth).substring(0, columnWidth);
      });
      output += '{/}\n';
      output += '─'.repeat((this.resultsTable.width as number - 2)) + '\n';

      // Rows
      data.forEach(row => {
        columns.forEach(col => {
          const value = row[col];
          let displayValue = this.formatValueWithColor(value);
          // Strip tags for length calculation
          const plainValue = displayValue.replace(/\{[^}]+\}/g, '');
          if (plainValue.length > columnWidth - 1) {
            const truncated = plainValue.substring(0, columnWidth - 4) + '...';
            displayValue = this.formatValueWithColor(value === null ? null : truncated);
          }
          // Pad based on plain length
          const padding = Math.max(0, columnWidth - plainValue.length);
          output += displayValue + ' '.repeat(padding);
        });
        output += '\n';
      });
    }

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {white-fg}(${data.length} rows){/} {gray-fg}${viewLabel} [data]{/}`);
  }

  private displaySchema() {
    if (!this.lastResultSchema) {
      this.resultsTable.setContent('{yellow-fg}No schema information available{/}');
      this.resultsTable.setLabel(' Results <3> {gray-fg}[schema]{/}');
      return;
    }

    let output = '{#F38020-fg}{bold}Query Schema:{/}\n\n';

    if (Array.isArray(this.lastResultSchema)) {
      const useListView = this.resultsViewMode === 'list';

      if (useListView) {
        // List view - each column vertically
        this.lastResultSchema.forEach((col: any, idx: number) => {
          output += `{#F38020-fg}Column ${idx + 1}:{/}\n`;
          Object.keys(col).forEach(key => {
            const value = col[key];
            let displayValue = '';
            if (typeof value === 'object' && value !== null) {
              displayValue = JSON.stringify(value, null, 2).split('\n').join('\n    ');
            } else {
              displayValue = String(value);
            }
            output += `  {gray-fg}${key}:{/} ${displayValue}\n`;
          });
          output += '\n';
        });
      } else {
        // Table view - horizontal
        const keys = this.lastResultSchema.length > 0 ? Object.keys(this.lastResultSchema[0]) : [];
        const columnWidth = Math.floor((this.resultsTable.width as number - 4) / keys.length);

        // Header
        output += '{#F38020-fg}{bold}';
        keys.forEach(key => {
          output += key.padEnd(columnWidth).substring(0, columnWidth);
        });
        output += '{/}\n';
        output += '─'.repeat((this.resultsTable.width as number - 2)) + '\n';

        // Rows
        this.lastResultSchema.forEach((col: any) => {
          keys.forEach(key => {
            const value = col[key];
            let displayValue = '';
            if (typeof value === 'object' && value !== null) {
              displayValue = JSON.stringify(value);
            } else {
              displayValue = String(value);
            }
            if (displayValue.length > columnWidth - 1) {
              displayValue = displayValue.substring(0, columnWidth - 4) + '...';
            }
            output += displayValue.padEnd(columnWidth);
          });
          output += '\n';
        });
      }
    } else {
      output += JSON.stringify(this.lastResultSchema, null, 2);
    }

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {gray-fg}[schema] ${viewLabel}{/}`);
  }

  private displayHeaders() {
    if (!this.lastResponseHeaders) {
      this.resultsTable.setContent('{yellow-fg}No response headers available{/}');
      this.resultsTable.setLabel(' Results <3> {gray-fg}[headers]{/}');
      return;
    }

    let output = '{#F38020-fg}{bold}Response Headers:{/}\n\n';

    const useListView = this.resultsViewMode === 'list';
    const headers = Object.entries(this.lastResponseHeaders);

    if (useListView) {
      // List view - each header on its own line
      headers.forEach(([key, value]) => {
        output += `{#F38020-fg}${key}:{/} ${value}\n`;
      });
    } else {
      // Table view - two columns: header name and value
      const columnWidth = Math.floor((this.resultsTable.width as number - 4) / 2);

      // Header
      output += '{#F38020-fg}{bold}';
      output += 'Header'.padEnd(columnWidth).substring(0, columnWidth);
      output += 'Value'.padEnd(columnWidth).substring(0, columnWidth);
      output += '{/}\n';
      output += '─'.repeat((this.resultsTable.width as number - 2)) + '\n';

      // Rows
      headers.forEach(([key, value]) => {
        let displayKey = key;
        let displayValue = String(value);

        if (displayKey.length > columnWidth - 1) {
          displayKey = displayKey.substring(0, columnWidth - 4) + '...';
        }
        if (displayValue.length > columnWidth - 1) {
          displayValue = displayValue.substring(0, columnWidth - 4) + '...';
        }

        output += displayKey.padEnd(columnWidth);
        output += displayValue.padEnd(columnWidth);
        output += '\n';
      });
    }

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {gray-fg}[headers] ${viewLabel}{/}`);
  }

  private displayTableMetadata() {
    if (!this.lastTableMetadata || !this.lastTableMetadata.fullMetadata) {
      this.resultsTable.setContent('{yellow-fg}No table metadata available{/}\n\n{#CCCCCC-fg}Select a table from the sidebar to view its metadata{/}');
      this.resultsTable.setLabel(' Results <3> {gray-fg}[metadata]{/}');
      return;
    }

    let output = '{#F38020-fg}{bold}Iceberg Table Metadata:{/}\n\n';

    // Format the full metadata as pretty JSON with syntax highlighting
    const formattedMetadata = this.formatJsonWithHighlighting(this.lastTableMetadata.fullMetadata, 0);
    output += formattedMetadata;

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {gray-fg}[metadata] ${viewLabel}{/}`);
  }

  private formatJsonWithHighlighting(obj: any, indent: number): string {
    const indentStr = '  '.repeat(indent);
    let output = '';

    if (obj === null) {
      return '{gray-fg}null{/}';
    }

    if (typeof obj === 'string') {
      return `{green-fg}"${obj}"{/}`;
    }

    if (typeof obj === 'number') {
      return `{yellow-fg}${obj}{/}`;
    }

    if (typeof obj === 'boolean') {
      return obj ? '{cyan-fg}true{/}' : '{cyan-fg}false{/}';
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        return '[]';
      }
      output += '[\n';
      obj.forEach((item, index) => {
        output += indentStr + '  ' + this.formatJsonWithHighlighting(item, indent + 1);
        if (index < obj.length - 1) output += ',';
        output += '\n';
      });
      output += indentStr + ']';
      return output;
    }

    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        return '{}';
      }
      output += '{\n';
      keys.forEach((key, index) => {
        output += indentStr + '  {magenta-fg}"' + key + '"{/}: ';
        output += this.formatJsonWithHighlighting(obj[key], indent + 1);
        if (index < keys.length - 1) output += ',';
        output += '\n';
      });
      output += indentStr + '}';
      return output;
    }

    return String(obj);
  }

  private async copyToClipboard(format: 'json' | 'markdown') {
    try {
      let content = '';

      if (this.resultsDisplayMode === 'schema') {
        content = JSON.stringify(this.lastResultSchema, null, 2);
      } else if (this.resultsDisplayMode === 'headers') {
        content = JSON.stringify(this.lastResponseHeaders, null, 2);
      } else if (this.resultsDisplayMode === 'metadata') {
        content = JSON.stringify(this.lastTableMetadata?.fullMetadata || this.lastTableMetadata, null, 2);
      } else if (this.lastResultData.length > 0) {
        if (format === 'json') {
          content = JSON.stringify(this.lastResultData, null, 2);
        } else if (format === 'markdown') {
          // Generate markdown table
          const columns = Object.keys(this.lastResultData[0]);

          // Header
          content = '| ' + columns.join(' | ') + ' |\n';
          content += '| ' + columns.map(() => '---').join(' | ') + ' |\n';

          // Rows
          this.lastResultData.forEach(row => {
            const values = columns.map(col => {
              const val = row[col];
              if (val === null) return 'NULL';
              return String(val).replace(/\|/g, '\\|');
            });
            content += '| ' + values.join(' | ') + ' |\n';
          });
        }
      }

      if (!content) {
        this.showError('No data to copy');
        return;
      }

      // Use platform-specific clipboard command
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let command: string;
      if (process.platform === 'darwin') {
        command = 'pbcopy';
      } else if (process.platform === 'win32') {
        command = 'clip';
      } else {
        // Linux - try xclip first, fallback to xsel
        try {
          await execAsync('which xclip');
          command = 'xclip -selection clipboard';
        } catch {
          command = 'xsel --clipboard --input';
        }
      }

      const child = exec(command);
      child.stdin?.write(content);
      child.stdin?.end();

      await new Promise((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0) resolve(null);
          else reject(new Error(`Copy command exited with code ${code}`));
        });
      });

      // Show success message
      const formatLabel = format === 'json' ? 'JSON' : 'Markdown';
      this.resultsTable.setLabel(` Results <3> {green-fg}(Copied as ${formatLabel}!){/}`);
      setTimeout(() => {
        const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
        const modeLabel = this.resultsDisplayMode === 'data' ? '[data]' :
                          this.resultsDisplayMode === 'schema' ? '[schema]' :
                          this.resultsDisplayMode === 'headers' ? '[headers]' : '[metadata]';
        this.resultsTable.setLabel(` Results <3> {white-fg}(${this.lastResultData.length} rows){/} {gray-fg}${viewLabel} ${modeLabel}{/}`);
        this.screen.render();
      }, 2000);

      this.screen.render();
    } catch (error) {
      this.showError('Failed to copy to clipboard: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private formatQuery() {
    try {
      const query = this.queryEditor.getValue();
      const formatted = format(query, {
        language: 'sql',
        keywordCase: 'upper',
        indentStyle: 'standard',
      });
      this.queryEditor.setValue(formatted);
      this.screen.render();
    } catch (error) {
      this.showError('Failed to format query: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private clearQuery() {
    this.queryEditor.clearValue();
    this.queryEditor.setValue('');
    this.screen.render();
  }

  private updateHistory() {
    const items = this.queryHistory.map((query, i) => {
      const preview = query.length > 80 ? query.substring(0, 77) + '...' : query;
      // Apply syntax highlighting to the preview
      const highlighted = this.highlightSQL(preview);
      return `${i + 1}. ${highlighted}`;
    });
    this.historyList.setItems(items);

    this.historyList.on('select', (item: any) => {
      const index = this.historyList.selected;
      const query = this.queryHistory[index];
      if (query) {
        this.queryEditor.setValue(query);
        this.switchTab('query');
      }
    });
  }

  private highlightSQL(sql: string): string {
    // SQL keywords to highlight
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'LIMIT', 'OFFSET',
      'AND', 'OR', 'NOT', 'IS', 'NULL', 'LIKE', 'IN',
      'ASC', 'DESC', 'AS', 'ON', 'DISTINCT',
    ];

    let highlighted = sql;

    // Highlight keywords (case insensitive)
    keywords.forEach(keyword => {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      highlighted = highlighted.replace(regex, (match) => {
        return `{cyan-fg}${match}{/}`;
      });
    });

    // Highlight strings (single quotes)
    highlighted = highlighted.replace(/'([^']*)'/g, (match) => {
      return `{green-fg}${match}{/}`;
    });

    // Highlight numbers
    highlighted = highlighted.replace(/\b(\d+)\b/g, (match) => {
      return `{yellow-fg}${match}{/}`;
    });

    // Highlight * (wildcard)
    highlighted = highlighted.replace(/\*/g, '{magenta-fg}*{/}');

    return highlighted;
  }

  private showHelp() {
    // Build help as a simple table with fixed-width columns using dots as spacers
    const pad = (key: string, desc: string) => {
      const keyPart = '  ' + key;
      const dots = '.'.repeat(Math.max(25 - keyPart.length, 3));
      return keyPart + ' ' + dots + ' ' + desc;
    };

    const lines = [
      '{center}{bold}{#F38020-fg}R2 SQL Shell - Keyboard Shortcuts' + (this.isMac ? ' (Mac)' : '') + '{/}{/}',
      '',
      '{yellow-fg}Navigation:{/}',
      pad('{bold}h, ←{/}', 'Focus sidebar'),
      pad('{bold}l, →, Enter{/}', 'Expand namespace / Select table'),
      pad('{bold}j, ↓{/}', 'Move down'),
      pad('{bold}k, ↑{/}', 'Move up'),
      pad('{bold}g{/}', 'Jump to top'),
      pad('{bold}G{/}', 'Jump to bottom'),
      '',
      '{yellow-fg}Modes:{/}',
      pad('{bold}i{/}', 'Enter insert mode (query editor)'),
      pad('{bold}Esc{/}', 'Exit focus, switch to navigation mode'),
      '',
      '{yellow-fg}Editing:{/}',
      pad('{bold}' + (this.isMac ? 'Cmd+V' : 'Ctrl+V') + '{/}', 'Paste (works in insert mode)'),
      pad('{bold}' + (this.isMac ? 'Cmd+C' : 'Ctrl+C') + '{/}', 'Copy (after ' + (this.isMac ? 'Fn' : 'Shift') + '+Mouse)'),
      '',
      '{yellow-fg}Tabs:{/}',
      pad('{bold}1{/}', 'Focus sidebar'),
      pad('{bold}2{/}', 'Query editor'),
      pad('{bold}3{/}', 'Focus results'),
      pad('{bold}4{/}', 'Query history'),
      '',
      '{yellow-fg}Query:{/}',
      pad('{bold}' + (this.isMac ? 'F5 or x' : 'Ctrl+E/F5/x') + '{/}', 'Execute (x in navigation mode)'),
      pad('{bold}' + (this.isMac ? 'Shift+F5' : 'Ctrl+F') + '{/}', 'Format query'),
      pad('{bold}Ctrl+L{/}', 'Clear query'),
      '',
      '{yellow-fg}Results View:{/}',
      pad('{bold}t{/}', 'Toggle table/list view'),
      pad('{bold}v{/}', 'Cycle: data → schema → headers → metadata'),
      pad('{bold}/{/}', 'Search names & values (col:val for exact)'),
      pad('{bold}n / N{/}', 'Next/previous match'),
      pad('{bold}Esc{/}', 'Clear search'),
      '',
      '{yellow-fg}Copy:{/}',
      pad('{bold}c{/}', 'Copy as JSON'),
      pad('{bold}m{/}', 'Copy as Markdown'),
      '',
      '{yellow-fg}Other:{/}',
      pad('{bold}r, R{/}', 'Refresh namespaces'),
      pad('{bold}?{/}', 'Show this help'),
      pad('{bold}q, Ctrl+c{/}', 'Quit (navigation mode)'),
      '',
      '{center}{#CCCCCC-fg}Press any key to close{/}{/}',
    ];

    const helpText = lines.join('\n');

    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '80%',
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: '#F38020' },
      },
      content: helpText,
      tags: true,
      padding: 1,
      keys: true,
      input: true,
    });

    const self = this;
    const closeHelp = () => {
      helpBox.destroy();
      self.screen.render();
    };

    // Catch any keypress on the help box
    helpBox.on('keypress', closeHelp);

    helpBox.focus();
    this.screen.render();
  }

  private showError(message: string | Error) {
    try {
      const errorText = message instanceof Error ? message.message : String(message || 'Unknown error');
      const safeErrorText = String(errorText).replace(/[\x00-\x1F\x7F-\x9F]/g, ''); // Remove control characters
      this.resultsTable.setContent(`{red-fg}Error:{/} ${safeErrorText}`);
      this.resultsTable.setLabel(' Results <3> {red-fg}(error){/}');
      this.screen.render();
    } catch (err) {
      // Fallback if even this fails
      try {
        this.resultsTable.setContent('Error displaying error message');
        this.screen.render();
      } catch {
        // Silent fail
      }
    }
  }

  private async showTableSchema(namespace: string, tableName: string) {
    try {
      this.resultsTable.setLabel(' Results <3> {yellow-fg}(loading schema...){/}');
      this.resultsTable.setContent('{yellow-fg}Loading table schema...{/}');
      this.screen.render();

      const metadata = await this.catalogClient.getTableMetadata(namespace, tableName);

      // Store the full metadata for the metadata view
      this.lastTableMetadata = metadata;

      if (!metadata || !metadata.schema) {
        this.resultsTable.setContent('{yellow-fg}No schema information available{/}');
        this.resultsTable.setLabel(' Results <3> ');
        this.screen.render();
        return;
      }

      let output = '';
      output += `{#F38020-fg}Table: ${namespace}.${tableName}{/}\n\n`;
      output += `{#F38020-fg}Column Name{/}                    {yellow-fg}Type{/}                           {red-fg}Nullable{/}\n`;
      output += '─'.repeat(100) + '\n';

      for (const field of metadata.schema.fields) {
        const typeStr = typeof field.type === 'string' ? field.type : JSON.stringify(field.type);
        const name = field.name.padEnd(30).substring(0, 30);
        const type = typeStr.padEnd(35).substring(0, 35);
        const nullable = field.required ? '{red-fg}NOT NULL{/}' : '{gray-fg}NULL{/}';
        output += `${name} ${type} ${nullable}\n`;
      }

      output += '\n{#CCCCCC-fg}Press F5 or x (in navigation mode) to execute query{/}';

      this.resultsTable.setContent(output);
      this.resultsTable.setLabel(` Results <3> {white-fg}(schema: ${metadata.schema.fields.length} columns){/}`);
      this.screen.render();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.showError('Failed to load table schema: ' + errorMsg);
    }
  }

  private showAutocomplete() {
    const query = this.queryEditor.getValue();
    const cursorPos = query.length; // Simplified: assume cursor at end

    // Get the word being typed
    const beforeCursor = query.substring(0, cursorPos).trim();
    const words = beforeCursor.split(/\s+/);
    const currentWord = words[words.length - 1] || '';
    const queryUpper = query.toUpperCase();

    // Build suggestions list
    const suggestions: string[] = [];

    // Check if user is typing after a namespace (e.g., "namespace.")
    if (currentWord.includes('.')) {
      const parts = currentWord.split('.');
      const namespacePart = parts[0];
      const tablePart = parts[1] || '';

      // Find matching namespace
      for (const [namespace, tables] of this.namespaces.entries()) {
        if (namespace.toLowerCase() === namespacePart.toLowerCase()) {
          // Suggest tables from this namespace
          tables.forEach(table => {
            if (table.toLowerCase().startsWith(tablePart.toLowerCase())) {
              suggestions.push(`${namespace}.${table}`);
            }
          });
          break;
        }
      }
    } else {
      // Context-aware suggestions
      const hasSelect = queryUpper.includes('SELECT');
      const hasFrom = queryUpper.includes('FROM');
      const lastKeyword = this.getLastKeyword(beforeCursor);

      if (lastKeyword === 'SELECT' && !hasFrom) {
        // After SELECT, suggest * or table names
        if ('*'.startsWith(currentWord) || currentWord === '') {
          suggestions.push('*');
        }
        // Also suggest FROM keyword
        if ('FROM'.startsWith(currentWord.toUpperCase()) || currentWord === '') {
          suggestions.push('FROM');
        }
      } else if (lastKeyword === 'FROM' || (hasSelect && hasFrom)) {
        // After FROM, suggest namespace.table combinations
        for (const [namespace, tables] of this.namespaces.entries()) {
          tables.forEach(table => {
            const fullName = `${namespace}.${table}`;
            if (fullName.toLowerCase().startsWith(currentWord.toLowerCase()) || currentWord.length === 0) {
              suggestions.push(fullName);
            }
          });
          // Also suggest just namespace to let user type the dot
          if (namespace.toLowerCase().startsWith(currentWord.toLowerCase())) {
            suggestions.push(namespace);
          }
        }
      } else if (lastKeyword === 'WHERE') {
        // After WHERE, suggest column names (we don't have schema easily, so just suggest operators)
        ['AND', 'OR', 'NOT', 'LIKE', 'IS NULL', 'IS NOT NULL'].forEach(op => {
          if (op.startsWith(currentWord.toUpperCase()) || currentWord === '') {
            suggestions.push(op);
          }
        });
      } else if (lastKeyword === 'ORDER BY') {
        // After ORDER BY, suggest ASC/DESC
        ['ASC', 'DESC'].forEach(dir => {
          if (dir.startsWith(currentWord.toUpperCase()) || currentWord === '') {
            suggestions.push(dir);
          }
        });
      } else {
        // General case: suggest SQL keywords
        this.sqlKeywords.forEach(keyword => {
          if (keyword.toLowerCase().startsWith(currentWord.toLowerCase()) || currentWord === '') {
            suggestions.push(keyword);
          }
        });

        // Also suggest namespaces and tables if there's some text
        if (currentWord.length > 0) {
          for (const [namespace, tables] of this.namespaces.entries()) {
            if (namespace.toLowerCase().startsWith(currentWord.toLowerCase())) {
              suggestions.push(namespace);
            }
            tables.forEach(table => {
              const fullName = `${namespace}.${table}`;
              if (fullName.toLowerCase().startsWith(currentWord.toLowerCase())) {
                suggestions.push(fullName);
              }
            });
          }
        }
      }
    }

    // Remove duplicates
    const uniqueSuggestions = Array.from(new Set(suggestions));

    if (uniqueSuggestions.length === 0) {
      return; // Nothing to suggest
    }

    // Show autocomplete box
    this.autocompleteBox.clearItems();
    this.autocompleteBox.setItems(uniqueSuggestions.slice(0, 15)); // Limit to 15 items
    this.autocompleteBox.select(0);
    this.autocompleteBox.show();
    this.autocompleteBox.focus();
    this.autocompleteVisible = true;
    this.screen.render();
  }

  private showAutocompleteAuto() {
    const query = this.queryEditor.getValue();
    const cursorPos = query.length; // Simplified: assume cursor at end

    // Get the word being typed
    const beforeCursor = query.substring(0, cursorPos).trim();
    const words = beforeCursor.split(/\s+/);
    const currentWord = words[words.length - 1] || '';
    const queryUpper = query.toUpperCase();

    // Don't show autocomplete if query is completely empty
    if (query.trim().length === 0) {
      this.hideAutocomplete();
      return;
    }

    // Build suggestions list (same logic as showAutocomplete)
    const suggestions: string[] = [];

    // Check if user is typing after a namespace (e.g., "namespace.")
    if (currentWord.includes('.')) {
      const parts = currentWord.split('.');
      const namespacePart = parts[0];
      const tablePart = parts[1] || '';

      // Find matching namespace
      for (const [namespace, tables] of this.namespaces.entries()) {
        if (namespace.toLowerCase() === namespacePart.toLowerCase()) {
          // Suggest tables from this namespace
          tables.forEach(table => {
            if (table.toLowerCase().startsWith(tablePart.toLowerCase())) {
              suggestions.push(`${namespace}.${table}`);
            }
          });
          break;
        }
      }
    } else {
      // Context-aware suggestions
      const hasSelect = queryUpper.includes('SELECT');
      const hasFrom = queryUpper.includes('FROM');
      const lastKeyword = this.getLastKeyword(beforeCursor);

      if (lastKeyword === 'SELECT' && !hasFrom) {
        // After SELECT, suggest * or table names
        if ('*'.startsWith(currentWord) || currentWord === '') {
          suggestions.push('*');
        }
        // Also suggest FROM keyword
        if ('FROM'.startsWith(currentWord.toUpperCase()) || currentWord === '') {
          suggestions.push('FROM');
        }
      } else if (lastKeyword === 'FROM' || (hasSelect && hasFrom)) {
        // After FROM, suggest namespace.table combinations
        for (const [namespace, tables] of this.namespaces.entries()) {
          tables.forEach(table => {
            const fullName = `${namespace}.${table}`;
            if (fullName.toLowerCase().startsWith(currentWord.toLowerCase()) || currentWord.length === 0) {
              suggestions.push(fullName);
            }
          });
          // Also suggest just namespace to let user type the dot
          if (namespace.toLowerCase().startsWith(currentWord.toLowerCase())) {
            suggestions.push(namespace);
          }
        }
      } else if (lastKeyword === 'WHERE') {
        // After WHERE, suggest column names (we don't have schema easily, so just suggest operators)
        ['AND', 'OR', 'NOT', 'LIKE', 'IS NULL', 'IS NOT NULL'].forEach(op => {
          if (op.startsWith(currentWord.toUpperCase()) || currentWord === '') {
            suggestions.push(op);
          }
        });
      } else if (lastKeyword === 'ORDER BY') {
        // After ORDER BY, suggest ASC/DESC
        ['ASC', 'DESC'].forEach(dir => {
          if (dir.startsWith(currentWord.toUpperCase()) || currentWord === '') {
            suggestions.push(dir);
          }
        });
      } else {
        // General case: suggest SQL keywords
        this.sqlKeywords.forEach(keyword => {
          if (keyword.toLowerCase().startsWith(currentWord.toLowerCase()) || currentWord === '') {
            suggestions.push(keyword);
          }
        });

        // Also suggest namespaces and tables if there's some text
        if (currentWord.length > 0) {
          for (const [namespace, tables] of this.namespaces.entries()) {
            if (namespace.toLowerCase().startsWith(currentWord.toLowerCase())) {
              suggestions.push(namespace);
            }
            tables.forEach(table => {
              const fullName = `${namespace}.${table}`;
              if (fullName.toLowerCase().startsWith(currentWord.toLowerCase())) {
                suggestions.push(fullName);
              }
            });
          }
        }
      }
    }

    // Remove duplicates
    const uniqueSuggestions = Array.from(new Set(suggestions));

    if (uniqueSuggestions.length === 0) {
      this.hideAutocomplete();
      return; // Nothing to suggest
    }

    // Show autocomplete box WITHOUT stealing focus
    this.autocompleteBox.clearItems();
    this.autocompleteBox.setItems(uniqueSuggestions.slice(0, 15)); // Limit to 15 items
    this.autocompleteBox.select(0);
    this.autocompleteBox.show();
    this.autocompleteVisible = true;
    // DON'T focus the autocomplete box - keep focus on query editor
    this.screen.render();
  }

  private getLastKeyword(text: string): string {
    const upperText = text.toUpperCase();
    const keywords = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'LIMIT'];

    let lastKeyword = '';
    let lastPos = -1;

    for (const keyword of keywords) {
      const pos = upperText.lastIndexOf(keyword);
      if (pos > lastPos) {
        lastPos = pos;
        lastKeyword = keyword;
      }
    }

    return lastKeyword;
  }

  private hideAutocomplete() {
    this.autocompleteBox.hide();
    this.autocompleteVisible = false;
    this.queryEditor.focus();
    this.screen.render();
  }

  private insertAutocomplete(text: string) {
    // Get the current query WITHOUT trimming to preserve formatting
    const query = this.queryEditor.getValue();
    const queryUpper = query.toUpperCase();

    // Find the last word to replace (only look at non-whitespace before cursor)
    let lastWordStart = query.length;
    for (let i = query.length - 1; i >= 0; i--) {
      if (/\s/.test(query[i])) {
        lastWordStart = i + 1;
        break;
      }
      if (i === 0) {
        lastWordStart = 0;
      }
    }

    // Replace the last word with the selected suggestion
    const beforeLastWord = query.substring(0, lastWordStart);
    let newQuery = beforeLastWord + text;

    // Smart completion: if user selected a table after FROM and there's no SELECT columns yet
    const hasFrom = queryUpper.includes('FROM');
    const hasSelect = queryUpper.includes('SELECT');
    const isTableName = text.includes('.'); // namespace.table format

    if (hasFrom && hasSelect && isTableName) {
      // Check if SELECT clause has no columns (just "SELECT" or "SELECT FROM")
      const selectMatch = query.match(/SELECT\s+(.*?)\s+FROM/i);
      if (selectMatch) {
        const selectClause = selectMatch[1].trim();
        if (selectClause === '' || selectClause === 'FROM') {
          // Insert * after SELECT
          newQuery = newQuery.replace(/SELECT\s+FROM/i, `SELECT * FROM`);
        }
      }
    } else if (!hasSelect && isTableName) {
      // If user just typed a table name without SELECT, prepend SELECT * FROM
      newQuery = `SELECT * FROM ${text}`;
    }

    this.queryEditor.clearValue();
    this.queryEditor.setValue(newQuery + ' ');
    this.hideAutocomplete();
  }

  private acceptAutocomplete(text: string) {
    // Clear any pending autocomplete timeouts
    if (this.autocompleteTimeout) {
      clearTimeout(this.autocompleteTimeout);
      this.autocompleteTimeout = null;
    }

    // Hide autocomplete first to prevent interference
    this.autocompleteBox.hide();
    this.autocompleteVisible = false;

    // Get the current query WITHOUT trimming to preserve formatting
    const query = this.queryEditor.getValue();
    const queryUpper = query.toUpperCase();

    // Find the last word to replace (only look at non-whitespace before cursor)
    // We need to find the last "word" which is text after the last whitespace
    let lastWordStart = query.length;
    for (let i = query.length - 1; i >= 0; i--) {
      if (/\s/.test(query[i])) {
        lastWordStart = i + 1;
        break;
      }
      if (i === 0) {
        lastWordStart = 0;
      }
    }

    // Replace the last word with the selected suggestion
    const beforeLastWord = query.substring(0, lastWordStart);
    let newQuery = beforeLastWord + text;

    // Smart completion: if user selected a table after FROM and there's no SELECT columns yet
    const hasFrom = queryUpper.includes('FROM');
    const hasSelect = queryUpper.includes('SELECT');
    const isTableName = text.includes('.'); // namespace.table format

    if (hasFrom && hasSelect && isTableName) {
      // Check if SELECT clause has no columns (just "SELECT" or "SELECT FROM")
      const selectMatch = query.match(/SELECT\s+(.*?)\s+FROM/i);
      if (selectMatch) {
        const selectClause = selectMatch[1].trim();
        if (selectClause === '' || selectClause === 'FROM') {
          // Insert * after SELECT
          newQuery = newQuery.replace(/SELECT\s+FROM/i, `SELECT * FROM`);
        }
      }
    } else if (!hasSelect && isTableName) {
      // If user just typed a table name without SELECT, prepend SELECT * FROM
      newQuery = `SELECT * FROM ${text}`;
    }

    // Update the query editor
    this.queryEditor.clearValue();
    this.queryEditor.setValue(newQuery + ' ');

    // Keep focus on query editor so user can continue typing
    this.queryEditor.focus();

    // Render the screen to ensure everything is updated
    this.screen.render();
  }

  private getItemText(item: any): string {
    if (typeof item === 'string') return item;
    if (item && typeof item.getText === 'function') {
      try {
        const text = item.getText();
        return typeof text === 'string' ? text : String(text || '');
      } catch {
        return '';
      }
    }
    if (item && item.content) return String(item.content);
    return '';
  }

  private async showLoadingScreen() {
    const loadingBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: '50%',
      tags: true,
      align: 'center',
      valign: 'middle',
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    const colors = ['red', 'yellow', '#F38020', 'green', 'cyan', 'blue', 'magenta'];

    const updateLoading = (message: string) => {
      // Create big ASCII art for R2 SQL
      const r2sqlArt = [
        '██████╗ ██████╗     ███████╗ ██████╗ ██╗     ',
        '██╔══██╗╚════██╗    ██╔════╝██╔═══██╗██║     ',
        '██████╔╝ █████╔╝    ███████╗██║   ██║██║     ',
        '██╔══██╗██╔═══╝     ╚════██║██║▄▄ ██║██║     ',
        '██║  ██║███████╗    ███████║╚██████╔╝███████╗',
        '╚═╝  ╚═╝╚══════╝    ╚══════╝ ╚══▀▀═╝ ╚══════╝'
      ];

      // Color each line with rainbow
      let coloredArt = '';
      r2sqlArt.forEach((line, idx) => {
        const color = colors[idx % colors.length];
        coloredArt += `{${color}-fg}${line}{/}\n`;
      });

      // Create "Powered by Cloudflare" text with orange
      const poweredBy = '{gray-fg}Powered by{/} {#F38020-fg}Cloudflare{/}';

      const content = `\n${coloredArt}\n          ${poweredBy}\n\n            {gray-fg}${message}{/}`;

      loadingBox.setContent(content);
      this.screen.render();
    };

    updateLoading('Loading...');

    // Load all namespaces and tables
    try {
      await this.loadNamespacesAndTables();
    } catch (error) {
      // Continue even if loading fails
    }

    // Remove loading screen
    loadingBox.destroy();
    this.screen.render();

    // Execute query on start if provided
    if (this.executeOnStart) {
      this.queryEditor.clearValue();
      this.queryEditor.setValue(this.executeOnStart);
      this.screen.render();
      await this.executeQuery();
    }
  }

  private async loadNamespacesAndTables() {
    try {
      this.sidebar.setLabel(' Schemas {yellow-fg}(loading...){/}');

      const namespaces = await this.catalogClient.listNamespaces();
      this.namespaces.clear();

      // Load all tables for all namespaces in parallel
      const tablePromises = namespaces.map(async (ns) => {
        try {
          const tables = await this.catalogClient.listTables(ns);
          return { namespace: ns, tables };
        } catch {
          return { namespace: ns, tables: [] };
        }
      });

      const results = await Promise.all(tablePromises);

      const items: string[] = [];
      for (const { namespace, tables } of results) {
        items.push(`{#F38020-fg}▸{/} ${String(namespace)}`);
        this.namespaces.set(namespace, tables);
      }

      this.sidebar.clearItems();
      this.sidebar.setItems(items);
      this.sidebar.setLabel(' Schemas ');
      if (items.length > 0) {
        this.sidebar.select(0);
      }
      this.screen.render();
    } catch (error) {
      this.showError('Failed to load namespaces: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private showSearch() {
    this.searchActive = true;
    this.searchTerm = '';
    this.searchMatches = [];
    this.currentMatchIndex = 0;
    this.searchBox.setLabel(' Search/Filter (searches column names & values) ');
    this.searchBox.clearValue();
    this.searchBox.show();
    this.searchBox.focus();
    this.screen.render();
  }

  private closeSearch() {
    this.searchActive = false;
    this.searchTerm = '';
    this.searchMatches = [];
    this.currentMatchIndex = 0;
    this.searchBox.setLabel(' Search/Filter (searches column names & values) ');
    this.searchBox.clearValue();
    this.searchBox.hide();

    // Restore full results based on current view mode
    if (this.resultsDisplayMode === 'data') {
      this.displayResults(this.lastResultData, this.lastResultMetadata);
    } else if (this.resultsDisplayMode === 'schema') {
      this.displaySchema();
    } else if (this.resultsDisplayMode === 'headers') {
      this.displayHeaders();
    } else if (this.resultsDisplayMode === 'metadata') {
      this.displayTableMetadata();
    }

    this.resultsTable.focus();
    this.screen.render();
  }

  private highlightCurrentMatch() {
    // Re-run filter to update the display with current match highlighted
    this.filterResults();

    // Update the label to show current match
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    if (this.resultsDisplayMode === 'data' && this.searchMatches.length > 0) {
      const matchInfo = ` match ${this.currentMatchIndex + 1}/${this.searchMatches.length}`;
      this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered${matchInfo}){/} {gray-fg}${viewLabel} [data]{/}`);
    }

    this.screen.render();
  }

  private filterResults() {
    // Check if search term is empty or only whitespace
    if (!this.searchTerm || this.searchTerm.trim() === '') {
      // If search is empty, reset to full results for all views
      this.searchMatches = [];
      this.currentMatchIndex = 0;

      // Update search box label to show it's ready
      this.searchBox.setLabel(' Search/Filter (searches column names & values) ');

      // Reset based on current view mode
      if (this.resultsDisplayMode === 'data') {
        this.displayResults(this.lastResultData, this.lastResultMetadata);
      } else if (this.resultsDisplayMode === 'schema') {
        this.displaySchema();
      } else if (this.resultsDisplayMode === 'headers') {
        this.displayHeaders();
      } else if (this.resultsDisplayMode === 'metadata') {
        this.displayTableMetadata();
      }

      this.screen.render();
      return;
    }

    // Update search box label to show active search
    const searchPreview = this.searchTerm.length > 20 ? this.searchTerm.substring(0, 17) + '...' : this.searchTerm;
    this.searchBox.setLabel(` Searching: "${searchPreview}" `);

    const searchLower = this.searchTerm.toLowerCase();

    // Parse for column-level filtering: column_name:value
    let columnFilter: { column: string; value: string } | null = null;
    if (this.searchTerm.includes(':')) {
      const parts = this.searchTerm.split(':');
      if (parts.length === 2) {
        columnFilter = {
          column: parts[0].trim().toLowerCase(),
          value: parts[1].trim().toLowerCase(),
        };
      }
    }

    // Filter based on current display mode
    if (this.resultsDisplayMode === 'data') {
      // Filter data rows
      const matches: number[] = [];
      const filteredData = this.lastResultData.filter((row, index) => {
        let isMatch = false;

        if (columnFilter) {
          // Column-specific search
          const columns = Object.keys(row);
          const matchingColumn = columns.find(col => col.toLowerCase() === columnFilter.column);

          if (matchingColumn) {
            const value = row[matchingColumn];
            if (value !== null && String(value).toLowerCase().includes(columnFilter.value)) {
              isMatch = true;
            }
          }
        } else {
          // Search through all column NAMES and VALUES in the row
          isMatch = Object.entries(row).some(([key, value]) => {
            // Check if column name matches
            if (key.toLowerCase().includes(searchLower)) {
              return true;
            }
            // Check if value matches
            if (value !== null && String(value).toLowerCase().includes(searchLower)) {
              return true;
            }
            return false;
          });
        }

        if (isMatch) {
          matches.push(index);
        }
        return isMatch;
      });

      // Store matches for navigation
      this.searchMatches = matches;
      this.currentMatchIndex = matches.length > 0 ? 0 : -1;

      // Display filtered results - pass original metadata unchanged, set isFiltered flag
      this.displayResults(filteredData, this.lastResultMetadata, true);

      // Update label to show filter is active and match count
      const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
      const matchInfo = matches.length > 0 ? ` match ${this.currentMatchIndex + 1}/${matches.length}` : '';
      this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered: ${filteredData.length}/${this.lastResultData.length} rows${matchInfo}){/} {gray-fg}${viewLabel} [data]{/}`);
    } else if (this.resultsDisplayMode === 'schema') {
      // Filter schema fields by name or type
      if (this.lastResultSchema && Array.isArray(this.lastResultSchema)) {
        const matches: number[] = [];
        const filteredSchema = this.lastResultSchema.filter((col: any, index: number) => {
          const isMatch = Object.entries(col).some(([key, value]) => {
            if (value === null) return false;
            const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
            return key.toLowerCase().includes(searchLower) || valueStr.toLowerCase().includes(searchLower);
          });

          if (isMatch) {
            matches.push(index);
          }
          return isMatch;
        });

        // Store matches for navigation
        this.searchMatches = matches;
        this.currentMatchIndex = matches.length > 0 ? 0 : -1;

        // Display filtered schema
        this.displaySchemaFiltered(filteredSchema);
      } else {
        this.displaySchema();
      }
    } else if (this.resultsDisplayMode === 'headers') {
      // Filter headers by key or value
      if (this.lastResponseHeaders) {
        const matches: number[] = [];
        const entries = Object.entries(this.lastResponseHeaders);
        const filteredHeaders = Object.fromEntries(
          entries.filter(([key, value], index) => {
            const isMatch = key.toLowerCase().includes(searchLower) ||
                           String(value).toLowerCase().includes(searchLower);
            if (isMatch) {
              matches.push(index);
            }
            return isMatch;
          })
        );

        // Store matches for navigation
        this.searchMatches = matches;
        this.currentMatchIndex = matches.length > 0 ? 0 : -1;

        this.displayHeadersFiltered(filteredHeaders);
      } else {
        this.displayHeaders();
      }
    } else if (this.resultsDisplayMode === 'metadata') {
      // Filter metadata by searching through JSON
      if (this.lastTableMetadata?.fullMetadata) {
        const filteredMetadata = this.filterJsonObject(this.lastTableMetadata.fullMetadata, searchLower);

        // For metadata, we don't track individual matches since it's nested JSON
        this.searchMatches = filteredMetadata ? [0] : [];
        this.currentMatchIndex = 0;

        this.displayMetadataFiltered(filteredMetadata);
      } else {
        this.displayTableMetadata();
      }
    }

    this.screen.render();
  }

  private filterJsonObject(obj: any, searchTerm: string): any {
    if (obj === null || obj === undefined) return null;

    if (typeof obj === 'string') {
      return obj.toLowerCase().includes(searchTerm) ? obj : null;
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return String(obj).toLowerCase().includes(searchTerm) ? obj : null;
    }

    if (Array.isArray(obj)) {
      const filtered = obj.map(item => this.filterJsonObject(item, searchTerm)).filter(item => item !== null);
      return filtered.length > 0 ? filtered : null;
    }

    if (typeof obj === 'object') {
      const filtered: any = {};
      let hasMatch = false;

      for (const [key, value] of Object.entries(obj)) {
        // Check if key matches
        if (key.toLowerCase().includes(searchTerm)) {
          filtered[key] = value;
          hasMatch = true;
        } else {
          // Check if value matches
          const filteredValue = this.filterJsonObject(value, searchTerm);
          if (filteredValue !== null) {
            filtered[key] = filteredValue;
            hasMatch = true;
          }
        }
      }

      return hasMatch ? filtered : null;
    }

    return null;
  }

  private displaySchemaFiltered(filteredSchema: any[]) {
    const total = this.lastResultSchema?.length || 0;
    const filtered = filteredSchema.length;

    let output = '{#F38020-fg}{bold}Query Schema (filtered):{/}\n\n';

    if (filteredSchema.length === 0) {
      output += '{yellow-fg}No matching schema fields{/}';
      this.resultsTable.setContent(output);
      this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered: 0/${total} fields){/} {gray-fg}[schema]{/}`);
      return;
    }

    const useListView = this.resultsViewMode === 'list';

    if (useListView) {
      filteredSchema.forEach((col: any, idx: number) => {
        output += `{#F38020-fg}Column ${idx + 1}:{/}\n`;
        Object.keys(col).forEach(key => {
          const value = col[key];
          let displayValue = '';
          if (typeof value === 'object' && value !== null) {
            displayValue = JSON.stringify(value, null, 2).split('\n').join('\n    ');
          } else {
            displayValue = String(value);
          }
          output += `  {gray-fg}${key}:{/} ${displayValue}\n`;
        });
        output += '\n';
      });
    } else {
      const keys = filteredSchema.length > 0 ? Object.keys(filteredSchema[0]) : [];
      const columnWidth = Math.floor((this.resultsTable.width as number - 4) / keys.length);

      output += '{#F38020-fg}{bold}';
      keys.forEach(key => {
        output += key.padEnd(columnWidth).substring(0, columnWidth);
      });
      output += '{/}\n';
      output += '─'.repeat((this.resultsTable.width as number - 2)) + '\n';

      filteredSchema.forEach((col: any) => {
        keys.forEach(key => {
          const value = col[key];
          let displayValue = '';
          if (typeof value === 'object' && value !== null) {
            displayValue = JSON.stringify(value);
          } else {
            displayValue = String(value);
          }
          if (displayValue.length > columnWidth - 1) {
            displayValue = displayValue.substring(0, columnWidth - 4) + '...';
          }
          output += displayValue.padEnd(columnWidth);
        });
        output += '\n';
      });
    }

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered: ${filtered}/${total} fields){/} {gray-fg}${viewLabel} [schema]{/}`);
  }

  private displayHeadersFiltered(filteredHeaders: any) {
    const total = this.lastResponseHeaders ? Object.keys(this.lastResponseHeaders).length : 0;
    const filtered = Object.keys(filteredHeaders).length;

    let output = '{#F38020-fg}{bold}Response Headers (filtered):{/}\n\n';

    if (filtered === 0) {
      output += '{yellow-fg}No matching headers{/}';
      this.resultsTable.setContent(output);
      this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered: 0/${total} headers){/} {gray-fg}[headers]{/}`);
      return;
    }

    const useListView = this.resultsViewMode === 'list';
    const headers = Object.entries(filteredHeaders);

    if (useListView) {
      headers.forEach(([key, value]) => {
        output += `{#F38020-fg}${key}:{/} ${value}\n`;
      });
    } else {
      const columnWidth = Math.floor((this.resultsTable.width as number - 4) / 2);

      output += '{#F38020-fg}{bold}';
      output += 'Header'.padEnd(columnWidth).substring(0, columnWidth);
      output += 'Value'.padEnd(columnWidth).substring(0, columnWidth);
      output += '{/}\n';
      output += '─'.repeat((this.resultsTable.width as number - 2)) + '\n';

      headers.forEach(([key, value]) => {
        let displayKey = key;
        let displayValue = String(value);

        if (displayKey.length > columnWidth - 1) {
          displayKey = displayKey.substring(0, columnWidth - 4) + '...';
        }
        if (displayValue.length > columnWidth - 1) {
          displayValue = displayValue.substring(0, columnWidth - 4) + '...';
        }

        output += displayKey.padEnd(columnWidth);
        output += displayValue.padEnd(columnWidth);
        output += '\n';
      });
    }

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered: ${filtered}/${total} headers){/} {gray-fg}${viewLabel} [headers]{/}`);
  }

  private displayMetadataFiltered(filteredMetadata: any) {
    let output = '{#F38020-fg}{bold}Iceberg Table Metadata (filtered):{/}\n\n';

    if (!filteredMetadata || Object.keys(filteredMetadata).length === 0) {
      output += '{yellow-fg}No matching metadata fields{/}';
      this.resultsTable.setContent(output);
      this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered){/} {gray-fg}[metadata]{/}`);
      return;
    }

    const formattedMetadata = this.formatJsonWithHighlighting(filteredMetadata, 0);
    output += formattedMetadata;

    this.resultsTable.setContent(output);
    const viewLabel = this.resultsViewMode === 'table' ? '[table]' : '[list]';
    this.resultsTable.setLabel(` Results <3> {yellow-fg}(filtered){/} {gray-fg}${viewLabel} [metadata]{/}`);
  }

  private formatValueWithColor(value: any): string {
    // Apply type-based color highlighting
    if (value === null || value === undefined) {
      return '{gray-fg}NULL{/}';
    }

    const type = typeof value;

    if (type === 'number') {
      // Numbers in yellow/gold
      return `{yellow-fg}${value}{/}`;
    }

    if (type === 'boolean') {
      // Booleans in green
      return value ? '{green-fg}true{/}' : '{red-fg}false{/}';
    }

    if (type === 'string') {
      // Check if it's a timestamp/date
      if (this.looksLikeTimestamp(value)) {
        return `{cyan-fg}${value}{/}`;
      }
      // Regular strings in white (default)
      // Truncate if too long
      if (value.length > 100) {
        return value.substring(0, 97) + '...';
      }
      return value;
    }

    // Objects/arrays as JSON in magenta
    if (type === 'object') {
      return `{magenta-fg}${JSON.stringify(value)}{/}`;
    }

    return String(value);
  }

  private looksLikeTimestamp(str: string): boolean {
    // Check if string looks like a timestamp or date
    // Common patterns: ISO 8601, RFC 3339, common date formats
    const timestampPatterns = [
      /^\d{4}-\d{2}-\d{2}/, // YYYY-MM-DD
      /^\d{2}\/\d{2}\/\d{4}/, // MM/DD/YYYY or DD/MM/YYYY
      /T\d{2}:\d{2}:\d{2}/, // Time portion (ISO format)
      /^\d{10,13}$/, // Unix timestamp (10-13 digits)
    ];

    return timestampPatterns.some(pattern => pattern.test(str));
  }

  private saveQueryToHistoryFile(query: string) {
    try {
      const historyPath = path.join(process.cwd(), 'r2sql-history.txt');
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] ${query}\n`;
      fs.appendFileSync(historyPath, entry, 'utf-8');
    } catch (error) {
      // Silently fail - don't disrupt the user experience
      console.error('Failed to save query to history file:', error);
    }
  }

  private quit() {
    return process.exit(0);
  }

  async start() {
    this.screen.render();
  }
}
