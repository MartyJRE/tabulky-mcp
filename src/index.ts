import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { KtClient } from "./kt/client";
import type { Diary, DiaryItem } from "./kt/types";

export interface Env {
  KT_SESSION: KVNamespace;
  KT_EMAIL: string;
  KT_PASSWORD: string;
  MCP_PATH_TOKEN: string;
}

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

function compactItem(f: DiaryItem) {
  return {
    entry_id: f.id,
    title: f.title,
    amount: f.unit,
    kcal: f.energy,
    protein: f.protein,
    carbs: f.carbohydrate,
    fat: f.fat,
    time: f.time,
  };
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

function buildServer(kt: KtClient): McpServer {
  const server = new McpServer(
    { name: "kaloricke-tabulky", version: "0.1.0" },
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
        "Log a one-off food with your own estimated nutrition for the whole portion (not per 100 g). " +
        "Use for restaurant dishes or anything without a good database match.",
      inputSchema: {
        title: z.string().describe("Short Czech name, e.g. 'Svíčková s knedlíkem (restaurace)'"),
        kcal: z.number().nonnegative(),
        protein: z.number().nonnegative().optional(),
        carbs: z.number().nonnegative().optional(),
        fat: z.number().nonnegative().optional(),
        fiber: z.number().nonnegative().optional(),
        sugar: z.number().nonnegative().optional(),
        meal: mealSchema,
        date: dateSchema,
        time: timeSchema,
      },
    },
    async ({ title, kcal, protein, carbs, fat, fiber, sugar, meal, date, time }) => {
      await kt.addOwnFood(
        { title, energy: kcal, protein, carbohydrate: carbs, fat, fiber, sugar },
        ktDate(date),
        MEALS[meal],
        time,
      );
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
    if (pathname !== `/mcp/${env.MCP_PATH_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }

    const kt = new KtClient({ email: env.KT_EMAIL, password: env.KT_PASSWORD }, env.KT_SESSION);
    const server = buildServer(kt);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
