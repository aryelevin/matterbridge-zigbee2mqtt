/**
 * (c) 2026 Arye Levin (Avraham Ostreicher)
 * HeDate.ts is released under the MIT license
 */

/* ================ Helpers ================ */

const MONTH_LENGTH = 765433; // in parts TODO: portions?
const DAY_LENGTH = 25920; // in parts
const CYCLE_MONTHS = 235; // moon's cycle in months
const CYCLE_YEARS = 19; // moon's cycle in sun years
const DISTANCE = 2092591; // days between Hebrew base (29/5/0) to Gregorian 1/1/1970
const INVALID = 'Invalid Date';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Tishri', 'Heshvan', 'Kislev', 'Tevet', 'Shevat', 'Adar I', 'Adar II', 'Nisan', 'Iyar', 'Sivan', 'Tamuz', 'Av', 'Elul', 'Adar'];

/* like `x % y` even for negative numbers */
const modulo = (x: number, y: number): number => {
  return x - y * Math.floor(x / y);
};

const getMonthName = (monthNumInput: number, leap: boolean): string => {
  let monthNum = monthNumInput;
  if (!leap) {
    if (monthNum == 5) {
      return MONTHS[13];
    } else if (monthNum > 5) {
      monthNum++;
    }
  }
  return MONTHS[monthNum];
};

const ms2days = (ms: number): number => {
  return Math.floor(ms / 86400000);
};

const getDaysSinceEpoch = (date: Date): number => {
  return ms2days(date.getTime() - date.getTimezoneOffset() * 60000);
};

const getUTCDaysSinceEpoch = (date: Date): number => {
  return ms2days(date.getTime());
};

const isLeap = (year: number): boolean => {
  const reminder = modulo(year, CYCLE_YEARS);
  return Boolean([2, 5, 7, 10, 13, 16, 18].indexOf(reminder) + 1);
};

/**
 * length of Heshvan and Kislev varies from year to year with 3 possible
 * states:
 *   (1)  both have 30 days
 *   (0)  Heshvan has 29 days, Kislev has 30 days
 *   (-1) both have 29 days
 *
 * @param {number} daysSinceEpoch -
 * @param {number} nextYearInDays -
 * @returns {number} -
 */
const getYearMode = (daysSinceEpoch: number, nextYearInDays: number): number => {
  const yearLength = nextYearInDays - daysSinceEpoch;
  return (yearLength % 10) - 4;
};

/**
    TODO: improve
 * The following 2 converters are based on an idea introduced by Rabby
 * Avraham Bar Hiyya in his Sefer Ha`Ibur, in second article, chapter 5
 *	 link: http://www.daat.ac.il/daat/vl/haibur2/haibur201.pdf
 * The main idea is as follow:
 *   Moon's cycle (of 19 sun years) begins 3 year before, (at -2 or at 17),
 *   then, sum of moon years must be greater than or equal to sun years' sum.
 *   This rule leads to the following order of leap years: [1,3,6,9,11,14,17]
 *   which is identical to the traditional order: [3,6,8,11,14,17,19] if
 *   starting 3 years later.
 */

/**
 * months - zero-based
 * returns year - zero-based
 *
 * @param {number} months -
 * @returns {number} -
 */
const months2year = (months: number): number => {
  return Math.floor(((months + 38) * CYCLE_YEARS) / CYCLE_MONTHS) - 3;
};

/**
 * year - zero-based
 * returns months - zero-based
 *
 * @param {number} year -
 * @returns {number} -
 */
const year2months = (year: number): number => {
  return Math.ceil(((year + 3) * CYCLE_MONTHS) / CYCLE_YEARS) - 38;
};

/**
 * days - since Hebrew base (29/5/0) zero-based
 * returns months - zero-based
 *
 * @param {number} daysSinceHebrewBase -
 * @returns {number} -
 */
const days2yearsInMonths = (daysSinceHebrewBase: number): number => {
  let months;
  const parts = daysSinceHebrewBase * DAY_LENGTH;
  months = parts / MONTH_LENGTH;
  months = Math.floor(months);
  const year = months2year(months);
  months = year2months(year);
  return months;
};

/**
 * months - till the beginnig of year
 * returns days till the beginnig of year
 *
 * @param {number} months -
 * @returns {number} -
 */
