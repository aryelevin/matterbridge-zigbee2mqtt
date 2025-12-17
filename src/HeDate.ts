/**
 * (c) 2017 Avraham Ostreicher
 * HeDate.js is released under the MIT license
 */

// (function() {

/* ================ Helpers ================ */

const MONTH_LENGTH = 765433; // in parts TODO: portions?
const DAY_LENGTH = 25920; // in parts
const CYCLE_MONTHS = 235; // moon's cycle in months
const CYCLE_YEARS = 19; // moon's cycle in sun years
const DISTANCE = 2092591; // days between Hebrew base (29/5/0) to Gregorian 1/1/1970
const INVALID = 'Invalid Date';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Tishri', 'Heshvan', 'Kislev', 'Tevet', 'Shevat', 'Adar I', 'Adar II', 'Nisan', 'Iyar', 'Sivan', 'Tamuz', 'Av', 'Elul', 'Adar'];

/**
 * src - Array || Argument object
 * dest - Array
 */
const defaults = function (src: unknown[], dest: unknown[]) {
  let i = 0;
  const len = Math.min(src.length, dest.length);
  while (i < len) {
    dest[i] = src[i];
    i++;
  }
  return dest;
};

/* like `x % y` even for negative numbers */
const modulo = function (x: number, y: number) {
  return x - y * Math.floor(x / y);
};

const getMonthName = function (monthNum: number, leap: boolean) {
  if (!leap) {
    if (monthNum == 5) {
      return MONTHS[13];
    } else if (monthNum > 5) {
      monthNum++;
    }
  }
  return MONTHS[monthNum];
};

const ms2days = function (ms: number) {
  return Math.floor(ms / 86400000);
};

const getDaysSinceEpoch = function (date: Date) {
  return ms2days(date.getTime() - date.getTimezoneOffset() * 60000);
};

const getUTCDaysSinceEpoch = function (date: Date) {
  return ms2days(date.getTime());
};

const setNewDate = function (this: HeDate, newDateInfo: unknown[]) {
  const newDateDays = hebrew2days(...(newDateInfo as [number, number, number]));
  return Date.prototype.setFullYear.call(this, 1970, 0, newDateDays + 1);
};

const setUTCNewDate = function (this: HeDate, newDateInfo: unknown[]) {
  const newDateDays = hebrew2days(...(newDateInfo as [number, number, number]));
  return Date.prototype.setUTCFullYear.call(this, 1970, 0, newDateDays + 1);
};

const stringify = function (daysSinceEpoch: number) {
  const dateInfo = days2hebrew(daysSinceEpoch);
  const weekday = (daysSinceEpoch + 4) % 7;
  const weekdayStr = WEEKDAYS[weekday];
  const month = getMonthName(dateInfo.month, isLeap(dateInfo.year - 1));
  const date = ('0' + dateInfo.date).slice(-2);
  return weekdayStr + ' ' + date + ' ' + month + ' ' + dateInfo.year;
};

/**
 * months - till the beginnig of current year
 * leap - Boolean
 */
const getNextYearInDays = function (months: number, leap: boolean) {
  const yearLength = 12 + Number(leap);
  return getNewYearInDays(months + yearLength);
};

/**
 * length of Heshvan and Kislev varies from year to year with 3 possible
 * states:
 *   (1)  both have 30 days
 *   (0)  Heshvan has 29 days, Kislev has 30 days
 *   (-1) both have 29 days
 */
const getYearMode = function (daysSinceEpoch: number, nextYearInDays: number) {
  const yearLength = nextYearInDays - daysSinceEpoch;
  return (yearLength % 10) - 4;
};

