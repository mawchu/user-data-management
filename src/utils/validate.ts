import type { UserInput } from '../types/user'

export const AGE_MIN = 16
export const AGE_MAX = 100
export const DATE_MIN = '1950-01-01'
export const DATE_MAX = '2100-12-31'
const TEXT_MAX = 50

export type FieldErrors = Partial<Record<keyof UserInput, string>>

/** 前端表單與 mock API 共用的驗證規則 */
export function validateUserInput(input: UserInput): FieldErrors {
  const errors: FieldErrors = {}
  for (const key of ['userName', 'position', 'location'] as const) {
    const value = typeof input[key] === 'string' ? input[key].trim() : ''
    if (!value) errors[key] = '必填'
    else if (value.length > TEXT_MAX) errors[key] = `最多 ${TEXT_MAX} 個字`
  }
  if (!Number.isInteger(input.age)) errors.age = '請輸入整數'
  else if (input.age < AGE_MIN || input.age > AGE_MAX) errors.age = `需介於 ${AGE_MIN}–${AGE_MAX}`
  if (!isValidDate(input.dateStart)) errors.dateStart = '格式需為 YYYY-MM-DD 的有效日期'
  else if (input.dateStart < DATE_MIN || input.dateStart > DATE_MAX) errors.dateStart = `需介於 ${DATE_MIN} 至 ${DATE_MAX}`
  return errors
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