// TODO: improve this function - structure and line length
const getNewYearInDays = (months: number): number => {
  let parts, days, result;

  // year's birth (Molad) distance than the sunday before first Rosh Hashana
  parts = months * MONTH_LENGTH + 31524;
  result = days = Math.floor(modulo(parts, 181440) / DAY_LENGTH);
  parts = modulo(parts, DAY_LENGTH);

  // 'MOLAD ZAKEN'
  if (parts >= 19440) {
    result++;
  }

  // 'LO ADU ROSH'
  if ([0, 3, 5, 7].indexOf(result) + 1) {
    result++;
  }

  if (result == days) {
    // 'GETRED'
    if (result == 2 && parts >= 9924 && !isLeap(months2year(months))) {
      result += 2;
    }

    // 'BETUTAKPAT'
    else if (result == 1 && parts >= 16789 && isLeap(months2year(months) - 1)) {
      result++;
    }
  }

  return Math.floor((months * MONTH_LENGTH + 31524) / DAY_LENGTH) + result - days;
};

/**
 * months - till the beginnig of current year
 * leap - Boolean
 *
 * @param {number} months -
 * @param {boolean} leap -
 * @returns {number} -
 */
const getNextYearInDays = (months: number, leap: boolean): number => {
  const yearLength = 12 + Number(leap);
  return getNewYearInDays(months + yearLength);
};

// returns 0, 1 or -1
const getMonthContext = (month: number, year1: number, year2: number): number => {
  const leap1 = isLeap(year1 - 1);
  const leap2 = isLeap(year2 - 1);

  if (month < 5 + Number(leap1)) return 0;
  return Number(leap2) - Number(leap1);
};

/* ================ Conversion ================ */

/* days since 1/1/1970 zero-based */
const days2hebrew = (daysInput: number): { year: number; month: number; date: number } => {
  let days = daysInput + DISTANCE;

  let months = days2yearsInMonths(days);
  let currentYear = getNewYearInDays(months);
  let nextYear = undefined;

  if (currentYear > days) {
    nextYear = currentYear;
    months = days2yearsInMonths(days - 7);
    currentYear = getNewYearInDays(months);
  }
  days -= currentYear;
  let year = months2year(months);
  const leap = isLeap(year);
  nextYear = nextYear ?? getNextYearInDays(months, leap);
  const mode = getYearMode(currentYear, nextYear);

  if (days > 87) {
    days -= mode;
  } else if (days > 58 && mode == 1) {
    days -= 0.5;
  }

  if (days > 176) days -= Number(leap) * 0.5;

  const month = Math.floor(days / 29.5);
  let date = Math.floor(days % 29.5);

  // change value back from zero-based
  year++;
  date++;

  return {
    year: year,
    month: month,
    date: date,
  };
};

/* month - zero-based */
const hebrew2days = (yearInput: number, monthInput: number, dateInput: number): number => {
  // change value from to zero-based
  let date = dateInput - 1;
  let year = yearInput - 1;
  let month = monthInput;

  // combine year and month to get the actual year and month
  // this allows user to set a negative month number
  let months = year2months(year) + month;
  year = months2year(months);
  month = months - year2months(year);
  months -= month;

  let days = getNewYearInDays(months);

  const leap = isLeap(year);
  const nextYear = getNextYearInDays(months, leap);
  const mode = getYearMode(days, nextYear);

  days += month * 29.5;
  if ((month > 1 && mode == 1) || month > 2) days += mode;
  if (month > 5) days += Number(leap) * 0.5;
  days = Math.ceil(days);

  days += date;

  return days - DISTANCE;
};

const stringify = (daysSinceEpoch: number): string => {
  const dateInfo = days2hebrew(daysSinceEpoch);
  const weekday = (daysSinceEpoch + 4) % 7;
  const weekdayStr = WEEKDAYS[weekday];
  const month = getMonthName(dateInfo.month, isLeap(dateInfo.year - 1));
  const date = ('0' + dateInfo.date).slice(-2);
  return weekdayStr + ' ' + date + ' ' + month + ' ' + dateInfo.year;
};

/* ================ Main ================ */

// TypeScript
class HeDate extends Date {
  // 1. Overload signatures to support all native Date constructor variations
  constructor();
  constructor(value: number | string);
  constructor(date: Date);
  constructor(year: number, monthIndex: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number);

  // 2. Single implementation handling all cases via rest parameters
  // The constructor is where you initialize the instance
  // oxlint-disable-next-line typescript/no-explicit-any
  constructor(...args: any[]) {
    // Spread arguments safely into the native Date constructor
    // @ts-expect-error - Required for TypeScript to spread arguments into super
    super(...args);

    Object.setPrototypeOf(this, HeDate.prototype);

    if (args.length == 1) {
      if (typeof args[0] === 'number') {
        this.setTime(args[0]);
      } else if (args[0] instanceof Date) {
        this.setTime(args[0].getTime());
      }
    } else if (args.length > 1) {
      const year: number = args[0],
        monthIndex: number = args[1],
        date: number = args[2],
        hours: number = args[3],
        minutes: number = args[4],
        seconds: number = args[5],
        ms: number = args[6];
      this.setFullYear(year, monthIndex, date ?? 1);
      this.setHours(hours ?? 0, minutes ?? 0, seconds ?? 0, ms ?? 0);
    }
  }

