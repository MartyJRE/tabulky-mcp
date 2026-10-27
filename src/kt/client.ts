import { md5 } from "js-md5";
import type {
  AddForm,
  ApiResponse,
  Diary,
  OwnFood,
  ProfileForm,
  SearchHit,
  UnitForm,
} from "./types";

const BASE = "https://www.kaloricketabulky.cz";
const SESSION_KEY = "kt-session-cookie";

export interface Credentials {
  email: string;
  password: string;
}

export interface AddEntryInput {
  foodId: string;
  date: string;
  mealId: string;
  amount: number;
  unitId?: string;
  time?: string;
}

class AuthExpired extends Error {}

export class KtClient {
  private cookie: string | null = null;

  constructor(
    private readonly creds: Credentials,
    private readonly kv: KVNamespace,
  ) {}

  async searchFoods(query: string): Promise<SearchHit[]> {
    const res = await fetch(
      `${BASE}/autocomplete/foodstuff?query=${encodeURIComponent(query)}`,
    );
    return res.json();
  }

  getDiary(date: string): Promise<Diary> {
    return this.get(`/user/diary/${date}/get`);
  }

  getDaySummary(date: string): Promise<unknown> {
    return this.get(`/user/diary/summary/${date}/get`);
  }

  getAddForm(foodId: string, date: string): Promise<AddForm> {
    return this.get(`/user/foodstuff/add/form/${foodId}/${date}/get`);
  }

  async addEntry(input: AddEntryInput): Promise<void> {
    const form = await this.getAddForm(input.foodId, input.date);
    const unitId = input.unitId ?? form.unitGuid;
    if (!form.unitOptions.some((u) => u.id === unitId)) {
      throw new Error(
        `Unknown unit ${unitId} for ${form.title}; options: ${JSON.stringify(form.unitOptions)}`,
      );
    }
    await this.post("/user/foodstuff/add", {
      ...form,
      diaryTimeGuid: input.mealId,
      multiplier: input.amount,
      unitGuid: unitId,
      time: input.time ?? form.time,
    });
  }

  async addOwnFood(
    food: OwnFood,
    date: string,
    mealId: string,
    time?: string,
  ): Promise<void> {
    const form = await this.getAddForm("0", date);
    await this.post("/user/foodstuff/add", {
      ...form,
      ...food,
      diaryTimeGuid: mealId,
      time: time ?? form.time,
      detailValues: true,
    });
  }

  getUnitForm(entryId: string): Promise<UnitForm> {
    return this.get(`/user/diary/foodstuff/unit/form/${entryId}`);
  }

  async updateEntry(
    entryId: string,
    amount: number,
    unitId?: string,
  ): Promise<void> {
    const form = await this.getUnitForm(entryId);
    const unitGuid = unitId ?? form.unitGuid;
    if (!form.unitOptions.some((u) => u.id === unitGuid)) {
      throw new Error(
        `Unknown unit ${unitGuid}; options: ${JSON.stringify(form.unitOptions)}`,
      );
    }
    await this.post("/user/diary/foodstuff/unit/edit", {
      diaryGuid: entryId,
      multiplier: amount,
      unitGuid,
    });
  }

  getProfile(): Promise<ProfileForm> {
    return this.get("/user/settings/profile/form");
  }

  // Mirrors the settings page: the *Open / ownDailyDose flags tell the server which sections to save.
  async setGoals(kcal: number, nutrients: Record<string, number>): Promise<ProfileForm> {
    const form = await this.getProfile();
    const known = new Set(form.ownNutrients.map((n) => n.code));
    const unknown = Object.keys(nutrients).filter((c) => !known.has(c));
    if (unknown.length) throw new Error(`Unknown nutrient codes: ${unknown.join(", ")}`);

    const save = (target: number) =>
      this.post("/user/settings/profile/edit", {
        ...form,
        ownTargetEnergy: target,
        ownTargetEnergyOpen: true,
        ownDailyDose: true,
        ownNutrients: form.ownNutrients.map((n) =>
          n.code in nutrients ? { ...n, value: nutrients[n.code], ratio: null } : n,
        ),
      });

    await save(kcal);
    // KT stores the target in kJ and the round trip sometimes truncates it by 1 kcal; compensate once.
    const saved = await this.getProfile();
    if (saved.ownTargetEnergy === kcal) return saved;
    await save(kcal + (kcal - (saved.ownTargetEnergy ?? kcal)));
    return this.getProfile();
  }

  async deleteEntries(entryIds: string[]): Promise<void> {
    await this.get(`/user/diary/foodstuff/delete/${entryIds.join(",")}`);
  }

  private get<T>(path: string): Promise<T> {
    return this.call(path, { method: "GET" });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    try {
      return await this.request(path, init, await this.session());
    } catch (e) {
      if (!(e instanceof AuthExpired)) throw e;
      return this.request(path, init, await this.login());
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    cookie: string,
  ): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${BASE}${path}${sep}format=json`, {
      ...init,
      headers: { ...init.headers, Cookie: cookie },
      redirect: "manual",
    });
    // Unauthenticated API calls redirect to /login instead of returning 401.
    if (res.status >= 300 && res.status < 400) throw new AuthExpired();

    const text = await res.text();
    let body: ApiResponse<T>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`KT ${path} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    if (body.code !== 0) {
      throw new Error(`KT ${path} failed: ${body.message ?? JSON.stringify(body)}`);
    }
    return body.data;
  }

  private async session(): Promise<string> {
    this.cookie ??= await this.kv.get(SESSION_KEY);
    return this.cookie ?? this.login();
  }

  private async login(): Promise<string> {
    const res = await fetch(`${BASE}/login/create?format=json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: this.creds.email,
        password: md5(this.creds.password),
      }),
    });
    const body: ApiResponse = await res.json();
    if (body.code !== 0) {
      throw new Error(`KT login failed: ${body.message ?? JSON.stringify(body)}`);
    }
    const cookie = res.headers
      .getAll("Set-Cookie")
      .map((c) => c.split(";")[0])
      .join("; ");
    this.cookie = cookie;
    await this.kv.put(SESSION_KEY, cookie);
    return cookie;
  }
}
