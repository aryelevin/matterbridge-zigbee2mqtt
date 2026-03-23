// matterbridge-zigbee2mqtt/src/JewishCalendarSensors.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import { AccessoryDelegate } from 'homebridge-lib/AccessoryDelegate'
// import { EventEmitter } from 'node:stream';
// import { debug } from 'node:console';

import { bridgedNode, MatterbridgeEndpoint, modeSelect, powerSource } from 'matterbridge';

import { HeDate } from './heDate.js';
import { JewishCalendarSensor } from './jewishCalendarSensor.js';
import { ZigbeePlatform } from './module.js';
import { SunCalc } from './suncalc.js';

export interface JewishCalendarSensorsConfig {
  enabled: boolean;
  israel: boolean;
  shminiAtzeretInSukkot: boolean;
  candlelighting: number;
  havdalah: number;
  sefiratHaOmerCustom: string;
  threeWeeksCustom: string;
  showEves: boolean;
  offset: number;
}

/**
 * Delegate class for a HomeKit accessory, corresponding to a light device
 * or groups resource.
 *
 * @memberof AccessoryDelegate
 */
export class JewishCalendarSensors {
  private long: number;
  private lat: number;
  private config: JewishCalendarSensorsConfig;
  public sensor: MatterbridgeEndpoint;
  private gDate: Date;
  private hDate: HeDate;
  private sunset: Date;
  private hebrewMonths: { [key: string]: number };
  private services: { [key: string]: JewishCalendarSensor };

