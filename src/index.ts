import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { KtClient } from "./kt/client";
import { getMenus, spotsSchema, type Spot } from "./menus";
import type { Diary, DiaryItem, OwnFood, ProfileForm } from "./kt/types";

export interface Env {
  KT_SESSION: KVNamespace;
  KT_EMAIL: string;
  KT_PASSWORD: string;
  MCP_PATH_TOKEN: string;
  ENABLE_RECORD_WEIGHT?: string;
  LUNCH_SPOTS?: string;
}

// Proxied rather than committed, so the repo doesn't ship KT's logo. Connector UIs pick up the domain's favicon.
const ICON_URL = "https://www.kaloricketabulky.cz/resources/image/favicon/apple-touch-icon.png";
const ICON_PATHS = new Set(["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"]);

// KT diary-time IDs are fixed; users can only rename the meals.
const MEALS = {
  breakfast: "1",
  morning_snack: "2",
  lunch: "3",
  afternoon_snack: "4",
  dinner: "5",
  second_dinner: "6",
} as const;
type Meal = keyof typeof MEALS;
const mealSchema = z
  .enum(Object.keys(MEALS) as [Meal, ...Meal[]])
  .describe("Diary section (Snídaně, Dopolední svačina, Oběd, Odpolední svačina, Večeře, Druhá večeře)");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("YYYY-MM-DD, defaults to today in Europe/Prague");
const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .optional()
  .describe("HH:MM time of eating, defaults to now");

function ktDate(iso?: string): string {
  const [y, m, d] = (iso ?? pragueToday()).split("-");
  return `${d}.${m}.${y}`;
}

function pragueToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

// Tool-facing nutrient name → KT field. The diary returns everything in grams, but the own-food
// form takes cholesterol and calcium in mg (sodium stays in g), hence the separate `formMg` flag.
const NUTRIENTS = {
  protein: { field: "protein", mg: false, formMg: false },
  carbs: { field: "carbohydrate", mg: false, formMg: false },
  sugar: { field: "sugar", mg: false, formMg: false },
  fat: { field: "fat", mg: false, formMg: false },
  saturated_fat: { field: "saturatedFattyAcid", mg: false, formMg: false },
  trans_fat: { field: "transFattyAcid", mg: false, formMg: false },
  monounsaturated_fat: { field: "monoSaturated", mg: false, formMg: false },
  polyunsaturated_fat: { field: "polySaturated", mg: false, formMg: false },
  fiber: { field: "fiber", mg: false, formMg: false },
  salt: { field: "salt", mg: false, formMg: false },
  alcohol: { field: "alcohol", mg: false, formMg: false },
  cholesterol_mg: { field: "cholesterol", mg: true, formMg: true },
  sodium_mg: { field: "sodium", mg: true, formMg: false },
  calcium_mg: { field: "calcium", mg: true, formMg: true },
} as const;
type Nutrient = keyof typeof NUTRIENTS;

const round = (n: number) => Math.round(n * 100) / 100;

function compactItem(f: DiaryItem) {
  const nutrients: Partial<Record<Nutrient, number>> = {};
  for (const [name, { field, mg }] of Object.entries(NUTRIENTS) as [Nutrient, (typeof NUTRIENTS)[Nutrient]][]) {
    const v = f[field];
    if (v != null) nutrients[name] = round(mg ? v * 1000 : v);
  }
  return { entry_id: f.id, title: f.title, amount: f.unit, kcal: f.energy, ...nutrients, time: f.time };
}

const nutrientInputSchema = Object.fromEntries(
  Object.keys(NUTRIENTS).map((n) => [n, z.number().nonnegative().optional()]),
) as Record<Nutrient, z.ZodOptional<z.ZodNumber>>;

function toKtNutrients(input: Partial<Record<Nutrient, number>>) {
  const out: Record<string, number> = {};
  for (const [name, { field, mg, formMg }] of Object.entries(NUTRIENTS) as [Nutrient, (typeof NUTRIENTS)[Nutrient]][]) {
    const v = input[name];
    if (v != null) out[field] = mg && !formMg ? v / 1000 : v;
  }
  return out;
}

function ownFoodFromDiary(f: DiaryItem): OwnFood {
  const food: OwnFood = { title: f.title, energy: parseCzNumber(f.energy) };
  for (const { field, mg, formMg } of Object.values(NUTRIENTS)) {
    const v = f[field];
    if (v != null) food[field] = mg && formMg ? v * 1000 : v;
  }
  return food;
}

