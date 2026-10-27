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

export interface OwnFood {
  title: string;
  energy: number;
  protein?: number;
  carbohydrate?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  saturatedFattyAcid?: number;
  salt?: number;
}