  /**
   * Instantiate a delegate for an accessory corresponding to a device.
   *
   * @param {ZigbeePlatform} platform - The platform.
   * @param {JewishCalendarSensorsConfig} jewishCalendarConfig - The config.
   */
  constructor(platform: ZigbeePlatform, jewishCalendarConfig: JewishCalendarSensorsConfig) {
    this.lat = platform.config.homeLocation.latitude; // parseFloat(platform.config.homeLocationCoords.latitude);
    this.long = platform.config.homeLocation.longitude; // parseFloat(platform.config.homeLocationCoords.longitude);

    this.config = jewishCalendarConfig;

    // Just initialize, its being set on the method updateJewishDay() at the end of this contsructor...
    this.gDate = new Date();
    this.hDate = new HeDate(this.gDate);
    this.sunset = new Date();
    this.hebrewMonths = {};

    this.services = {};

    this.sensor = new MatterbridgeEndpoint([bridgedNode, modeSelect, powerSource], { id: 'Jewish Calendar' }, platform.config.debug);
    this.sensor.createDefaultIdentifyClusterServer().createDefaultPowerSourceWiredClusterServer();
    this.sensor.createDefaultBasicInformationClusterServer('Jewish Calendar', '0x88030475', 4874, 'AL Systems', 77, 'Jewish Calendar 20EBN9901', 1144, '1.2.8');
    // this.sensor.createDefaultBooleanStateClusterServer(true);
    const testSensorItems = [
      { label: 'Off', mode: 0, semanticTags: [] },
      { label: 'Shabbat', mode: 1, semanticTags: [] },
      { label: 'Yom Tov', mode: 2, semanticTags: [] },
      { label: 'Kodesh', mode: 3, semanticTags: [] },
      { label: 'Rosh Hashana', mode: 4, semanticTags: [] },
      { label: 'Yom Kippur', mode: 5, semanticTags: [] },
      { label: 'Sukkot', mode: 6, semanticTags: [] },
      { label: 'Shemini Atzeret', mode: 7, semanticTags: [] },
      { label: 'Chanukah', mode: 8, semanticTags: [] },
      { label: 'Purim', mode: 9, semanticTags: [] },
      { label: 'Shushan Purim', mode: 10, semanticTags: [] },
      { label: 'Purim Meshulash', mode: 11, semanticTags: [] },
      { label: 'Pesach', mode: 12, semanticTags: [] },
      { label: 'Shvihi Shel Pesach', mode: 13, semanticTags: [] },
      { label: 'Shavuot', mode: 14, semanticTags: [] },
      { label: 'Three Weeks', mode: 15, semanticTags: [] },
      { label: 'Sefirat HaOmer Mourning', mode: 16, semanticTags: [] },
      { label: 'Sefirat HaOmer', mode: 17, semanticTags: [] },
      { label: 'Mourning', mode: 18, semanticTags: [] },
      { label: 'Leap Year', mode: 19, semanticTags: [] },
    ];
    if (this.config.showEves) {
      testSensorItems.push(
        { label: 'Shabbat Eve', mode: 20, semanticTags: [] },
        { label: 'Yom Tov Eve', mode: 21, semanticTags: [] },
        { label: 'Kodesh Eve', mode: 22, semanticTags: [] },
        { label: 'Rosh Hashana Eve', mode: 23, semanticTags: [] },
        { label: 'Yom Kippur Eve', mode: 24, semanticTags: [] },
        { label: 'Sukkot Eve', mode: 25, semanticTags: [] },
        { label: 'Shemini Atzeret Eve', mode: 26, semanticTags: [] },
        { label: 'Chanukah Eve', mode: 27, semanticTags: [] },
        { label: 'Purim Eve', mode: 28, semanticTags: [] },
        { label: 'Shushan Purim Eve', mode: 29, semanticTags: [] },
        { label: 'Purim Meshulash Eve', mode: 30, semanticTags: [] },
        { label: 'Pesach Eve', mode: 31, semanticTags: [] },
        { label: 'Shvihi Shel Pesach Eve', mode: 32, semanticTags: [] },
        { label: 'Shavuot Eve', mode: 33, semanticTags: [] },
      );
    }
    this.sensor.createDefaultModeSelectClusterServer('Test Sensor', testSensorItems, 0, 0);

    this.services.Shabbat = new JewishCalendarSensor(this.sensor, { name: 'Shabbat', debug: platform.config.debug });
    this.services.YomTov = new JewishCalendarSensor(this.sensor, { name: 'Yom Tov', debug: platform.config.debug });
    this.services.Kodesh = new JewishCalendarSensor(this.sensor, { name: 'Kodesh', debug: platform.config.debug }); // primary service
    this.services.RoshHashana = new JewishCalendarSensor(this.sensor, { name: 'Rosh Hashana', debug: platform.config.debug });
    this.services.YomKippur = new JewishCalendarSensor(this.sensor, { name: 'Yom Kippur', debug: platform.config.debug });
    this.services.Sukkot = new JewishCalendarSensor(this.sensor, { name: 'Sukkot', debug: platform.config.debug });
    this.services.SheminiAtzeret = new JewishCalendarSensor(this.sensor, { name: 'Shemini Atzeret', debug: platform.config.debug });
    this.services.Chanukah = new JewishCalendarSensor(this.sensor, { name: 'Chanukah', debug: platform.config.debug });
    this.services.Purim = new JewishCalendarSensor(this.sensor, { name: 'Purim', debug: platform.config.debug });
    this.services.ShushanPurim = new JewishCalendarSensor(this.sensor, { name: 'Shushan Purim', debug: platform.config.debug });
    this.services.PurimMeshulash = new JewishCalendarSensor(this.sensor, { name: 'Purim Meshulash', debug: platform.config.debug });
    this.services.Pesach = new JewishCalendarSensor(this.sensor, { name: 'Pesach', debug: platform.config.debug });
    this.services.ShvihiShelPesach = new JewishCalendarSensor(this.sensor, { name: 'Shvihi Shel Pesach', debug: platform.config.debug });
    this.services.Shavuot = new JewishCalendarSensor(this.sensor, { name: 'Shavuot', debug: platform.config.debug });
    this.services.ThreeWeeks = new JewishCalendarSensor(this.sensor, { name: 'Three Weeks', debug: platform.config.debug });
    this.services.SefiratHaOmerMourning = new JewishCalendarSensor(this.sensor, { name: 'Sefirat HaOmer Mourning', debug: platform.config.debug });
    this.services.SefiratHaOmer = new JewishCalendarSensor(this.sensor, { name: 'Sefirat HaOmer', debug: platform.config.debug });
    this.services.Mourning = new JewishCalendarSensor(this.sensor, { name: 'Mourning', debug: platform.config.debug });
    this.services.LeapYear = new JewishCalendarSensor(this.sensor, { name: 'Leap Year', debug: platform.config.debug });
    if (this.config.showEves) {
      this.services.ShabbatEve = new JewishCalendarSensor(this.sensor, { name: 'Shabbat Eve', debug: platform.config.debug });
      this.services.YomTovEve = new JewishCalendarSensor(this.sensor, { name: 'Yom Tov Eve', debug: platform.config.debug });
      this.services.KodeshEve = new JewishCalendarSensor(this.sensor, { name: 'Kodesh Eve', debug: platform.config.debug });
      this.services.RoshHashanaEve = new JewishCalendarSensor(this.sensor, { name: 'Rosh Hashana Eve', debug: platform.config.debug });
      this.services.YomKippurEve = new JewishCalendarSensor(this.sensor, { name: 'Yom Kippur Eve', debug: platform.config.debug });
      this.services.SukkotEve = new JewishCalendarSensor(this.sensor, { name: 'Sukkot Eve', debug: platform.config.debug });
      this.services.SheminiAtzeretEve = new JewishCalendarSensor(this.sensor, { name: 'Shemini Atzeret Eve', debug: platform.config.debug });
      this.services.ChanukahEve = new JewishCalendarSensor(this.sensor, { name: 'Chanukah Eve', debug: platform.config.debug });
      this.services.PurimEve = new JewishCalendarSensor(this.sensor, { name: 'Purim Eve', debug: platform.config.debug });
      this.services.ShushanPurimEve = new JewishCalendarSensor(this.sensor, { name: 'Shushan Purim Eve', debug: platform.config.debug });
      this.services.PurimMeshulashEve = new JewishCalendarSensor(this.sensor, { name: 'Purim Meshulash Eve', debug: platform.config.debug });
      this.services.PesachEve = new JewishCalendarSensor(this.sensor, { name: 'Pesach Eve', debug: platform.config.debug });
      this.services.ShvihiShelPesachEve = new JewishCalendarSensor(this.sensor, { name: 'Shvihi Shel Pesach Eve', debug: platform.config.debug });
      this.services.ShavuotEve = new JewishCalendarSensor(this.sensor, { name: 'Shavuot Eve', debug: platform.config.debug });
    }

    const sensorsByIndex: JewishCalendarSensor[] = [
      this.services.Shabbat,
      this.services.YomTov,
      this.services.Kodesh,
      this.services.RoshHashana,
      this.services.YomKippur,
      this.services.Sukkot,
      this.services.SheminiAtzeret,
      this.services.Chanukah,
      this.services.Purim,
      this.services.ShushanPurim,
      this.services.PurimMeshulash,
      this.services.Pesach,
      this.services.ShvihiShelPesach,
      this.services.Shavuot,
      this.services.ThreeWeeks,
      this.services.SefiratHaOmerMourning,
      this.services.SefiratHaOmer,
      this.services.Mourning,
      this.services.LeapYear,
    ];
    if (this.config.showEves) {
      sensorsByIndex.push(
        this.services.ShabbatEve,
        this.services.YomTovEve,
        this.services.KodeshEve,
        this.services.RoshHashanaEve,
        this.services.YomKippurEve,
        this.services.SukkotEve,
        this.services.SheminiAtzeretEve,
        this.services.ChanukahEve,
        this.services.PurimEve,
        this.services.ShushanPurimEve,
        this.services.PurimMeshulashEve,
        this.services.PesachEve,
        this.services.ShvihiShelPesachEve,
        this.services.ShavuotEve,
      );
    }
    let currentMode = 0;
    this.sensor.addCommandHandler('changeToMode', async ({ request: { newMode } }) => {
      this.sensor?.log.info(`Command changeToMode called request ${newMode}`);
      if (currentMode !== 0) {
        sensorsByIndex[currentMode - 1].testMode = false;
      }
      if (newMode !== 0) {
        sensorsByIndex[newMode - 1].testMode = true;
      }
      currentMode = newMode;
    });

    // this.identify()

    this.updateJewishDay();
    // this.updateSensors();
    // setTimeout(this.updateLoop.bind(this), 30000);

    // setTimeout(() => {
    //   this.updateLoop();
    // }, 30000);
    process.nextTick(() => {
      this.updateLoop();
    });

    // setImmediate(() => {
    //   this.debug('initialised');
    //   this.emit('initialised');
    // });

    // return Object.values(this.services);
  }