  // 1. Declare a static method matching the exact native parameters
  public static override UTC(year: number, monthIndex: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number): number {
    // // 2. Add your custom intercept logic here
    // console.log(`Intercepted static UTC generation for year: ${year}`);

    // if (year < 1970) {
    //   throw new Error("HeDate static calculations don't support years before 1970.");
    // }

    // 3. Forward parameters to the native engine using Date.UTC()
    // Explicitly fallback to native defaults for optional parameters if they are missing
    const days = hebrew2days(year, monthIndex, date ?? 1);
    return Date.UTC(1970, 0, days + 1, hours ?? 0, minutes ?? 0, seconds ?? 0, ms ?? 0);
  }

  // 1. Match the exact native signature for setFullYear
  override getFullYear(): number {
    // // 2. Insert your custom logic before the mutation
    // console.log(`Intercepted: Changing year to ${year}`);

    // if (year < 1970) {
    //   throw new Error("HeDate does not support years before 1970.");
    // }

    // // 3. Call super to let the native Date engine update the timestamp
    // // We must pass all arguments dynamically to support optional parameters
    // return super.setFullYear(year, month ?? this.getMonth(), date ?? this.getDate());
    const days = getDaysSinceEpoch(this);
    return days2hebrew(days).year;
  }

  override getMonth(): number {
    const days = getDaysSinceEpoch(this);
    return days2hebrew(days).month;
  }

  override getDate(): number {
    const days = getDaysSinceEpoch(this);
    return days2hebrew(days).date;
  }

  override getUTCFullYear(): number {
    const days = getUTCDaysSinceEpoch(this);
    return days2hebrew(days).year;
  }

  override getUTCMonth(): number {
    const days = getUTCDaysSinceEpoch(this);
    return days2hebrew(days).month;
  }

  override getUTCDate(): number {
    const days = getUTCDaysSinceEpoch(this);
    return days2hebrew(days).date;
  }

  override setFullYear(year: number, month?: number, date?: number): number {
    const days = getDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    oldDate.month += getMonthContext(oldDate.month, oldDate.year, year);
    return this.setNewDate(year, month ?? oldDate.month, date ?? oldDate.date);
  }

  override setMonth(month: number, date?: number): number {
    const days = getDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    return this.setNewDate(oldDate.year, month, date ?? oldDate.date);
  }

  override setDate(date: number): number {
    const days = getDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    return this.setNewDate(oldDate.year, oldDate.month, date);
  }

  override setUTCFullYear(year: number, month?: number, date?: number): number {
    const days = getUTCDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    oldDate.month += getMonthContext(oldDate.month, oldDate.year, year);
    return this.setUTCNewDate(year, month ?? oldDate.month, date ?? oldDate.date);
  }

  override setUTCMonth(month: number, date?: number): number {
    const days = getUTCDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    return this.setUTCNewDate(oldDate.year, month, date ?? oldDate.date);
  }

  override setUTCDate(date: number): number {
    const days = getUTCDaysSinceEpoch(this);
    const oldDate = days2hebrew(days);
    return this.setUTCNewDate(oldDate.year, oldDate.month, date);
  }

  override toDateString(): string {
    if (Number.isNaN(this)) return INVALID;
    const daysSinceEpoch = getDaysSinceEpoch(this);
    return stringify(daysSinceEpoch);
  }

  override toString(): string {
    if (Number.isNaN(this)) return INVALID;
    return this.toDateString() + ' ' + this.toTimeString();
  }

  override toUTCString(): string {
    if (Number.isNaN(this)) return INVALID;
    const daysSinceEpoch = getUTCDaysSinceEpoch(this);
    return stringify(daysSinceEpoch);
  }

  setNewDate(year: number, month: number, date: number): number {
    const newDateDays = hebrew2days(year, month, date);
    return Date.prototype.setFullYear.call(this, 1970, 0, newDateDays + 1);
  }

  setUTCNewDate(year: number, month: number, date: number): number {
    const newDateDays = hebrew2days(year, month, date);
    return Date.prototype.setUTCFullYear.call(this, 1970, 0, newDateDays + 1);
  }
}

/* ================ Export ================ */

export { HeDate };
