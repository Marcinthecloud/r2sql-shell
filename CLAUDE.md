# Building with Claude Code

This project was built using [Claude Code](https://claude.com/claude-code), Anthropic's agentic coding tool. This document serves as both guidance for Claude Code when working on this codebase and as a guide for developers who want to build similar applications.

## What is r2 sql shell?

r2 sql shell is an interactive repl users can use as a colorful interactive shell to query tables in R2 Data Catalog using R2 SQL. Currently, R2 SQL can only be accessed via an HTTP REST API or Cloudflare Wrangler so this acts as a convenient way to view, format, and explore their data! 

### Key Features
- colorful, syntax highlighted UI 
- Auto complete 
- Integration with R2 Data Catalog to list namespaces, tables, and schemas 
- some very light automatic charting capabilities (time series, bar charts, etc) rendered in a fun bash-style colorful way
- Errors are nicely formatted with helpful suggestions 
- Store history locally

### Reference for Claude 
- R2 SQL has a limited SQL feature set, see: https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/ 
- R2 SQL itself can't list namespaces or tables yet so a user will need to provide an API token that has R2 Data Catalog edit, R2 object storage edit, and R2 SQL read capabilities 
- It should use Apache Iceberg REST API calls to list namespaces, tables, schemas, etc 
- R2 SQL returns some metadata about the request and it should format tht nicely as well 
- Reference for HTTP API for R2 SQL: https://developers.cloudflare.com/r2-sql/query-data/
- You built an app that does the Iceberg REST API calls for me here https://github.com/Marcinthecloud/iceberg.rest use this as reference - we should be able to construct the Iceberg REST catalog endpoint of R2 Data Catalog as it's always: https://catalog.cloudflarestorage.com/{cloudflaire account ID}/{bucket name} - a user needs to provide the warehouse for querying which is always {cloudflare account id}_{bucket name} 
- So when a user starts the shell, it should look for a .env file with those parameters or a user can specify them when starting the repl/shell including the API key which can be used for all calls
- I really like how this sql repl looks - we should replicate this: https://github.com/achristmascarl/rainfrog 
- here is the R2 SQL reference: https://developers.cloudflare.com/r2-sql/sql-reference/