const isLeap = function (year: number) {
  const reminder = modulo(year, CYCLE_YEARS);
  return Boolean([2, 5, 7, 10, 13, 16, 18].indexOf(reminder) + 1);
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
 */
const months2year = function (months: number) {
  return Math.floor(((months + 38) * CYCLE_YEARS) / CYCLE_MONTHS) - 3;
};

/**
 * year - zero-based
 * returns months - zero-based
 */
const year2months = function (year: number) {
  return Math.ceil(((year + 3) * CYCLE_MONTHS) / CYCLE_YEARS) - 38;
};

/**
 * days - since Hebrew base (29/5/0) zero-based
 * returns months - zero-based
 */
const days2yearsInMonths = function (daysSinceHebrewBase: number) {
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
 */
// TODO: improve this function - structure and line length
const getNewYearInDays = function (months: number) {
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

// returns 0, 1 or -1
const getMonthContext = function (month: number, year1: number, year2: number) {
  const leap1 = isLeap(year1 - 1);
  const leap2 = isLeap(year2 - 1);

  if (month < 5 + Number(leap1)) return 0;
  return Number(leap2) - Number(leap1);
};

/* ================ Conversion ================ */

/* days since 1/1/1970 zero-based */
const days2hebrew = function (days: number) {
  days += DISTANCE;

  let months = days2yearsInMonths(days);
  let currentYear = getNewYearInDays(months);
  let nextYear;

  if (currentYear > days) {
    nextYear = currentYear;
    months = days2yearsInMonths(days - 7);
    currentYear = getNewYearInDays(months);
  }
  days -= currentYear;
  let year = months2year(months);
  const leap = isLeap(year);
  nextYear = nextYear || getNextYearInDays(months, leap);
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
const hebrew2days = function (year: number, month: number, date: number) {
  // change value from to zero-based
  date--;
  year--;

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

/* ================ Main ================ */

// TypeScript
class HeDate extends Date {
  // Define properties with their types
  // private name: string; //

  // The constructor is where you initialize the instance
  constructor(...args: number[] | Date[]) {
    super();
    // this.name = name;
    const argumentsList = args;

    const date = new Date();
    Object.setPrototypeOf(date, Object.getPrototypeOf(this));
    // date.__proto__ = this.__proto__;

    if (argumentsList.length == 1) {
      date.setTime(argumentsList[0] as number);
    } else if (argumentsList.length > 1) {
      const args = defaults(argumentsList, [0, 0, 1, 0, 0, 0, 0]);
      const dateArgs = args.slice(0, 3);
      const timeArgs = args.slice(3);
      date.setFullYear(...(dateArgs as [number, number, number]));
      date.setHours(...(timeArgs as [number, number, number, number]));
    }

    return date;
  }

  // // Define methods
  // public sayHello(): void { //
  //   console.log(`Hello, ${this.name}`);
  // }
}

// class HeDate {
//   // Define properties with their types
//   // private name: string; //

//   // The constructor is where you initialize the instance
//   constructor(/*  name: string  */) {
//     // this.name = name;

//     if (!(this instanceof HeDate)) {
//       return new HeDate().toString();
//     }

//     const date = new Date();
//     Object.setPrototypeOf(date, Object.getPrototypeOf(this));
//     // date.__proto__ = this.__proto__;

//     if (arguments.length == 1) {
//       date.setTime(arguments[0]);
//     } else if (arguments.length > 1) {
//       const args = defaults(arguments, [0, 0, 1, 0, 0, 0, 0]);
//       const dateArgs = args.slice(0, 3);
//       const timeArgs = args.slice(3);
//       date.setFullYear.apply(date, dateArgs);
//       date.setHours.apply(date, timeArgs);
//     }

//     return date;
//   }

//   // // Define methods
//   // public sayHello(): void { //
//   //   console.log(`Hello, ${this.name}`);
//   // }
// }

// // Instantiate and use the class
// const greeterInstance = new Greeter('World');
// greeterInstance.sayHello();

// function HeDate(this: typeof HeDate): typeof HeDate {
//   if (!(this instanceof HeDate)) {
//     return new HeDate().toString();
//   }

//   const date = new Date();
//   Object.setPrototypeOf(date, Object.getPrototypeOf(this));
//   // date.__proto__ = this.__proto__;

//   if (arguments.length == 1) {
//     date.setTime(arguments[0]);
//   } else if (arguments.length > 1) {
//     const args = defaults(arguments, [0, 0, 1, 0, 0, 0, 0]);
//     const dateArgs = args.slice(0, 3);
//     const timeArgs = args.slice(3);
//     date.setFullYear.apply(date, dateArgs);
//     date.setHours.apply(date, timeArgs);
//   }

//   return date as unknown as typeof HeDate;
// }

// inherit Date.prototype
Object.setPrototypeOf(HeDate.prototype, Date.prototype);
// HeDate.prototype.__proto__ = Date.prototype;

Object.defineProperties(HeDate, {
  UTC: {
    value: function UTC(...args: number[]) {
      const argsList = defaults(args, [NaN, NaN, 1, 0, 0, 0, 0]);
      const days = hebrew2days(...(argsList.slice(0, 3) as [number, number, number]));
      argsList.splice(0, 3, 1970, 0, days + 1);
      return Date.UTC(...(argsList as [number, number, number, number, number, number, number]));
    },
  },
});

Object.defineProperties(HeDate.prototype, {
  getFullYear: {
    value: function getFullYear() {
      const days = getDaysSinceEpoch(this);
      return days2hebrew(days).year;
    },
  },
  getYear: {
    value: function getYear() {
      return this.getFullYear();
    },
  },
  getMonth: {
    value: function getMonth() {
      const days = getDaysSinceEpoch(this);
      return days2hebrew(days).month;
    },
  },
  getDate: {
    value: function getDate() {
      const days = getDaysSinceEpoch(this);
      return days2hebrew(days).date;
    },
  },
  getUTCFullYear: {
    value: function getUTCFullYear() {
      const days = getUTCDaysSinceEpoch(this);
      return days2hebrew(days).year;
    },
  },
  getUTCMonth: {
    value: function getUTCMonth() {
      const days = getUTCDaysSinceEpoch(this);
      return days2hebrew(days).month;
    },
  },
  getUTCDate: {
    value: function getUTCDate() {
      const days = getUTCDaysSinceEpoch(this);
      return days2hebrew(days).date;
    },
  },
  setFullYear: {
    value: function setFullYear(...args: number[]) {
      const days = getDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      oldDate.month += getMonthContext(oldDate.month, oldDate.year, args[0]);
      const newDate = defaults(args, [NaN, oldDate.month, oldDate.date]);
      return setNewDate.call(this, newDate);
    },
  },
  setYear: {
    value: function setYear(...args: number[]) {
      return this.setFullYear(args[0]);
    },
  },
  setMonth: {
    value: function setMonth(...args: number[]) {
      const days = getDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      const newDate = defaults(args, [NaN, oldDate.date]);
      newDate.splice(0, 0, oldDate.year);
      return setNewDate.call(this, newDate);
    },
  },
  setDate: {
    value: function setDate(...args: number[]) {
      const days = getDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      const newDate = [oldDate.year, oldDate.month, args[0]];
      return setNewDate.call(this, newDate);
    },
  },
  setUTCFullYear: {
    value: function setUTCFullYear(...args: number[]) {
      const days = getUTCDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      oldDate.month += getMonthContext(oldDate.month, oldDate.year, args[0]);
      const newDate = defaults(args, [NaN, oldDate.month, oldDate.date]);
      return setUTCNewDate.call(this, newDate);
    },
  },
  setUTCMonth: {
    value: function setUTCMonth(...args: number[]) {
      const days = getUTCDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      const newDate = defaults(args, [NaN, oldDate.date]);
      newDate.splice(0, 0, oldDate.year);
      return setUTCNewDate.call(this, newDate);
    },
  },
  setUTCDate: {
    value: function setUTCDate(...args: number[]) {
      const days = getUTCDaysSinceEpoch(this);
      const oldDate = days2hebrew(days);
      const newDate = [oldDate.year, oldDate.month, args[0]];
      return setUTCNewDate.call(this, newDate);
    },
  },
  toDateString: {
    value: function toDateString() {
      if (isNaN(this)) return INVALID;
      const daysSinceEpoch = getDaysSinceEpoch(this);
      return stringify(daysSinceEpoch);
    },
  },
  toString: {
    value: function toString() {
      if (isNaN(this)) return INVALID;
      return this.toDateString() + ' ' + this.toTimeString();
    },
  },
  toUTCString: {
    value: function toUTCString() {
      if (isNaN(this)) return INVALID;
      const daysSinceEpoch = getUTCDaysSinceEpoch(this);
      return stringify(daysSinceEpoch);
    },
  },
  toGMTString: {
    value: function toGMTString() {
      return this.toUTCString();
    },
  },
});

//   /* ================ Export ================ */

//   if(typeof window !== 'undefined') {
//     window.HeDate = HeDate;
//   } else if(typeof module !== 'undefined' && module.exports) {
//     module.exports = HeDate;
//   }

// })()

export { HeDate };
