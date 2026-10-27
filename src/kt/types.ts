export interface ApiResponse<T = unknown> {
  code: number;
  message: string | null;
  data: T;
}

export interface SearchHit {
  clazz: string;
  id: string;
  title: string;
  unit: string;
  value: string;
  energyUnit: string;
  brandName: string | null;
  isLiquid: boolean;
}

export interface UnitOption {
  id: string;
  title: string;
  multiplier: number;
}

export interface DiaryTimeOption {
  id: string;
  title: string;
}

export interface AddForm {
  guid: string;
  title: string;
  diaryTimeGuid: string;
  diaryTimeOptions: DiaryTimeOption[];
  date: string;
  time: string;
  multiplier: number;
  unitGuid: string;
  unitOptions: UnitOption[];
  energy: string | number | null;
  energyUnit: string;
  detailValues: boolean;
  [field: string]: unknown;
}

export interface UnitForm {
  diaryGuid: string;
  multiplier: number;
  unitGuid: string;
  unitOptions: UnitOption[];
}

export interface DiaryItem {
  id: string;
  type: string;
  title: string;
  unit: string | null;
  energy: string | null;
  energyUnit: string;
  protein: number | null;
  carbohydrate: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
  saturatedFattyAcid: number | null;
  transFattyAcid: number | null;
  monoSaturated: number | null;
  polySaturated: number | null;
  cholesterol: number | null;
  sodium: number | null;
  salt: number | null;
  calcium: number | null;
  alcohol: number | null;
  water: number | null;
  time: string | null;
}

export interface DiaryTime {
  id: string;
  title: string;
  foodstuff: DiaryItem[];
  energyTotal: string | null;
}

export interface Diary {
  date: number;
  energyUnit: string;
  times: DiaryTime[];
  activities: DiaryItem[];
}

export interface OwnNutrient {
  code: string;
  title: string;
  value: number | null;
  computedValue: string | null;
  active: boolean;
  ratio: number | null;
}

export interface ProfileForm {
  ownTargetEnergy: number | null;
  ownTargetEnergyOpen: boolean;
  ownDailyDose: boolean;
  ownNutrients: OwnNutrient[];
  energyUnit: string;
  weight: number | null;
  targetWeight: number | null;
  [field: string]: unknown;
}

export interface WeightPoint {
  from: number;
  value: number;
}

// `from` is the day's midnight in Europe/Prague as epoch ms.
export interface StatPoint {
  from: number | null;
  value: number;
  description: string | null;
}

export interface EnergyRange {
  values: StatPoint[];
  target: StatPoint[];
}

export interface NutrientRange {
  nutrientsValues: { createdDate: number; protein: StatPoint; carbs: StatPoint; fat: StatPoint }[];
  nutrientsTarget: { createdDate: number; protein: StatPoint; carbs: StatPoint; fat: StatPoint }[];
}

export interface WeightRange {
  values: StatPoint[];
}

export interface Statistics {
  weight: string;
  weightTarget: string;
  bmi: string;
  bmiCategory: string;
  basal: string;
  monthWeight: WeightPoint[];
}

export interface OwnFood {
  title: string;
  energy: number;
  protein?: number;
  carbohydrate?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  saturatedFattyAcid?: number;
  transFattyAcid?: number;
  monoSaturated?: number;
  polySaturated?: number;
  cholesterol?: number;
  sodium?: number;
  salt?: number;
  calcium?: number;
  alcohol?: number;
}
