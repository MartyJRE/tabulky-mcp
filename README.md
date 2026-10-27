# tabulky-mcp

A remote MCP server that lets Claude log food into a [KalorickeTabulky.cz](https://www.kaloricketabulky.cz) diary. It runs on Cloudflare Workers and is added to claude.ai as a custom connector, so it works from the Claude iPhone app.

It uses KT's unofficial web API; see [docs/api.md](docs/api.md).

## Tools

`search_foods`, `get_food_units`, `add_food_entry`, `add_own_food`, `get_diary`, `update_food_entry`, `delete_food_entries`, `get_goals`, `set_goals`, `get_progress`.

Set `ENABLE_RECORD_WEIGHT=true` (in `.dev.vars` or as a Worker var) to also expose `record_weight`. It's off by default for setups where a scale or health integration already writes the weight.

Set `LUNCH_SPOTS` (a secret, so where you work stays out of the repo) to a JSON list of your usual lunch places to enable `get_lunch_menus`:

```json
[
  { "name": "FastGood Rustonka", "area": "Invalidovna", "source": { "type": "menicka", "url": "https://www.menicka.cz/7099-fastgood-rustonka.html" } },
  { "name": "Bean House", "source": { "type": "choiceqr", "host": "bhouse.choiceqr.com", "section": "oběd" } },
  { "name": "Jídlovice", "source": { "type": "jidlovice", "branchId": 2 } },
  { "name": "Gemüse Corner Kebab", "source": { "type": "wolt", "slug": "gemuse-corner-kebab-karlin" } }
]
```

Source types: `menicka` (menicka.cz page), `choiceqr` (sections active today whose name matches `section`), `jidlovice` (branch ID from `/api/v1/branch/`) and `wolt` (venue slug from its wolt.com URL; fixed menu, drinks excluded).

`set_goals` takes macros only and derives the kcal target from them (4/4/9 kcal per g, rounded to 10), so the two can't drift apart.

## Nutrition coach

[`coach/nutrition-coach/SKILL.md`](coach/nutrition-coach/SKILL.md) turns Claude into a coach that logs meals, reviews progress and readjusts goals using these tools. Use it in one of two ways:

- **Project:** create a project on claude.ai and paste the file's body (everything below the frontmatter) into its instructions. Add your personal context below it, such as who set your goals, diet preferences and health constraints.
- **Skill:** zip the `nutrition-coach` folder and upload it in claude.ai under Settings → Capabilities → Skills. It's then available in every chat.

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