function parseCzNumber(s: string | null): number {
  return s ? Number(s.replace(/\s/g, "").replace(",", ".")) : 0;
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function mealName(id: string): string {
  return Object.entries(MEALS).find(([, mealId]) => mealId === id)?.[0] ?? id;
}

function compactDiary(diary: Diary) {
  return diary.times.map((t) => ({
    meal: mealName(t.id),
    title: t.title,
    kcal_total: t.energyTotal,
    entries: t.foodstuff.map(compactItem),
  }));
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isoFromMs(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date(ms));
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface ServerOptions {
  recordWeight: boolean;
  lunchSpots: Spot[];
}

function buildServer(kt: KtClient, options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "kaloricke-tabulky", version: "0.1.0", icons: [{ src: ICON_URL, mimeType: "image/png", sizes: ["180x180"] }] },
    {
      instructions:
        "Logs food into the user's KalorickeTabulky.cz diary. Workflow: identify each component of a meal separately, " +
        "search_foods in Czech for each one, pick the most generic matching entry, then call get_food_units and log a sensible " +
        "portion with add_food_entry. For restaurant dishes with no good match, use add_own_food with your own estimate. " +
        "If the food or the portion is genuinely unclear, ask before logging. After logging, briefly summarise what you " +
        "logged and the estimated kcal, so the user can correct it with update_food_entry or delete_food_entries.",
    },
  );

  server.registerTool(
    "search_foods",
    {
      description:
        "Search the KT food database. Query in Czech (e.g. 'rohlík', 'kuřecí prsa grilovaná'). Returns food IDs with kcal per 100 g/ml.",
      inputSchema: { query: z.string().min(2) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const hits = await kt.searchFoods(query);
      return json(
        hits
          .filter((h) => h.clazz === "foodstuff")
          .slice(0, 15)
          .map((h) => ({
            food_id: h.id,
            title: h.title,
            brand: h.brandName,
            [`${h.energyUnit}_per_100${h.unit}`]: h.value,
          })),
      );
    },
  );

  server.registerTool(
    "get_food_units",
    {
      description:
        "List portion units for a food (e.g. 'kus (60 g)', 'porce (150 g)', '1 g') with their gram weight, to log natural portions with add_food_entry.",
      inputSchema: { food_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ food_id }) => {
      const form = await kt.getAddForm(food_id, ktDate());
      return json({
        title: form.title,
        units: form.unitOptions.map((u) => ({ unit_id: u.id, title: u.title, grams: u.multiplier })),
      });
    },
  );

  server.registerTool(
    "add_food_entry",
    {
      description:
        "Log a food from the KT database. Without unit_id, amount is in grams (or ml). With a unit_id from get_food_units, " +
        "amount is the number of those units, e.g. 2 × 'kus (60 g)'.",
      inputSchema: {
        food_id: z.string(),
        meal: mealSchema,
        amount: z.number().positive(),
        unit_id: z.string().optional().describe("From get_food_units; omit to log grams"),
        date: dateSchema,
        time: timeSchema,
      },
    },
    async ({ food_id, meal, amount, unit_id, date, time }) => {
      await kt.addEntry({ foodId: food_id, date: ktDate(date), mealId: MEALS[meal], amount, unitId: unit_id, time });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "add_own_food",
    {
      description:
        "Log a one-off food with your own estimated nutrition for the whole portion (not per 100 g); macros in g, *_mg fields in mg. " +
        "Use for restaurant dishes or anything without a good database match.",
      inputSchema: {
        title: z.string().describe("Short Czech name, e.g. 'Svíčková s knedlíkem (restaurace)'"),
        kcal: z.number().nonnegative(),
        ...nutrientInputSchema,
        meal: mealSchema,
        date: dateSchema,
        time: timeSchema,
      },
    },
    async ({ title, kcal, meal, date, time, ...nutrients }) => {
      await kt.addOwnFood({ title, energy: kcal, ...toKtNutrients(nutrients) }, ktDate(date), MEALS[meal], time);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "get_diary",
    {
      description: "Read a day's diary: entries per meal (with entry_id), plus daily totals vs. goals.",
      inputSchema: { date: dateSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      const d = ktDate(date);
      const [diary, summary] = await Promise.all([kt.getDiary(d), kt.getDaySummary(d)]);
      return json({ date: d, meals: compactDiary(diary), summary: compactSummary(summary) });
    },
  );

  server.registerTool(
    "update_food_entry",
    {
      description: "Change the amount and/or unit of an existing diary entry. Units are listed in the error if unit_id is wrong.",
      inputSchema: {
        entry_id: z.string().describe("From get_diary"),
        amount: z.number().positive(),
        unit_id: z.string().optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ entry_id, amount, unit_id }) => {
      await kt.updateEntry(entry_id, amount, unit_id);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "get_goals",
    {
      description: "Read the daily kcal target and nutrient goals, plus current and target body weight.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(compactGoals(await kt.getProfile())),
  );

  server.registerTool(
    "set_goals",
    {
      description:
        "Set daily macro goals (g). The kcal target is derived from them (4/4/9 kcal per g, rounded to 10), so it always matches. " +
        "Propose the new numbers and get the user's confirmation before calling; these goals may come from their nutritionist.",
      inputSchema: {
        protein: z.number().positive(),
        carbs: z.number().positive(),
        fat: z.number().positive(),
        fiber: z.number().positive().optional(),
        sugar: z.number().positive().optional(),
        saturated_fat: z.number().positive().optional(),
        salt: z.number().positive().optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ protein, carbs, fat, fiber, sugar, saturated_fat, salt }) => {
      const kcal = macroKcal(protein, carbs, fat);
      const nutrients = Object.fromEntries(
        Object.entries({ protein, carbohydrate: carbs, fat, fiber, sugar, saturatedFattyAcid: saturated_fat, salt })
          .filter(([, v]) => v != null),
      ) as Record<string, number>;
      return json(compactGoals(await kt.setGoals(kcal, nutrients)));
    },
  );

  server.registerTool(
    "get_progress",
    {
      description:
        "Daily kcal, protein, carbs and fat with their targets for a date range (days with ~0 kcal were probably not logged), " +
        "plus every weigh-in over a longer window, BMI and basal metabolism. Use for trend and adherence reviews.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14),
        weight_days: z.number().int().min(7).max(365).default(90).describe("How far back to list weigh-ins"),
        end_date: dateSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, weight_days, end_date }) => {
      const end = end_date ?? pragueToday();
      const to = ktDate(end);
      const [energy, nutrients, weight, stats] = await Promise.all([
        kt.getEnergyRange(ktDate(shiftIso(end, 1 - days)), to),
        kt.getNutrientRange(ktDate(shiftIso(end, 1 - days)), to),
        kt.getWeightRange(ktDate(shiftIso(end, 1 - weight_days)), to),
        kt.getStatistics(to),
      ]);

      const byDay = new Map<string, Record<string, number>>();
      const day = (ms: number) => byDay.get(isoFromMs(ms)) ?? byDay.set(isoFromMs(ms), {}).get(isoFromMs(ms))!;
      for (const p of energy.values) if (p.from != null) day(p.from).kcal = Math.round(p.value);
      for (const p of energy.target) if (p.from != null) day(p.from).kcal_target = Math.round(p.value);
      for (const n of nutrients.nutrientsValues) {
        Object.assign(day(n.createdDate), { protein: round(n.protein.value), carbs: round(n.carbs.value), fat: round(n.fat.value) });
      }
      for (const n of nutrients.nutrientsTarget) {
        Object.assign(day(n.createdDate), { protein_target: n.protein.value, carbs_target: n.carbs.value, fat_target: n.fat.value });
      }

      return json({
        daily: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
        weight_kg: stats.weight,
        target_weight_kg: stats.weightTarget,
        bmi: `${stats.bmi} (${stats.bmiCategory})`,
        basal_kcal: stats.basal,
        weight_log: weight.values
          .filter((w) => w.from != null)
          .map((w) => ({ date: isoFromMs(w.from!), kg: w.value }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      });
    },
  );

  server.registerTool(
    "search_history",
    {
      description:
        "Find foods the user logged in past days by name (diacritics-insensitive, all words must match), newest first. " +
        "Use when they say they've eaten something before but don't know when; then copy_entries can log it again.",
      inputSchema: {
        query: z.string().min(2),
        days: z.number().int().min(1).max(45).default(30),
        end_date: dateSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, days, end_date }) => {
      const end = end_date ?? pragueToday();
      const words = normalize(query).split(" ").filter(Boolean);
      // Fetch only days that have anything logged; Workers allow ~50 outgoing requests per call.
      const energy = await kt.getEnergyRange(ktDate(shiftIso(end, 1 - days)), ktDate(end));
      const logged = energy.values.filter((p) => p.from != null && p.value > 0).map((p) => isoFromMs(p.from!));

      const diaries = await mapLimited(logged, 5, async (iso) => ({ iso, diary: await kt.getDiary(ktDate(iso)) }));
      const matches = diaries.flatMap(({ iso, diary }) =>
        diary.times.flatMap((t) =>
          t.foodstuff
            .filter((f) => words.every((w) => normalize(f.title).includes(w)))
            .map((f) => ({ date: iso, meal: mealName(t.id), ...compactItem(f) })),
        ),
      );
      matches.sort((a, b) => b.date.localeCompare(a.date));
      return json({ searched_days: logged.length, matches: matches.slice(0, 30) });
    },
  );

  server.registerTool(
    "copy_entries",
    {
      description:
        "Copy diary entries to another day or meal: a whole meal ('breakfast like yesterday') or selected entry_ids from it " +
        "(e.g. found with search_history). Amounts are copied as logged; adjust afterwards with update_food_entry if needed.",
      inputSchema: {
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD of the source day"),
        from_meal: mealSchema,
        entry_ids: z.array(z.string()).optional().describe("Entries of from_meal to copy; omit to copy the whole meal"),
        to_date: dateSchema,
        to_meal: mealSchema.optional().describe("Defaults to from_meal"),
      },
    },
    async ({ from_date, from_meal, entry_ids, to_date, to_meal }) => {
      const from = ktDate(from_date);
      const to = ktDate(to_date);
      const toMeal = MEALS[to_meal ?? from_meal];
      const source = (await kt.getDiary(from)).times.find((t) => t.id === MEALS[from_meal])?.foodstuff ?? [];

      const wanted = entry_ids ? new Set(entry_ids) : null;
      const items = wanted ? source.filter((f) => wanted.has(f.id)) : source;
      const missing = entry_ids?.filter((id) => !source.some((f) => f.id === id)) ?? [];
      if (missing.length) throw new Error(`Entries not found in ${from_meal} on ${from_date}: ${missing.join(", ")}`);

      const dbFoods = new Set(items.flatMap((f) => (f.guidType ? [f.guidType] : [])));
      const copied = await kt.copyFoods(from, MEALS[from_meal], dbFoods, to, toMeal);

      // One-off own foods aren't in the copy form, so they're re-added from their logged values.
      const own = items.filter((f) => !f.guidType && !f.guidUserMeal);
      for (const f of own) await kt.addOwnFood(ownFoodFromDiary(f), to, toMeal);

      return json({
        copied,
        re_added_own_foods: own.map((f) => f.title),
        skipped_saved_meals: items.filter((f) => f.guidUserMeal).map((f) => f.title),
      });
    },
  );

  if (options.lunchSpots.length) {
    server.registerTool(
      "get_lunch_menus",
      {
        description:
          "Menus of the user's usual lunch places (e.g. near the office): today's daily menu where the place publishes one, " +
          "otherwise its fixed menu. Prices in CZK, no nutrition data; estimate it yourself. " +
          `Places: ${options.lunchSpots.map((s) => s.name + (s.area ? ` (${s.area})` : "")).join(", ")}.`,
        inputSchema: { date: dateSchema },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => json(await getMenus(options.lunchSpots, date ?? pragueToday())),
    );
  }

  if (options.recordWeight) {
    server.registerTool(
      "record_weight",
      {
        description: "Record a body weight measurement in kg.",
        inputSchema: { weight_kg: z.number().min(30).max(300), date: dateSchema },
      },
      async ({ weight_kg, date }) => {
        await kt.recordWeight(weight_kg, ktDate(date));
        return json({ ok: true });
      },
    );
  }

  server.registerTool(
    "delete_food_entries",
    {
      description: "Delete diary entries by entry_id (from get_diary).",
      inputSchema: { entry_ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ entry_ids }) => {
      await kt.deleteEntries(entry_ids);
      return json({ ok: true });
    },
  );

  return server;
}

export function macroKcal(protein: number, carbs: number, fat: number): number {
  return Math.round((4 * protein + 4 * carbs + 9 * fat) / 10) * 10;
}

function compactGoals(p: ProfileForm) {
  return {
    kcal_target: p.ownTargetEnergy,
    nutrients: p.ownNutrients
      .filter((n) => n.active)
      .map((n) => ({ code: n.code, goal: n.value, computed_default: n.computedValue })),
    weight_kg: p.weight,
    target_weight_kg: p.targetWeight,
  };
}

interface SummaryItem {
  title: string | null;
  unit: string;
  goal: string;
  actual: string;
  code: string | null;
}

function compactSummary(summary: unknown) {
  const s = summary as { items?: SummaryItem[]; itemsDynamic?: SummaryItem[][] };
  const items = [...(s.items ?? []), ...(s.itemsDynamic ?? []).flat()];
  return items.map((i) => ({
    name: i.code ?? i.title,
    actual: i.actual,
    goal: i.goal,
    unit: i.unit,
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (ICON_PATHS.has(pathname)) {
      const icon = await fetch(ICON_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
      return new Response(icon.body, {
        status: icon.status,
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }
    if (pathname === "/") {
      return new Response(
        `<!doctype html><html><head><title>Kalorické tabulky MCP</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head><body></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    if (pathname !== `/mcp/${env.MCP_PATH_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }

    const rpc = await request.clone().json().catch(() => null) as { method?: string; params?: { name?: string; arguments?: unknown } } | null;
    if (rpc?.method === "tools/call") console.log({ tool: rpc.params?.name, args: rpc.params?.arguments });

    const kt = new KtClient({ email: env.KT_EMAIL, password: env.KT_PASSWORD }, env.KT_SESSION);
    const server = buildServer(kt, {
      recordWeight: env.ENABLE_RECORD_WEIGHT === "true",
      lunchSpots: env.LUNCH_SPOTS ? spotsSchema.parse(JSON.parse(env.LUNCH_SPOTS)) : [],
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
