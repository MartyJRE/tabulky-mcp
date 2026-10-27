import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { KtClient } from "./kt/client";
import { getMenus, spotsSchema, type Spot } from "./menus";
import type { Diary, DiaryItem, ProfileForm } from "./kt/types";

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

function compactDiary(diary: Diary) {
  const ids = Object.entries(MEALS);
  return diary.times.map((t) => ({
    meal: ids.find(([, id]) => id === t.id)?.[0] ?? t.id,
    title: t.title,
    kcal_total: t.energyTotal,
    entries: t.foodstuff.map(compactItem),
  }));
}

const PROGRESS_CODES = new Set(["total", "protein", "carbohydrate", "fat", "fiber", "sugar"]);

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
        "List portion units for a food (e.g. 'kus (60 g)', '100 g', '1 g') with their gram weight. Call before add_food_entry to choose unit_id.",
      inputSchema: { food_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ food_id }) => {
      const form = await kt.getAddForm(food_id, ktDate());
      return json({
        title: form.title,
        default_unit_id: form.unitGuid,
        units: form.unitOptions.map((u) => ({ unit_id: u.id, title: u.title, grams: u.multiplier })),
      });
    },
  );

  server.registerTool(
    "add_food_entry",
    {
      description:
        "Log a food from the KT database. amount is the number of units, e.g. 2 × 'kus (60 g)' or 150 × '1 g'.",
      inputSchema: {
        food_id: z.string(),
        meal: mealSchema,
        amount: z.number().positive(),
        unit_id: z.string().optional().describe("From get_food_units; defaults to the food's default unit"),
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
        "Daily intake vs. goals for a date range (kcal and main nutrients; days with 0 kcal were probably not logged), " +
        "plus the weight log for the past month, BMI and basal metabolism. Use for trend and adherence reviews.",
      inputSchema: {
        days: z.number().int().min(1).max(31).default(14),
        end_date: dateSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, end_date }) => {
      const end = end_date ?? pragueToday();
      const dates = Array.from({ length: days }, (_, i) => shiftIso(end, i - days + 1));
      const daily = await mapLimited(dates, 4, async (iso) => ({
        date: iso,
        ...Object.fromEntries(
          compactSummary(await kt.getDaySummary(ktDate(iso)))
            .filter((s) => PROGRESS_CODES.has(String(s.name)))
            .map((s) => [s.name, `${s.actual} / ${s.goal} ${s.unit}`]),
        ),
      }));
      const stats = await kt.getStatistics(ktDate(end));
      return json({
        daily,
        weight_kg: stats.weight,
        target_weight_kg: stats.weightTarget,
        bmi: `${stats.bmi} (${stats.bmiCategory})`,
        basal_kcal: stats.basal,
        weight_log: stats.monthWeight.map((w) => ({ date: isoFromMs(w.from), kg: w.value })),
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