  async updateSensors() {
    if (!this.sensor.plugin) {
      return;
    }
    await this.services.Shabbat.update(this.isShabbat());
    await this.services.YomTov.update(this.isYomTov());
    await this.services.Kodesh.update(this.isKodesh());
    await this.services.RoshHashana.update(this.isRoshHashana());
    await this.services.YomKippur.update(this.isYomKippur());
    await this.services.Sukkot.update(this.isSukkot());
    await this.services.SheminiAtzeret.update(this.isSheminiAtzeret());
    await this.services.Chanukah.update(this.isChanukah());
    await this.services.Purim.update(this.isPurim());
    await this.services.ShushanPurim.update(this.isShushanPurim());
    await this.services.PurimMeshulash.update(this.isPurimMeshulash());
    await this.services.Pesach.update(this.isPesach());
    await this.services.ShvihiShelPesach.update(this.isShvihiShelPesach());
    await this.services.Shavuot.update(this.isShavuot());
    await this.services.ThreeWeeks.update(this.isThreeWeeks());
    await this.services.SefiratHaOmerMourning.update(this.isSefiratHaOmerMourning());
    await this.services.SefiratHaOmer.update(this.isSefiratHaOmer());
    await this.services.Mourning.update(this.isMourning());
    await this.services.LeapYear.update(this.isLeapYear());
    if (this.config.showEves) {
      await this.services.ShabbatEve.update(this.isShabbatEve());
      await this.services.YomTovEve.update(this.isYomTovEve());
      await this.services.KodeshEve.update(this.isKodeshEve());
      await this.services.RoshHashanaEve.update(this.isRoshHashanaEve());
      await this.services.YomKippurEve.update(this.isYomKippurEve());
      await this.services.SukkotEve.update(this.isSukkotEve());
      await this.services.SheminiAtzeretEve.update(this.isSheminiAtzeretEve());
      await this.services.ChanukahEve.update(this.isChanukahEve());
      await this.services.PurimEve.update(this.isPurimEve());
      await this.services.ShushanPurimEve.update(this.isShushanPurimEve());
      await this.services.PurimMeshulashEve.update(this.isPurimMeshulashEve());
      await this.services.PesachEve.update(this.isPesachEve());
      await this.services.ShvihiShelPesachEve.update(this.isShvihiShelPesachEve());
      await this.services.ShavuotEve.update(this.isShavuotEve());
    }
  }

