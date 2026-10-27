# KalorickeTabulky.cz API notes

Reverse-engineered from the web app (`controller-diary-*.js`) on 2026-10-27. Unofficial, can change without notice.

Base: `https://www.kaloricketabulky.cz`. Add `format=json` to every API call. Responses are `{requestId, code, message, data}`; `code === 0` means success. Unauthenticated calls answer `302 → /login` rather than 401. Dates are `dd.mm.yyyy`.

The web app appends a CSRF query param to writes (`&` + value of `#csrf`), but that value is just `=`, so it's effectively unused.

Send `Accept: application/json, text/plain, */*` and `X-Requested-With: XMLHttpRequest` on every call, including login. Without them `statistic/*` returns the HTML page, and some writes fail with a generic "nepodařilo zapsat".

## Auth

`POST /login/create?format=json` with `{"email", "password": md5(password)}` and no reCAPTCHA. The returned cookies authenticate later calls. The `kaloricketabulky_token` cookie (expiry 2073) does **not** authenticate API calls on its own.

## Search (no auth)

`GET /autocomplete/foodstuff?query=<q>` → array of `{clazz: "foodstuff", id, title, unit: "g"|"ml", value: "<kcal per 100 unit>", energyUnit, brandName, isLiquid}`.

## Diary

| Action | Request |
|---|---|
| Read day | `GET /user/diary/{date}/get` → `{times: [{id: "1".."6", title, energyTotal, foodstuff: [{id, title, unit: "180 x 1 g", energy: "226" (Czech decimal comma), protein, carbohydrate, fat, …}]}], activities}` |
| Day totals vs. goals | `GET /user/diary/summary/{date}/get` → `{items, itemsDynamic: [[{code, goal, actual, unit}]], balance}` |
| Add form | `GET /user/foodstuff/add/form/{foodGuid}/{date}/get` → `{guid, title, diaryTimeGuid, date, time, multiplier, unitGuid, unitOptions: [{id, title: "kus (60 g)", multiplier: 60}], energy, protein, …}` |
| Add | `POST /user/foodstuff/add` with the add form, modified: `diaryTimeGuid` (meal), `multiplier` (count of units), `unitGuid`, `time` |
| Add own food | Same, with form for guid `0`, plus `title`, `energy` (whole portion) and optional macros |
| Edit amount form | `GET /user/diary/foodstuff/unit/form/{entryId}` → `{diaryGuid, multiplier, unitGuid, unitOptions}` |
| Edit amount | `POST /user/diary/foodstuff/unit/edit` with `{diaryGuid, multiplier, unitGuid}` |
| Delete | `GET /user/diary/foodstuff/delete/{id1,id2,…}` |

Meal (diary time) IDs: 1 Snídaně, 2 Dopolední svačina, 3 Oběd, 4 Odpolední svačina, 5 Večeře, 6 Druhá večeře. Their display names (which a user can rename) are in `diaryTimeOptions` of the add form.

The add form's default `unitGuid` is often a portion ("porce (150 g)", "lžička (5 ml)", "balení (730 ml)"), not grams. The 1 g/ml unit is the option with `multiplier: 1`.

## Statistics (ranges)

Each returns the whole range in one call (`page`/`limit` only apply to `tableData`).

| Data | Request |
|---|---|
| kcal per day | `GET /statistic/energy/{from}/{to}/get` → `values[]` and `target[]` of `{from (ms, midnight Prague), value}` |
| Macros per day | `GET /statistic/nutrients/{from}/{to}/get` → `nutrientsValues[]` / `nutrientsTarget[]` of `{createdDate, protein, carbs, fat}` |
| Weigh-ins | `GET /statistic/weight/{from}/{to}/get` → `values[]` of `{from, value}` (only days with a measurement) |
| Overview | `GET /statistic/summary/{date}/get` → BMI, basal, `monthWeight`, `weekEnergy`, `weekDrink`, `todayDrink` |
| Streak | `GET /user/streak?date=yyyy-mm-dd` |

## Not implemented

Found by a second implementation of the same idea and confirmed by its author; listed here for reference.

| Feature | Request |
|---|---|
| Saved meals ("Moje jídla") | List `GET /user/settings/meal/list?limit=100&query=`; log `GET /user/meal/add/form/{guid}` then `POST /user/meal/add`. Component `count = countOriginal × ratio`; a unit with `multiplier` 1 is grams, -1 is percent. |
| Save a diary time as a meal | `GET /user/meal/create/form/{date}/{timeId}` then `POST /user/meal/create` with `title` |
| Copy a diary time ("breakfast as yesterday") | `GET /user/diary-time/create/form/{date}/{timeId}`, set `selected: true` on items, `POST /user/diary-time/copy` with target `date` and `diaryTimeGuid` |
| Move an entry | `GET /user/diary/{id}/{timeId}/0/dragndrop` (other meal) or `GET /user/diary/{id}/0/{date}/dragndrop` (other day). **A mutation over GET.** |
| Drinks | `GET /autocomplete/drink?query=` |

Nutrient units: the diary returns all nutrients in g (calcium `0.018` = 18 mg). The own-food add form takes cholesterol and calcium in **mg** but sodium in g.

## Goals

| Action | Request |
|---|---|
| Read | `GET /user/settings/profile/form` → `{ownTargetEnergy (kcal), ownDailyDose, ownNutrients: [{code, value (g), computedValue, active, ratio}], weight, targetWeight, …}` |
| Save | `POST /user/settings/profile/edit?=` with the whole form; `ownTargetEnergyOpen: true` saves the kcal target, `ownDailyDose: true` saves `ownNutrients` |
| kJ view | `GET /user/settings/premium/goals` → `{goalEnergy (kJ), goalProtein, goalFat, goalCarbohydrate, goalFiber}` |

The kcal target is stored in kJ; saving N kcal sometimes reads back as N−1.

Food submission to the public database (`foodstuff/suggest`) is gone from the web (404), so it's app-only.

Also not used: time edit (`POST /user/diary/foodstuff/time/edit`), notes, activities.
