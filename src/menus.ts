import { z } from "zod";

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("menicka"), url: z.string().url() }),
  // Sections active on the given weekday whose name matches `section` (case-insensitive regex).
  z.object({ type: z.literal("choiceqr"), host: z.string(), section: z.string().default("oběd") }),
  z.object({ type: z.literal("jidlovice"), branchId: z.number().int() }),
  z.object({ type: z.literal("wolt"), slug: z.string() }),
]);

const spotSchema = z.object({
  name: z.string(),
  area: z.string().optional(),
  note: z.string().optional(),
  source: sourceSchema,
});

export const spotsSchema = z.array(spotSchema);
export type Spot = z.infer<typeof spotSchema>;
type Source = z.infer<typeof sourceSchema>;

export interface MenuItem {
  name: string;
  description?: string;
  price_czk?: number;
  sold_out?: boolean;
}

export interface SpotMenu {
  name: string;
  area?: string;
  note?: string;
  kind: "daily" | "fixed";
  items: MenuItem[];
  error?: string;
}

const UA = "Mozilla/5.0 (compatible; tabulky-mcp)";

export async function getMenus(spots: Spot[], isoDate: string): Promise<SpotMenu[]> {
  return Promise.all(
    spots.map(async ({ name, area, note, source }) => {
      const kind = source.type === "wolt" ? "fixed" : "daily";
      try {
        return { name, area, note, kind, items: await fetchSource(source, isoDate) };
      } catch (e) {
        return { name, area, note, kind, items: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

function fetchSource(source: Source, isoDate: string): Promise<MenuItem[]> {
  switch (source.type) {
    case "menicka":
      return menicka(source.url, isoDate);
    case "choiceqr":
      return choiceqr(source.host, source.section, isoDate);
    case "jidlovice":
      return jidlovice(source.branchId, isoDate);
    case "wolt":
      return wolt(source.slug);
  }
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url));
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(text: string): number | undefined {
  const m = text.replace(/\s/g, "").match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

async function menicka(url: string, isoDate: string): Promise<MenuItem[]> {
  const html = await getText(url);
  const [y, m, d] = isoDate.split("-").map(Number);
  const dayPattern = new RegExp(`\\b0?${d}\\.0?${m}\\.${y}\\b`);

  for (const block of html.split("<div class='menicka'>").slice(1)) {
    const heading = block.match(/<div class='nadpis'>([\s\S]*?)<\/div>/)?.[1] ?? "";
    if (!dayPattern.test(heading)) continue;
    const items: MenuItem[] = [];
    for (const li of block.matchAll(/<li class='(\w+)'>([\s\S]*?)<\/li>/g)) {
      const name = stripTags(
        (li[2].match(/<div class='polozka'>([\s\S]*?)<\/div>/)?.[1] ?? "")
          .replace(/<em[^>]*>[\s\S]*?<\/em>/g, "")
          .replace(/<span class='poradi'>[\s\S]*?<\/span>/g, ""),
      );
      const price = li[2].match(/<div class='cena'>([\s\S]*?)<\/div>/)?.[1];
      if (name) items.push({ name: li[1] === "polevka" ? `Polévka: ${name}` : name, price_czk: price ? parsePrice(price) : undefined });
    }
    return items;
  }
  throw new Error(`No menu for ${isoDate} on menicka.cz`);
}

interface ChoiceSection {
  _id: string;
  hurl: string;
  name: string;
  schedule: { dayOfWeek: number; active: boolean }[];
}

interface ChoiceApp {
  sections: ChoiceSection[];
  menu: { name: string; description: string | null; price: number; section: string; available: boolean }[];
}

async function choiceqrApp(url: string): Promise<ChoiceApp> {
  const html = await getText(url);
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new Error(`No __NEXT_DATA__ on ${url}`);
  return JSON.parse(json).props.app;
}

// choiceqr pages only embed the items of the section in the URL, so each matching section is fetched separately.
async function choiceqr(host: string, section: string, isoDate: string): Promise<MenuItem[]> {
  const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  const pattern = new RegExp(section, "i");
  const { sections } = await choiceqrApp(`https://${host}/online-menu`);
  const todays = sections.filter(
    (s) => pattern.test(s.name) && s.schedule.some((d) => d.active && d.dayOfWeek === weekday),
  );
  if (!todays.length) throw new Error(`No section matching /${section}/ is served on ${isoDate}`);

  const pages = await Promise.all(todays.map((s) => choiceqrApp(`https://${host}/online-menu/${s.hurl}`)));
  return pages.flatMap((app, i) =>
    app.menu
      .filter((m) => m.section === todays[i]._id && m.available)
      .map((m) => ({
        name: `${todays[i].name}: ${m.name}`,
        description: m.description?.trim() || undefined,
        price_czk: m.price / 100,
      })),
  );
}

interface JidloviceMenu {
  is_closed: boolean;
  closed_reason: string | null;
  menu_items: {
    meal_override: {
      name: string | null;
      description: string | null;
      price: number | null;
      visible: boolean;
      available: boolean;
    } | null;
    meal: { name: string; description: string | null; price: number };
  }[];
}

async function jidlovice(branchId: number, isoDate: string): Promise<MenuItem[]> {
  const menu = await getJson<JidloviceMenu>(`https://www.jidlovice.cz/api/v1/branch/${branchId}/menu/${isoDate}`);
  if (menu.is_closed) throw new Error(`Closed: ${menu.closed_reason ?? "no reason given"}`);
  return menu.menu_items
    .filter((i) => i.meal_override?.visible !== false)
    .map(({ meal, meal_override: o }) => ({
      name: (o?.name ?? meal.name).trim(),
      description: (o?.description ?? meal.description)?.trim() || undefined,
      price_czk: o?.price ?? meal.price,
      ...(o?.available === false && { sold_out: true }),
    }));
}

interface WoltAssortment {
  categories: { name: string; item_ids: string[] }[];
  items: { id: string; name: string; description: string; price: number }[];
}

const DRINKS = /drink|nápoj|napoj/i;

async function wolt(slug: string): Promise<MenuItem[]> {
  const data = await getJson<WoltAssortment>(
    `https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/${slug}/assortment?language=cs`,
  );
  const drinkIds = new Set(data.categories.filter((c) => DRINKS.test(c.name)).flatMap((c) => c.item_ids));
  return data.items
    .filter((i) => !drinkIds.has(i.id))
    .map((i) => ({
      name: i.name.trim(),
      // Wolt descriptions often repeat the text in English after a "//" separator.
      description: i.description.split("//")[0].trim() || undefined,
      price_czk: i.price / 100,
    }));
}