  updateJewishDay() {
    this.gDate = new Date();
    if (typeof this.config.offset !== 'undefined' && this.config.offset !== 0) {
      this.sensor.log.debug('Shifting the time by ' + this.config.offset + ' minutes.');
      this.gDate = new Date(this.gDate.getTime() + this.config.offset * 60000);
    }
    this.sensor.log.debug('Test date is ' + this.gDate.toISOString());
    this.hDate = new HeDate(this.gDate);

    // Extremely weird bug in Suncalc has it calculate the wrong times at edges of the day. Workaround is to always check at noon
    const midday = new Date(this.gDate.getFullYear(), this.gDate.getMonth(), this.gDate.getDate(), 12, 0, 0, 0);

    // For debugging, track them both
    this.sensor.log.debug('updateJewishDay():  today=' + this.gDate.toISOString());
    this.sensor.log.debug('updateJewishDay(): midday=' + midday.toISOString());

    const suntimes = SunCalc.getTimes(midday, this.lat, this.long);
    this.sunset = suntimes.sunsetStart;

    this.sensor.log.debug('Sunset Tonight: ' + this.sunset.toLocaleString());

    // Note, this is for programming. In non leap years, Adar1 and Adar2 are BOTH 5. Month is zero indexed.
    this.hebrewMonths = { Tishri: 0, Heshvan: 1, Kislev: 2, Tevet: 3, Shevat: 4, Adar1: 5 };
    const thisYear = this.hDate.getFullYear();
    this.hebrewMonths.Adar2 = new HeDate(thisYear + 1, -7).getMonth();
    this.hebrewMonths.Nisan = new HeDate(thisYear + 1, -6).getMonth();
    this.hebrewMonths.Iyar = new HeDate(thisYear + 1, -5).getMonth();
    this.hebrewMonths.Sivan = new HeDate(thisYear + 1, -4).getMonth();
    this.hebrewMonths.Tamuz = new HeDate(thisYear + 1, -3).getMonth();
    this.hebrewMonths.Av = new HeDate(thisYear + 1, -2).getMonth();
    this.hebrewMonths.Elul = new HeDate(thisYear + 1, -1).getMonth();

    this.sensor.log.debug("This Year's Hebrew Months: ");
    this.sensor.log.debug(JSON.stringify(this.hebrewMonths));
  }

