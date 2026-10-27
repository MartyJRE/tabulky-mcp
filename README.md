# tabulky-mcp

A remote MCP server that lets Claude log food into a [KalorickeTabulky.cz](https://www.kaloricketabulky.cz) diary. It runs on Cloudflare Workers and is added to claude.ai as a custom connector, so it works from the Claude iPhone app.

It uses KT's unofficial web API; see [docs/api.md](docs/api.md).

## Tools

`search_foods`, `get_food_units`, `add_food_entry`, `add_own_food`, `get_diary`, `update_food_entry`, `delete_food_entries`, `get_goals`, `set_goals`.

`set_goals` takes macros only and derives the kcal target from them (4/4/9 kcal per g, rounded to 10), so the two can't drift apart.

## Local dev

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in KT credentials and a random path token
npm run dev
npx @modelcontextprotocol/inspector   # Streamable HTTP → http://localhost:8787/mcp/<MCP_PATH_TOKEN>
```

## Deploy

```sh
npx wrangler login
npx wrangler kv namespace create KT_SESSION   # put the id into wrangler.jsonc
npx wrangler secret put KT_EMAIL
npx wrangler secret put KT_PASSWORD
npx wrangler secret put MCP_PATH_TOKEN        # openssl rand -hex 24
npm run deploy
```

`npx wrangler secret bulk .dev.vars` sets all three secrets at once.

`wrangler.jsonc` points at my KV namespace and custom domain (`tabulky.martinprazak.com`). For your own deploy, replace the KV id, and either set `routes` to a domain on your Cloudflare account or drop `routes` and `workers_dev: false` to use `*.workers.dev`.

Then go to claude.ai → Settings → Connectors → Add custom connector, and use the URL `https://<your-domain>/mcp/<MCP_PATH_TOKEN>`.

The path token is the only protection, so treat the URL like a password.