  updateLoop() {
    // var today = new Date();
    // if (
    //   (this.gDate.getFullYear() != today.getFullYear()) ||
    //   (this.gDate.getMonth() != today.getMonth()) ||
    //   (this.gDate.getDate() != today.getDate())
    // ) {
    this.updateJewishDay();
    // }

    this.updateSensors();
    // setTimeout(this.updateLoop.bind(this), 30000);

    setTimeout(() => {
      this.updateLoop();
    }, 30000);
  }

  isShabbatEve() {
    const day = this.gDate.getDay();
    const candletime = new Date(this.sunset);
    candletime.setMinutes(this.sunset.getMinutes() - this.config.candlelighting);

    const havdalahtime = new Date(this.sunset);
    havdalahtime.setMinutes(this.sunset.getMinutes() + this.config.havdalah);
    return (4 == day && this.gDate > candletime) || (5 == day && this.gDate < havdalahtime);
  }

  isShabbat() {
    const day = this.gDate.getDay();
    const candletime = new Date(this.sunset);
    candletime.setMinutes(this.sunset.getMinutes() - this.config.candlelighting);

    const havdalahtime = new Date(this.sunset);
    havdalahtime.setMinutes(this.sunset.getMinutes() + this.config.havdalah);
    return (5 == day && this.gDate > candletime) || (6 == day && this.gDate < havdalahtime);
  }

  isRoshHashanaEve() {
    if (this.hDate.getMonth() == this.hebrewMonths.Elul && this.hDate.getDate() == 28) {
      const candletime = new Date(this.sunset);
      candletime.setMinutes(this.sunset.getMinutes() - this.config.candlelighting);
      return this.gDate > candletime;
    }
    return false;
  }

  isRoshHashana() {
    // Because of year wraps, if it's Elul 29, we check candle lighting, otherwise, use normal DateRange
    if (this.hDate.getMonth() == this.hebrewMonths.Elul && this.hDate.getDate() == 29) {
      const candletime = new Date(this.sunset);
      candletime.setMinutes(this.sunset.getMinutes() - this.config.candlelighting);
      return this.gDate > candletime;
    }
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Tishri, date: 0 }, { month: this.hebrewMonths.Tishri, date: 2 });
  }

  isYomKippurEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Tishri, date: 8 }, { month: this.hebrewMonths.Tishri, date: 9 });
  }

  isYomKippur() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Tishri, date: 9 }, { month: this.hebrewMonths.Tishri, date: 10 });
  }

  isSukkotEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Tishri, date: 13 }, { month: this.hebrewMonths.Tishri, date: 14 });
  }

  isSukkot() {
    const begin = { month: this.hebrewMonths.Tishri, date: 14 };
    const end = !this.config.israel && this.config.shminiAtzeretInSukkot ? { month: this.hebrewMonths.Tishri, date: 22 } : { month: this.hebrewMonths.Tishri, date: 21 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isSheminiAtzeretEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Tishri, date: 20 }, { month: this.hebrewMonths.Tishri, date: 21 });
  }

  isSheminiAtzeret() {
    const begin = { month: this.hebrewMonths.Tishri, date: 21 };
    const end = this.config.israel ? { month: this.hebrewMonths.Tishri, date: 22 } : { month: this.hebrewMonths.Tishri, date: 23 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  _isSukkotYomTov() {
    const begin = { month: this.hebrewMonths.Tishri, date: 14 };
    const end = this.config.israel ? { month: this.hebrewMonths.Tishri, date: 15 } : { month: this.hebrewMonths.Tishri, date: 16 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isChanukahEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Kislev, date: 23 }, { month: this.hebrewMonths.Kislev, date: 24 });
  }

  isChanukah() {
    const ChanukahEnd = new HeDate(this.hDate.getFullYear(), 2, 32);

    const begin = { month: this.hebrewMonths.Kislev, date: 24 };
    const end = { month: ChanukahEnd.getMonth(), date: ChanukahEnd.getDate() };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isPurimEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Adar2, date: 12 }, { month: this.hebrewMonths.Adar2, date: 13 });
  }

  isPurim() {
    // Leap years can make Adar2's month number "bounce" so we check for it
    const begin = { month: this.hebrewMonths.Adar2, date: 13 };
    const end = { month: this.hebrewMonths.Adar2, date: 14 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isShushanPurimEve() {
    const isPurimMeshulash = this.isPurimMeshulashYear() ? 1 : 0;
    const begin = { month: this.hebrewMonths.Adar2, date: 13 + isPurimMeshulash };
    const end = { month: this.hebrewMonths.Adar2, date: 14 + isPurimMeshulash };

    return this._inHebrewHolidayDateRange(begin, end);
  }

  isShushanPurim() {
    // Leap years can make Adar2's month number "bounce" so we check for it
    const isPurimMeshulash = this.isPurimMeshulashYear() ? 1 : 0;
    const begin = { month: this.hebrewMonths.Adar2, date: 14 + isPurimMeshulash };
    const end = { month: this.hebrewMonths.Adar2, date: 15 + isPurimMeshulash };

    return this._inHebrewHolidayDateRange(begin, end);
  }

  isPurimMeshulashYear() {
    const shushanPurimDate = new HeDate(this.hDate.getFullYear(), this.hebrewMonths.Adar2, 15);
    const isPurimMeshulash = shushanPurimDate.getDay() === 6;
    return isPurimMeshulash;
  }

  isPurimMeshulashEve() {
    return this.isPurimMeshulashYear() && this.isPurimEve();
  }

  isPurimMeshulash() {
    // Leap years can make Adar2's month number "bounce" so we check for it
    const begin = { month: this.hebrewMonths.Adar2, date: 13 };
    const end = { month: this.hebrewMonths.Adar2, date: 16 };

    return this.isPurimMeshulashYear() && this._inHebrewHolidayDateRange(begin, end);
  }

  isPesachEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Nisan, date: 13 }, { month: this.hebrewMonths.Nisan, date: 14 });
  }

  isPesach() {
    const begin = { month: this.hebrewMonths.Nisan, date: 14 };
    const end = this.config.israel ? { month: this.hebrewMonths.Nisan, date: 21 } : { month: this.hebrewMonths.Nisan, date: 22 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isShvihiShelPesachEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Nisan, date: 19 }, { month: this.hebrewMonths.Nisan, date: 20 });
  }

  isShvihiShelPesach() {
    // Leap years can make Nisan's month number "bounce" so we check for it
    const begin = { month: this.hebrewMonths.Nisan, date: 20 };
    const end = this.config.israel ? { month: this.hebrewMonths.Nisan, date: 21 } : { month: this.hebrewMonths.Nisan, date: 22 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  _isPesachYomTov() {
    // Leap years can make Nisan's month number "bounce" so we check for it
    let begin = { month: this.hebrewMonths.Nisan, date: 14 };
    let end = this.config.israel ? { month: this.hebrewMonths.Nisan, date: 15 } : { month: this.hebrewMonths.Nisan, date: 16 };
    const firstDays = this._inHebrewHolidayDateRange(begin, end);
    begin = { month: this.hebrewMonths.Nisan, date: 20 };
    end = this.config.israel ? { month: this.hebrewMonths.Nisan, date: 21 } : { month: this.hebrewMonths.Nisan, date: 22 };
    const secondDays = this._inHebrewHolidayDateRange(begin, end);
    return firstDays || secondDays;
  }

  isSefiratHaOmer() {
    const begin = { month: this.hebrewMonths.Nisan, date: 15 };
    const end = { month: this.hebrewMonths.Sivan, date: 6 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isSefiratHaOmerMourning() {
    let begin = null;
    let end = null;
    if (this.config.sefiratHaOmerCustom == 'Ashkenazi') {
      begin = { month: this.hebrewMonths.Nisan, date: 15 };
      end = { month: this.hebrewMonths.Iyar, date: 18 };
    } else if (this.config.sefiratHaOmerCustom == 'Sephardic') {
      begin = { month: this.hebrewMonths.Nisan, date: 15 };
      end = { month: this.hebrewMonths.Iyar, date: 19 };
    } else if (this.config.sefiratHaOmerCustom == 'Iyar') {
      begin = { month: this.hebrewMonths.Nisan, date: 29 };
      end = { month: this.hebrewMonths.Sivan, date: 3 };
    } else if (this.config.sefiratHaOmerCustom == 'Iyar2') {
      begin = { month: this.hebrewMonths.Iyar, date: 2 };
      end = { month: this.hebrewMonths.Sivan, date: 5 };
    }
    if (begin && end) {
      return this._inHebrewHolidayDateRange(begin, end);
    }
    return false;
  }

  isShavuotEve() {
    return this._inHebrewHolidayDateRange({ month: this.hebrewMonths.Sivan, date: 4 }, { month: this.hebrewMonths.Sivan, date: 5 });
  }

  isShavuot() {
    // Leap years can make Sivan's month number "bounce" so we check for it
    const begin = { month: this.hebrewMonths.Sivan, date: 5 };
    const end = this.config.israel ? { month: this.hebrewMonths.Sivan, date: 6 } : { month: this.hebrewMonths.Sivan, date: 7 };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  isThreeWeeks() {
    let begin = null;
    if (this.config.threeWeeksCustom == 'Ashkenazi') {
      begin = { month: this.hebrewMonths.Tamuz, date: 16 }; // night before Erev 17th of Tamuz
    } else if (this.config.threeWeeksCustom == 'Sephardic') {
      begin = { month: this.hebrewMonths.Tamuz, date: 29 };
    }
    const Av9 = new HeDate(this.hDate.getFullYear(), this.hebrewMonths.Av, 9);
    const endDate = Av9.getDay() == 6 ? 11 : 10; // Includes day after Fast.
    const end = { month: this.hebrewMonths.Av, date: endDate };
    return begin ? this._inHebrewHolidayDateRange(begin, end) : false;
  }

  isYomTovEve() {
    const holidaysEve =
      this.isRoshHashanaEve() ||
      this.isYomKippurEve() ||
      this.isSukkotEve() ||
      this.isSheminiAtzeretEve() ||
      this.isPesachEve() ||
      this.isShvihiShelPesachEve() ||
      this.isShavuotEve();
    return holidaysEve;
  }

  isYomTov() {
    const holidays = this.isRoshHashana() || this.isYomKippur() || this._isSukkotYomTov() || this.isSheminiAtzeret() || this._isPesachYomTov() || this.isShavuot();
    return holidays;
  }

  isKodeshEve() {
    return this.isShabbatEve() || this.isYomTovEve();
  }

  isKodesh() {
    return this.isShabbat() || this.isYomTov();
  }

  isMourning() {
    return this.isSefiratHaOmerMourning() || this.isThreeWeeks();
  }

  isLeapYear() {
    return this.hebrewMonths.Adar2 !== this.hebrewMonths.Adar1;
  }

  _inHebrewHolidayDateRange(erev: { month: number; date: number }, end: { month: number; date: number }) {
    // Assumes that all ranges are within the same Hebraic year.
    // We COULD support wrap arounds, but it is only needed for Rosh Hashana
    // Handled there as a special case rule

    const candletime = new Date(this.sunset);
    candletime.setMinutes(this.sunset.getMinutes() - this.config.candlelighting);

    const havdalahtime = new Date(this.sunset);
    havdalahtime.setMinutes(this.sunset.getMinutes() + this.config.havdalah);

    const todayHebrewMonth = this.hDate.getMonth();
    const todayHebrewDate = this.hDate.getDate();
    // Date should be in the format {month, date}
    if (todayHebrewMonth == erev.month && todayHebrewDate == erev.date) {
      // First Day -- true after sunset
      return this.gDate > candletime;
    } else if (todayHebrewMonth == end.month && todayHebrewDate == end.date) {
      // Last Day -- true until sunset
      return this.gDate < havdalahtime;
    } else if (
      (todayHebrewMonth > erev.month || (todayHebrewMonth == erev.month && todayHebrewDate > erev.date)) &&
      (todayHebrewMonth < end.month || (todayHebrewMonth == end.month && todayHebrewDate < end.date))
    ) {
      return true;
    } else {
      // Not in the middle
      return false;
    }
  }
}
