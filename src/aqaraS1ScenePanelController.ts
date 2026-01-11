// import * as fs from 'node:fs';
import * as https from 'node:https';
// import * as http from 'node:http';
// import * as url from 'node:url';
// import * as qs from 'node:querystring';
// import * as path from 'node:path';
// import { ClientRequest, IncomingMessage } from 'node:http';

import { AnsiLogger, TimestampFormat, LogLevel } from 'node-ansi-logger';
import { MatterbridgeEndpoint } from 'matterbridge';
import { BridgedDeviceBasicInformation, ColorControl, LevelControl, OnOff, Thermostat, WindowCovering } from 'matterbridge/matter/clusters';
import { EndpointNumber } from 'matterbridge/matter';
import { deepCopy, deepEqual } from 'matterbridge/utils';

import { ZigbeePlatform } from './module.js';
import { ZigbeeEntity } from './entity.js';
// import { nextTick } from 'node:process';
import { Payload, PayloadValue } from './payloadTypes.js';

// import { xyToHsl } from 'matterbridge/utils';

type AqaraS1ScenePanelLightType = 'ct' | 'color' | 'dimmable' | 'onoff';
type AqaraS1ScenePanelCurtainType = 'curtain' | 'roller';
type AqaraS1ScenePanelACModes = 'cool' | 'heat' | 'dry' | 'fan' | 'auto';
type AqaraS1ScenePanelFanModes = 'low' | 'medium' | 'high' | 'auto';

interface AqaraS1ScenePanelControlledDeviceConfig {
  enabled: boolean;
  name: string;
  endpoints: string[];
}

interface AqaraS1ScenePanelLightConfig extends AqaraS1ScenePanelControlledDeviceConfig {
  type: AqaraS1ScenePanelLightType;
}

interface AqaraS1ScenePanelCurtainConfig extends AqaraS1ScenePanelControlledDeviceConfig {
  type: AqaraS1ScenePanelCurtainType;
}

interface AqaraS1ScenePanelACConfig extends AqaraS1ScenePanelControlledDeviceConfig {
  internal_thermostat: boolean;
  modes: AqaraS1ScenePanelACModes[];
  fan_modes: AqaraS1ScenePanelFanModes[];
  temperature_ranges: { [key in AqaraS1ScenePanelACModes]: { lowest: number, highest: number } };
}

// interface AqaraS1ScenePanelTemperatureSensorConfig extends AqaraS1ScenePanelControlledDeviceConfig {
// }

interface AqaraS1ScenePanelSceneConfig {
  enabled: boolean;
  name: string;
  icon: number;
  execute?: { [key: string]: { [key: string]: string } };
}

export interface AqaraS1ScenePanelConfig {
  light_1?: AqaraS1ScenePanelLightConfig;
  light_2?: AqaraS1ScenePanelLightConfig;
  light_3?: AqaraS1ScenePanelLightConfig;
  light_4?: AqaraS1ScenePanelLightConfig;
  light_5?: AqaraS1ScenePanelLightConfig;
  ac?: AqaraS1ScenePanelACConfig;
  curtain_1?: AqaraS1ScenePanelCurtainConfig;
  curtain_2?: AqaraS1ScenePanelCurtainConfig;
  curtain_3?: AqaraS1ScenePanelCurtainConfig;
  temperature_sensor?: AqaraS1ScenePanelControlledDeviceConfig; // TODO: After implementation use its own type (see commented one above)...
  scene_1?: AqaraS1ScenePanelSceneConfig;
  scene_2?: AqaraS1ScenePanelSceneConfig;
  scene_3?: AqaraS1ScenePanelSceneConfig;
  scene_4?: AqaraS1ScenePanelSceneConfig;
  scene_5?: AqaraS1ScenePanelSceneConfig;
  scene_6?: AqaraS1ScenePanelSceneConfig;
}

type AqaraS1ScenePanelConfigKey = keyof AqaraS1ScenePanelConfig;

interface AqaraS1ScenePanelConfigCommand {
  commandsToExecute: string[];
  commandsData: string[];
  meta: {
    index: number;
    deviceIndex: number;
    panelIeeeAddresss: string;
    failureCount: number;
  };
}

const AqaraS1ScenePanelSceneConfigDeviceIndex = 999;

export class AqaraS1ScenePanelController {
  public log: AnsiLogger;
  panelsToEndpoints: { [key: string]: string[] } = {}; // ieee_address of a panel -> [controlled device ieee_address, ...]
  endpointsToPanels: { [key: string]: string[] } = {}; // ieee_address of a controlled device -> [panel ieee_address, ...]
  allPanels: string[] = []; // array of all panels ieee_addresses
  lastWeatherData = { temperature: -1, humidity: -1, weathercode: -1, uvindex: -1 };
  platform: ZigbeePlatform;
  configurationCommandsToExecute: AqaraS1ScenePanelConfigCommand[] = [];
  lastCommandTimeout: NodeJS.Timeout | undefined = undefined;
  aqaraS1ActionsConfigData: { [key: string]: AqaraS1ScenePanelConfig };
  aqaraS1ExecutedConfigurationsData?: { [key: string]: { [key: string]: string[] | { [key: number]: string } } };
  lastCommunications: { [key: string]: PayloadValue } = {};
  lastStates: { [key: string]: Payload } = {};

  constructor(platform: ZigbeePlatform, actionConfig: { [key: string]: AqaraS1ScenePanelConfig }) {
    this.platform = platform;
    this.aqaraS1ActionsConfigData = actionConfig;

    this.log = new AnsiLogger({
      logName: 'AqaraS1ScenePanelController',
      logTimestampFormat: TimestampFormat.TIME_MILLIS,
      logLevel: platform.config.debug ? LogLevel.DEBUG : platform.log.logLevel,
    });
    this.log.debug(`Loaded: AqaraS1ScenePanelController`);
    this.log.debug('aqaraS1ActionsConfigData contents: ' + JSON.stringify(this.aqaraS1ActionsConfigData));
  }

  async saveContext() {
    await this.platform.context?.set('aqaraS1ExecutedConfigurationsData', this.aqaraS1ExecutedConfigurationsData);
  }

  // deviceEndpointPath is the device IEEE address with the endpoint, data is the changed state
  // for example, if the deviceEndpointPath is: /0x541234567890abcd/state_left and data is 'ON', then it means that a device with childEndpoint named state_left have turned on.
  switchStateChanged(deviceIeee: string, key: string, value: string | number | boolean, newPayload: Payload) {
    let endpointName = '';
    const keyComponents = key.split('_');
    if (keyComponents.length > 1 && key !== 'color_temp' && key !== 'color_mode') {
      endpointName = '/' + keyComponents[keyComponents.length - 1];
    }
    const linkedPanels = this.endpointsToPanels[deviceIeee + endpointName];
    if (linkedPanels?.length) {
      if (key.startsWith('state')) {
        const lightEntity = this.getDeviceEntity(deviceIeee);
        if (lightEntity) this.sendLightStateToPanels(lightEntity, linkedPanels, '04010055', '000000' + (value === 'ON' ? 1 : 0).toString(16).padStart(2, '0'), 'state');
      } else if (key.startsWith('brightness')) {
        const lightEntity = this.getDeviceEntity(deviceIeee);
        if (lightEntity) this.sendLightStateToPanels(lightEntity, linkedPanels, '0e010055', '000000' + (Math.round((value as number) / 2.54)).toString(16).padStart(2, '0'), 'brightness');
      } else if (key.startsWith('color_temp')) {
        const lightEntity = this.getDeviceEntity(deviceIeee);
        if (lightEntity) this.sendLightStateToPanels(lightEntity, linkedPanels, '0e020055', '0000' + value.toString(16).padStart(4, '0'), 'color_temp');
      } else if (key.startsWith('color')) {
        const color = newPayload.color as { [key: string]: number };
        const colorX = color?.x;
        const colorY = color?.y;
        const lightEntity = this.getDeviceEntity(deviceIeee);
        if (lightEntity) this.sendLightStateToPanels(lightEntity, linkedPanels, '0e080055', Math.round(colorX * 65535).toString(16).padStart(4, '0') + Math.round(colorY * 65535).toString(16).padStart(4, '0'), 'color');
      }
    }
  }

  getDeviceEntity(ieee_address: string) {
    const entity = ieee_address.startsWith('group-')
      ? this.platform.zigbeeEntities?.find((entity) => entity.group?.id === Number(ieee_address.split('-')[1]))
      : this.platform.zigbeeEntities?.find((entity) => entity.device?.ieee_address === ieee_address);
    return entity;
  }

  publishCommand(device_ieee_address: string, payload: Payload) {
    this.platform.publish(device_ieee_address, 'set', JSON.stringify(payload));
  }

  updateWeather() {
    const updateWeatherEvery = 300; // Seconds!!! // 900 is 15 minutes
    if (this.allPanels.length) {
      const casigningcert = /* this._configJson.caFile ? fs.readFileSync(this._configJson.caFile) : */ undefined;
      // https.get('https://api.open-meteo.com/v1/forecast?latitude=32.08934&longitude=34.83760&hourly=relativehumidity_2m,uv_index&current_weather=true&forecast_days=1', casigningcert ? {ca: casigningcert} : {}, res => {
      https.get('https://api.open-meteo.com/v1/forecast?latitude=' + this.platform.config.homeLocation.latitude + '&longitude=' + this.platform.config.homeLocation.longitude + '&hourly=relativehumidity_2m,uv_index&current_weather=true&forecast_days=1', casigningcert ? { ca: casigningcert } : {}, (res) => {
            const data: Uint8Array[] = [];
            const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date';
            this.log.debug('Status Code:', res.statusCode);
            this.log.debug('Date in Response header:', headerDate);

            res.on('data', (chunk) => {
              data.push(chunk);
            });

            res.on('end', () => {
              this.log.info('Response ended');
              try {
                const parsedData = JSON.parse(Buffer.concat(data).toString());
                if (parsedData) {
                  if (!parsedData.error && this.platform.z2mBridgeInfo?.coordinator.ieee_address) {
                    // The panel wordings is: {0: 'Sunny', 1: 'Clear', 2: 'Fair', 3: 'Fair', 4: 'Cloudy', 5: 'Partly Cloudy', 6: 'Partly Cloudy', 7: 'Mostly Cloudy', 8: 'Mostly Cloudy', 9: 'Overcast', 10: 'Shower', 11: 'Thundershower', 12: 'Hail', 13: 'Light Rain', 14: 'Moderate Rain', 15: 'Heavy Rain', 16: 'Storm', 17: 'Heavy Storm', 18: 'Severe Storm', 19: 'Ice Rain', 20: 'Sleet', 21: 'Snow Flurry', 22: 'Light Snow', 23: 'Moderate Snow', 24: 'Heavy Snow', 25: 'Snowstorm', 26: 'Dust', 27: 'Sand', 28: 'Duststorm', 29: 'Sandstorm', 30: 'Foggy', 31: 'Haze', 32: 'Windy', 33: 'Blustery', 34: 'Hurricane', 35: 'Tropical Storm', 36: 'Tornado', 37: 'Cold', 38: 'Hot', 39: '--'}
                    const wmoWeatherInterpretationCodesToPanelCodes: { [key: number]: number } = {
                      0: 1,
                      1: 2,
                      2: 5,
                      3: 9,
                      45: 30,
                      48: 30,
                      51: 10,
                      53: 10,
                      55: 11,
                      56: 12,
                      57: 12,
                      61: 13,
                      63: 14,
                      65: 15,
                      66: 19,
                      67: 20,
                      71: 22,
                      73: 23,
                      75: 24,
                      77: 25,
                      80: 16,
                      81: 17,
                      82: 18,
                      85: 24,
                      86: 25,
                      95: 37,
                      96: 37,
                      99: 37,
                    };
                    const temperature = Math.round(parsedData.current_weather?.temperature); // floor/ceil/round
                    const humidity = parsedData.hourly?.relativehumidity_2m?.[parsedData.hourly?.time?.indexOf(parsedData.current_weather?.time?.slice(0, -2) + '00')] || 0;
                    const weathercode = wmoWeatherInterpretationCodesToPanelCodes[parsedData.current_weather?.weathercode] || 39;
                    const uvindex = 4096; // 4096 Will show "!" sign and "--" instead any number
                    this.log.info('temperature: ' + temperature + ', humidity: ' + humidity + ', weathercode: ' + weathercode + '.');

                    for (let index = 0; index < this.allPanels.length; index++) {
                      const panelIeeeAddresss = this.allPanels[index];
                      if (weathercode !== this.lastWeatherData.weathercode) {
                        this.sendFeelPageDataToPanel(panelIeeeAddresss, this.platform.z2mBridgeInfo?.coordinator.ieee_address.slice(2), '0d020055', weathercode.toString(16).padStart(8, '0'));
                      }
                      // TODO: Send temperature and humidity only if no temperature sensor is configured on the panel configuration...
                      if (temperature !== this.lastWeatherData.temperature) {
                        this.sendFeelPageDataToPanel(panelIeeeAddresss, this.platform.z2mBridgeInfo?.coordinator.ieee_address.slice(2), '00040055', this.getHexFromFloat32Bit(temperature));
                      }
                      if (humidity !== this.lastWeatherData.humidity) {
                        this.sendFeelPageDataToPanel(panelIeeeAddresss, this.platform.z2mBridgeInfo?.coordinator.ieee_address.slice(2), '00050055', this.getHexFromFloat32Bit(humidity));
                      }
                      if (uvindex !== this.lastWeatherData.uvindex) {
                        this.sendFeelPageDataToPanel(panelIeeeAddresss, this.platform.z2mBridgeInfo?.coordinator.ieee_address.slice(2), '00060055', this.getHexFromFloat32Bit(uvindex));
                      }
                    }
                    this.lastWeatherData.weathercode = weathercode;
                    this.lastWeatherData.temperature = temperature;
                    this.lastWeatherData.humidity = humidity;
                    this.lastWeatherData.uvindex = uvindex;
                  } else {
                    this.log.error('Weather data fetch error, reason: ' + parsedData.reason);
                  }
                }
              } catch (error) {
                this.log.error(error as string);
              }
            });
          },
        )
        .on('error', (err) => {
          this.log.info('Error: ', err.message);
          this.log.error(err.message);
        });
    }
    setTimeout(() => {
      this.updateWeather();
    }, updateWeatherEvery * 1000);
  }

  fromHexStringToBytes = (hexString: string) => new Uint8Array(hexString.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

  toHexStringFromBytes = (bytes: number[]) => bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

  toHexStringFromCharacterString = (charStr: string) => this.toHexStringFromBytes(charStr.split('')?.map((c) => c.charCodeAt(0)) || []);

  toCharacterStringFromBytes = (bytes: number[]) => bytes.map((v) => { return String.fromCharCode(v); }).join('');

  getInt8 = (uint8Data: number) => (uint8Data << 24) >> 24;

  getUInt8 = (int8Data: number) => (int8Data << 24) >>> 24;

  getAqaraIntFromHex(hexInput: number) {
    // value to change
    let a = hexInput;

    let b = 1;
    let r = 0;

    if (a > 0) {
      r = 1;
      a -= 0x3f80;
    }

    while (a > 0) {
      const k = 0x80 / b;
      const n = Math.min(a / k, b);

      a -= k * n;
      r += n;

      b *= 2;
    }

    return r;
  }

  getAqaraHexFromInt(intInput: number) {
    // value to change
    let a = intInput;

    let b = 1;
    let r = 0;

    if (a > 0) {
      r = 0x3f80;
      a -= 1;
    }

    while (a > 0) {
      const k = 0x80 / b;
      const n = Math.min(a, b);

      a -= n;
      r += k * n;

      b *= 2;
    }

    return r;
  }

  // IEEE 754 float-hex convertions
  getFloatFromHex32Bit(hexString: string) {
    // Create an ArrayBuffer of 4 bytes (for a 32-bit float)
    const buffer = new ArrayBuffer(4);
    // Create a DataView to manipulate the buffer
    const view = new DataView(buffer);

    // Parse the hex string as an integer and set it in the DataView
    // Assumes big-endian for this example, adjust if your hex is little-endian
    view.setUint32(0, parseInt(hexString, 16), false); // false for big-endian

    // Read the float value from the DataView
    return view.getFloat32(0, false); // false for big-endian
  }

  getHexFromFloat32Bit(floatValue: number) {
    // Create an ArrayBuffer of 4 bytes (32 bits)
    const buffer = new ArrayBuffer(4);
    // Create a DataView to manipulate the buffer
    const view = new DataView(buffer);

    // Set the float value at offset 0 as a 32-bit float (IEEE 754 single precision)
    // The 'false' argument indicates little-endian byte order.
    // Change to 'true' for big-endian if needed.
    view.setFloat32(0, floatValue, false);

    // Read the 32-bit value as an unsigned integer
    const uint32 = view.getUint32(0, false);

    // Convert the unsigned integer to a hexadecimal string and pad with leading zeros
    return ('00000000' + uint32.toString(16)).slice(-8);
  }

  sendFeelPageDataToPanel(deviceIeeeAddress: string, device: string, parameter: string, content: string) {
    const dataToSend = this.generateAqaraS1ScenePanelCommands('08', device + parameter + content)[0];
    this._writeDataToPanel(deviceIeeeAddress, dataToSend);
  }

  sendStateToPanel(deviceIeeeAddress: string, device: string, parameter: string, content: string) {
    const dataToSend = this.generateAqaraS1ScenePanelCommands('05', device + parameter + content)[0];
    this._writeDataToPanel(deviceIeeeAddress, dataToSend);
  }

  _writeDataToPanel(deviceIeeeAddress: string, dataToSend: string) {
    this.log.debug('Going to set "' + dataToSend + '" at panel: ' + deviceIeeeAddress);
    this.publishCommand(deviceIeeeAddress, { communication: dataToSend });
  }

  sendACStateToPanel(deviceIeeeAddress: string, acEndpoint: MatterbridgeEndpoint) {
    let data = '';
    data += acEndpoint.uniqueId;
    this._writeDataToPanel(deviceIeeeAddress, data);
  }

  sendCoverPositionToPanel(deviceIeeeAddress: string, coverEndpoint: MatterbridgeEndpoint) {
    let data = '';
    data += coverEndpoint.uniqueId;
    this._writeDataToPanel(deviceIeeeAddress, data);
  }

  sendCoverMovementModeToPanel(deviceIeeeAddress: string, coverEndpoint: MatterbridgeEndpoint) {
    let data = '';
    data += coverEndpoint.uniqueId;
    this._writeDataToPanel(deviceIeeeAddress, data);
  }

  sendLightOnOffStateToPanel(panelIeeeAddress: string, lightNo: string, lightEndpoint: MatterbridgeEndpoint) {
    const onOff = lightEndpoint.getAttribute(OnOff.Cluster.id, 'onOff');
    this.log.info('On/Off: ' + onOff);
    this.sendLightDataToPanel(panelIeeeAddress, lightNo, '04010055', '000000' + (onOff ? 1 : 0).toString(16).padStart(2, '0'));
  }

  sendLightBrightnessStateToPanel(panelIeeeAddress: string, lightNo: string, lightEndpoint: MatterbridgeEndpoint) {
    const brightness = Math.round((lightEndpoint.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
    this.log.info('Brightness: ' + brightness);
    this.sendLightDataToPanel(panelIeeeAddress, lightNo, '0e010055', '000000' + brightness.toString(16).padStart(2, '0'));
  }

  sendLightColorTemperatureStateToPanel(panelIeeeAddress: string, lightNo: string, lightEndpoint: MatterbridgeEndpoint) {
    const colorTemperature = lightEndpoint.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
    this.log.info('Color Temperature: ' + colorTemperature);
    this.sendLightDataToPanel(panelIeeeAddress, lightNo, '0e020055', '0000' + colorTemperature.toString(16).padStart(4, '0'));
  }

  sendLightColorStateToPanel(panelIeeeAddress: string, lightNo: string, lightEndpoint: MatterbridgeEndpoint) {
    const colorX = lightEndpoint.getAttribute(ColorControl.Cluster.id, 'currentX');
    const colorY = lightEndpoint.getAttribute(ColorControl.Cluster.id, 'currentY');
    this.log.info('Color X: ' + colorX + ', Color Y: ' + colorY);
    // this.log.info('Color Hue: ' + this.values.hue + ', Color Saturation: ' + this.values.saturation);

    // const xy = hsvToXy(this.values.hue, this.values.saturation, this.capabilities.gamut)
    // this.log('Color X: ' + xy[0] + ', Color Y: ' + xy[1])
    this.sendLightDataToPanel(panelIeeeAddress, lightNo, '0e080055', Math.round(colorX * 65535).toString(16).padStart(4, '0') + Math.round(colorY * 65535).toString(16).padStart(4, '0'));
  }

  sendLightStateToPanels(originalLightEntity: ZigbeeEntity, panelsToUpdate: string[], parameter: string, content: string, valueToCheck: string, secondValueToCheck?: string) {
    if (panelsToUpdate?.length) {
      for (let i = panelsToUpdate.length - 1; i >= 0; i--) {
        const panelResourceItem = panelsToUpdate[i];
        const pathComponents = panelResourceItem.split('/');
        if (pathComponents[2].startsWith('light')) {
          const lightNo = pathComponents[2].charAt(pathComponents[2].length - 1);
          const lightsControlledWithPanelDevice = this.panelsToEndpoints[panelResourceItem];
          let shouldUpdatePanelState = true;
          for (let ii = lightsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
            const lightResourcePath = lightsControlledWithPanelDevice[ii].split('/');
            const accessoryToCheck = this.getDeviceEntity(lightResourcePath[0]); // this.gateway.platform.gatewayMap[lightResourcePath[1]].accessoryByRpath['/' + lightResourcePath[2] + '/' + lightResourcePath[3]].service
            if (accessoryToCheck) {
              if (accessoryToCheck !== originalLightEntity && accessoryToCheck.getLastPayloadItem(valueToCheck) !== undefined && ((accessoryToCheck.getLastPayloadItem(valueToCheck) !== originalLightEntity.getLastPayloadItem(valueToCheck)) || (secondValueToCheck !== undefined && accessoryToCheck.getLastPayloadItem(secondValueToCheck) !== undefined && accessoryToCheck.getLastPayloadItem(secondValueToCheck) !== originalLightEntity.getLastPayloadItem(secondValueToCheck)))) { // this.obj.state.on
                shouldUpdatePanelState = false;
                break;
              }
            }
          }

          if (shouldUpdatePanelState) {
            this.sendLightDataToPanel(pathComponents[1], lightNo, parameter, content);
          }
        }
      }
    }
  }

  sendLightDataToPanel(deviceIeeeAddress: string, lightNo: string, parameter: string, content: string) {
    this.sendStateToPanel(deviceIeeeAddress, '6c69676874732f' + parseInt(lightNo).toString(16).padStart(2, '3'), parameter, content);
  }

  sendLightOnOffToPanels(originalLightEntity: ZigbeeEntity, panelsToUpdate: string[], newOn: boolean) {
    this.sendLightStateToPanels(originalLightEntity, panelsToUpdate, '04010055', '000000' + (newOn ? 1 : 0).toString(16).padStart(2, '0'), 'on');
    // TODO: Needs to move to switchingController...
    // // Queue it for a later processing to allow any other lights to complete its on/off operation to allow anyOn be correct...
    // nextTick(() => {
    //   if (panelsToUpdate?.length) {
    //     for (let i = panelsToUpdate.length - 1; i >= 0; i--) {
    //       const panelResourceItem = panelsToUpdate[i];
    //       const pathComponents = panelResourceItem.split('/');

    //       if (pathComponents[4] === 'switch'/* && that.bridge.platform.bridgeMap[pathComponents[1]].fullState.lights[pathComponents[3]].state.on != that.hk.on */) {
    //         const lightsControlledWithPanelDevice = this.panelsToEndpoints[panelResourceItem]
    //         let anyOn = false
    //         if (newOn) {
    //           anyOn = true
    //         } else {
    //           for (let ii = lightsControlledWithPanelDevice.length - 1; ii >= 0; ii--) {
    //             const lightResourcePath = lightsControlledWithPanelDevice[ii].split('/')
    //             const accessoryToCheck = this.gateway.platform.gatewayMap[lightResourcePath[1]].accessoryByRpath['/' + lightResourcePath[2] + '/' + lightResourcePath[3]].service
    //             if (accessoryToCheck) {
    //               if (accessoryToCheck !== this && accessoryToCheck.values.on) {
    //                 anyOn = true
    //                 break
    //               }
    //             }
    //           }
    //         }

    //         if (anyOn !== this.gateway.platform.gatewayMap[pathComponents[1]].context.fullState.lights[pathComponents[3]].state.on) {
    //           const panelResourcePath = '/' + pathComponents[2] + '/' + pathComponents[3] + '/state'
    //           this.log.info('Going to set on: ' + anyOn + ' at panel: ' + panelResourcePath)
    //           this.gateway.platform.gatewayMap[pathComponents[1]].client.put(panelResourcePath, { on: anyOn }).then((obj) => {
    //             // To make sure to avoid its socket message with the attribute report...
    //             // We need to set it here at the callback of the PUT command, since we need to make sure that if more than 3 calls happens concurrently, it will be delayed and could get into on/off racing condition infinite loop. (To do this, i just need to verify that the attribute report of it happens only after the callback is triggered...)
    //             this.gateway.platform.gatewayMap[pathComponents[1]].context.fullState.lights[pathComponents[3]].state.on = anyOn
    //             this.log.info('Successfully set on: ' + anyOn + ' at panel: ' + panelResourcePath)
    //           }).catch((error) => {
    //             this.log.error('Error setting panel switch state %s: %s', panelResourcePath, error)
    //           })
    //         }
    //       }
    //     }
    //   }
    // });
  }

  async setAqaraS1PanelsConfiguration() {
    if (this.aqaraS1ExecutedConfigurationsData) {
      this.log.error('setAqaraS1PanelsConfiguration called twice, returning...');
      return;
    }

    const hasContext = await this.platform.context?.has('aqaraS1ExecutedConfigurationsData');
    if (!hasContext) {
      await this.platform.context?.set('aqaraS1ExecutedConfigurationsData', {});
    }
    this.aqaraS1ExecutedConfigurationsData = await this.platform.context?.get('aqaraS1ExecutedConfigurationsData');
    if (!this.aqaraS1ExecutedConfigurationsData) {
      this.log.error('aqaraS1ExecutedConfigurationsData not found, returning...');
      return;
    }

    // this.log(JSON.stringify(this.platform.config))
    if (this.aqaraS1ActionsConfigData) {
      const panels = Object.keys(this.aqaraS1ActionsConfigData);
      for (const panelIeee of panels) {
        if (this.allPanels.indexOf(panelIeee) < 0) { // To avoid duplicates in case of re-running the configuration
          this.allPanels.push(panelIeee);
          if (!this.lastCommunications[panelIeee]) {
            this.lastCommunications[panelIeee] = '';
            const device = this.getDeviceEntity(panelIeee);
            if (device && device.device?.model_id === 'lumi.switch.n4acn4') {
              this.platform.z2m.on('MESSAGE-' + device.entityName, (payload: Payload) => {
                if (payload.communication && payload.communication === this.lastCommunications[panelIeee]) return;
                this.panelSentData(panelIeee, payload.communication as string);
                this.lastCommunications[panelIeee] = payload.communication;
              });
            }
          }
        }
        const panelData = this.aqaraS1ActionsConfigData[panelIeee];
        const panelControls = Object.keys(panelData);
        for (const panelControl of panelControls) {
          const controlData = panelData[panelControl as AqaraS1ScenePanelConfigKey] as AqaraS1ScenePanelControlledDeviceConfig;
          if (controlData.enabled && controlData.endpoints?.length) {
            this.panelsToEndpoints['/' + panelIeee + '/' + panelControl] = controlData.endpoints;
            for (let i = controlData.endpoints.length - 1; i >= 0; i--) {
              const endpoint = controlData.endpoints[i];
              if (!this.endpointsToPanels[endpoint]) {
                this.endpointsToPanels[endpoint] = [];
              }
              this.endpointsToPanels[endpoint].push('/' + panelIeee + '/' + panelControl);
            }
          }
        }
      }

      // Now subscribe to events related to panels to be able to update panel state in case of controlled device have changed not from a panel...
      for (const endpoint in this.endpointsToPanels) {
        const deviceIeee = endpoint.split('/')[0];
        if (!this.lastStates[deviceIeee]) {
          this.lastStates[deviceIeee] = {};
          const device = this.getDeviceEntity(deviceIeee);
          if (device) {
            this.platform.z2m.on('MESSAGE-' + device.entityName, (payload: Payload) => {
              if (!payload.action && deepEqual(this.lastStates[deviceIeee], payload, ['linkquality', 'last_seen', 'communication'])) return;
              // For Zigbee2MQTT -> Settings -> Advanced -> cache_state = true
              for (const key in payload) {
                const value = payload[key];
                if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && value !== this.lastStates[deviceIeee][key]) {
                  this.log.info('Value ' + key + ' changed from ' + this.lastStates[deviceIeee][key] + ' to ' + value + '.');
                  this.switchStateChanged(deviceIeee || '', key, value, payload);
                }
              }
              // // For Zigbee2MQTT -> Settings -> Advanced -> cache_state = false
              // for (const key in payload) {
              //   const value = payload[key];
              //   if (value !== null && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')/* && value !== this.lastPayload[key]*/) {
              //     this.log.info('Value ' + key + ' changed to ' + value + '.');
              //     this.switchStateChanged(this.entityName + '/' + key, value, payload);
              //   }
              // }
              this.lastStates[deviceIeee] = deepCopy(payload);
            });
          }
        }
      }
      this.log.debug('panelsToEndpoints: ' + JSON.stringify(this.panelsToEndpoints));
      this.log.debug('endpointsToPanels: ' + JSON.stringify(this.endpointsToPanels));

      // Now, go and set online/offline for all possible devices to know if they're set on the panel, and add/remove them on the reponse.
      // if (!this.aqaraS1ExecutedConfigurationsData) {
      //   this.aqaraS1ExecutedConfigurationsData = {};
      // }

      // if (!this.configurationCommandsToExecute) {
      //   this.configurationCommandsToExecute = [];
      // }

      // Char string is:      lights/1            lights/2            lights/3            lights/4            lights/5            curtain1            curtain2            curtain3            air_cond            tempsnsr
      const devicesSerial = [
        '6c69676874732f31', // lights/1
        '6c69676874732f32', // lights/2
        '6c69676874732f33', // lights/3
        '6c69676874732f34', // lights/4
        '6c69676874732f35', // lights/5
        '6375727461696e31', // curtain1
        '6375727461696e32', // curtain2
        '6375727461696e33', // curtain3
        '6169725f636f6e64', // air_cond
        '74656d70736e7372', // tempsnsr
      ]; // array of devices serial which is configured when setup is done
      const devicesControl: AqaraS1ScenePanelConfigKey[] = ['light_1', 'light_2', 'light_3', 'light_4', 'light_5', 'curtain_1', 'curtain_2', 'curtain_3', 'ac', 'temperature_sensor']; // array of config names
      // | Temp Sensor | AC Page | Curtain 1 | Curtain 2 | Curtain 3 | Light 1 | Light 2 | Light 3 | Light 4 | Light 5 |
      // | ----------- | ------- | --------- | --------- | --------- | ------- | ------- | ------- | ------- | ------- |
      // | 01-02       | 03-08   | 09-0e     | 0f-14     | 15-1a     | 1b-20   | 21-26   | 27-2c   | 2d-32   | 33-38   |
      const slotsRanges: { [key in AqaraS1ScenePanelConfigKey]: number[] } = {
        temperature_sensor: [0x01, 0x02],
        ac: [0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        curtain_1: [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e],
        curtain_2: [0x0f, 0x10, 0x11, 0x12, 0x13, 0x14],
        curtain_3: [0x15, 0x16, 0x17, 0x18, 0x19, 0x1a],
        light_1: [0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20],
        light_2: [0x21, 0x22, 0x23, 0x24, 0x25, 0x26],
        light_3: [0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c],
        light_4: [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32],
        light_5: [0x33, 0x34, 0x35, 0x36, 0x37, 0x38],
        scene_1: [],
        scene_2: [],
        scene_3: [],
        scene_4: [],
        scene_5: [],
        scene_6: [],
      };

      const slotPrefixes: { [key in AqaraS1ScenePanelConfigKey]: string } = {
        temperature_sensor: '604a55b7',
        ac: '6044f76a',
        curtain_1: '604f651f',
        curtain_2: '604f651f',
        curtain_3: '604f651f',
        light_1: '604f7448',
        light_2: '604f7448',
        light_3: '604f7448',
        light_4: '604f7448',
        light_5: '604f7448',
        scene_1: '',
        scene_2: '',
        scene_3: '',
        scene_4: '',
        scene_5: '',
        scene_6: '',
      };

      // Char string is:     scene_01            scene_02            scene_03            scene_04            scene_05            scene_06
      const sceneSerials = ['7363656e655f3031', '7363656e655f3032', '7363656e655f3033', '7363656e655f3034', '7363656e655f3035', '7363656e655f3036'];
      const sceneControls: AqaraS1ScenePanelConfigKey[] = ['scene_1', 'scene_2', 'scene_3', 'scene_4', 'scene_5', 'scene_6'];
      const sceneIDs = ['6046990601', '6046990602', '6046990603', '6046990604', '6046990605', '6046990606'];

      const commandsFunctionsToExecute: ((index: number) => void)[] = [];

      for (const panelIeeeAddresss of panels) {
        const panelMACAddress = panelIeeeAddresss.slice(2); // From 0x54XXXXXXXXX to 54XXXXXXXXX
        const panelData = this.aqaraS1ActionsConfigData[panelIeeeAddresss];
        const panelLightObject = this.getDeviceEntity(panelIeeeAddresss);
        if (panelLightObject) {
          let parsedData = this.aqaraS1ExecutedConfigurationsData[panelIeeeAddresss];

          if (!parsedData) {
            parsedData = {};
            this.aqaraS1ExecutedConfigurationsData[panelIeeeAddresss] = parsedData;
          }
          if (!parsedData.names) {
            parsedData.names = {};
          }

          for (let i = devicesSerial.length - 1; i >= 0; i--) {
            const deviceSerial = devicesSerial[i];
            const deviceName = devicesControl[i];
            const deviceConfig = panelData[deviceName];
            const slots = slotsRanges[deviceName];
            const slotPrefix = slotPrefixes[deviceName];

            if (slots) {
              if (deviceConfig?.enabled) {
                // TODO: Check that the config haven't changed in a new config (Need to check how this is possible to be done... Maybe try to set CT/Color and see what is the response...)
                // Configuration itself consists: cmd header (as in all commands), slot prefix, slot, panel serial, controlled device serial, function id, configuration data size, some type (unknown yet), configuration commands set size (how many configuration commands is consisting the device control), some data (unknown yet), device number (to set which "page" this device is presented at), a suffix with 2 bytes (unknown yet).
                const commandsData = [];
                if (i <= 4) { // Lights
                  const lightConfig = deviceConfig as AqaraS1ScenePanelLightConfig;
                  // On/Off, general type...
                  commandsData.push(slotPrefix + slots[0].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '04010055' + '260a0' + (lightConfig.type === 'dimmable' ? '4' : '5') + '08bfaab9d8d7b4ccac08bfaab9d8d7b4ccac08bfaab9d8d7b4ccac0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '3' + (lightConfig.type === 'color' ? '2' : '3') + '00');
                  // Brightness
                  commandsData.push(slotPrefix + slots[1].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '0e010055' + '170a0' + (lightConfig.type === 'dimmable' ? '4' : '5') + '0ac1c1b6c8b0d9b7d6b1c8000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '0' + (lightConfig.type === 'color' ? '2' : '4') + '00');
                  // Name
                  commandsData.push(slotPrefix + slots[4].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa5' + '140a0' + (lightConfig.type === 'dimmable' ? '4' : '5') + '08c9e8b1b8c3fbb3c60000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '0' + (lightConfig.type === 'color' ? 'a' : 'b') + '00');
                  // Online/Offline
                  commandsData.push(slotPrefix + slots[5].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '080007fd' + '160a0' + (lightConfig.type === 'dimmable' ? '4' : '5') + '0ac9e8b1b8d4dacfdfc0eb0000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '3' + (lightConfig.type === 'color' ? 'c' : 'd') + '00');
                  if (lightConfig.type === 'ct') {
                    // Color Temperature
                    commandsData.push(slotPrefix + slots[2].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '0e020055' + '130a0506c9abcec2d6b5000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '0300');
                  } else if (lightConfig.type === 'color') {
                    // Color
                    commandsData.push(slotPrefix + slots[3].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '0e080055' + '130a0506d1d5c9ab7879000000000000015' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) - 1) + '0100');
                  }
                } else if (i <= 7) { // Curtains
                  const curtainConfig = deviceConfig as AqaraS1ScenePanelCurtainConfig;
                  // Opening/Closing/Stopped
                  // 38aa713244 0a65 02412f 64767f57 09 54ef4410000513ea 54ef44100005c83d 0e020055 150a0508b4b0c1b1d7b4ccac000000000000014 6 3300
                  commandsData.push(slotPrefix + slots[0].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '0e020055' + '150a0' + (curtainConfig.type === 'curtain' ? '4' : '5') + '08b4b0c1b1d7b4ccac000000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) + 5) + '3' + (curtainConfig.type === 'curtain' ? '2' : '3') + '00');
                  // Position
                  // 3caa713644 0665 024133 64767f57 0a 54ef4410000513ea 54ef44100005c83d 01010055 190a050000010ab4b0c1b1b4f2bfaab0d90000000000014 6 0d00
                  commandsData.push(slotPrefix + slots[1].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '01010055' + '190a0' + (curtainConfig.type === 'curtain' ? '4' : '5') + '0000010ab4b0c1b1b4f2bfaab0d90000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) + 5) + '0' + (curtainConfig.type === 'curtain' ? 'c' : 'd') + '00');
                  // Online/Offline
                  // 39aa713344 0767 024130 64767f57 0b 54ef4410000513ea 54ef44100005c83d 080007fd 160a050ac9e8b1b8d4dacfdfc0eb0000000000014 6 3e00
                  commandsData.push(slotPrefix + slots[2].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '080007fd' + '160a0' + (curtainConfig.type === 'curtain' ? '4' : '5') + '0ac9e8b1b8d4dacfdfc0eb0000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) + 5) + '3' + (curtainConfig.type === 'curtain' ? 'c' : 'e') + '00');
                  // Name
                  // 37aa713144 0868 02412e 64767f57 0c 54ef4410000513ea 54ef44100005c83d 08001fa5 140a0508c9e8b1b8c3fbb3c60000000000014 6 0b00
                  commandsData.push(slotPrefix + slots[3].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa5' + '140a0' + (curtainConfig.type === 'curtain' ? '4' : '5') + '08c9e8b1b8c3fbb3c60000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) + 5) + '0' + (curtainConfig.type === 'curtain' ? 'a' : 'b') + '00');
                  // ??? Was on setup of roller shade...
                  // 3caa713644 0962 024133 64767f57 0e 54ef4410000513ea 54ef44100005c83d 00010055 190a050000010ab4b0c1b1d4cbd0d0cab10000000000014 6 3f00
                  commandsData.push(slotPrefix + slots[5].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '00010055' + '190a050000010ab4b0c1b1d4cbd0d0cab10000000000014' + (parseInt(deviceSerial.charAt(deviceSerial.length - 1)) + 5) + '3f00');
                } else if (i === 8) { // AC
                  const acConfig = deviceConfig as AqaraS1ScenePanelACConfig;
                  // On/Off, general type...
                  commandsData.push(slotPrefix + slots[0].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + (acConfig.internal_thermostat ? '0e020055' : '0e200055') + (acConfig.internal_thermostat ? '150a0608bfd8d6c6d7b4ccac000000000000012e0000' : '1708060abfd5b5f7d1b9cbf5d7b4000000000000012e0000'));
                  // Online/Offline
                  commandsData.push(slotPrefix + slots[1].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '080007fd' + '1608060ac9e8b1b8d4dacfdfc0eb0000000000012e6400');
                  // Name
                  commandsData.push(slotPrefix + slots[2].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa5' + '14080608c9e8b1b8c3fbb3c60000000000012e1300');
                  // Modes
                  commandsData.push(slotPrefix + slots[3].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa7' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1000');
                  // Fan Modes
                  commandsData.push(slotPrefix + slots[4].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa8' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e1100');
                  // Temperatures Ranges
                  commandsData.push(slotPrefix + slots[5].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '08001fa9' + '1608060ab5b1c7b0c6a5c5e4b5c40000000000012e0100');
                } else if (i === 9) { // Temperature Sensor
                  // Temperature
                  commandsData.push(slotPrefix + slots[0].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '00010055' + '1908023e00640a74656d706572617475720000000000012c0600');
                  // Humidity
                  commandsData.push(slotPrefix + slots[1].toString(16).padStart(2, '0') + panelMACAddress + deviceSerial + '00020055' + '1708021d00640868756d69646974790000000000012c0900');
                }
                if (!parsedData[i] || JSON.stringify(parsedData[i]) !== JSON.stringify(commandsData)) {
                  const commandsToExecute = [];
                  for (let index = 0; index < commandsData.length; index++) {
                    const commandData = commandsData[index];
                    commandsToExecute.push(...this.generateAqaraS1ScenePanelCommands('02', commandData));
                  }
                  this.configurationCommandsToExecute.push({
                    commandsToExecute: commandsToExecute,
                    commandsData: commandsData,
                    meta: {
                      index: 0,
                      deviceIndex: i,
                      panelIeeeAddresss,
                      failureCount: 0,
                    },
                  });
                } else {
                  // Maybe update the state of controlled device??? No, it should be in sync if server restarted. If device restarted it asks the data by itself.
                  // Update device names if any changes...
                  if (!parsedData.names[i] || parsedData.names[i] !== deviceConfig.name) {
                    const name = deviceConfig.name;
                    const dataToSend = this.generateNameCommand(name, deviceSerial);
                    // Save a copy/references of the relevant values and separate commands with 1000ms delay...
                    const deviceIndex = i;
                    const executeCommand = (index: number) => {
                      this.log.info('Going to send: ' + dataToSend);
                      this.publishCommand(panelIeeeAddresss, { communication: dataToSend });
                      // TODO: Maybe wait for the MQTT to send it back before executing further (use it as ACK..)
                      parsedData.names[deviceIndex] = name;
                      this.saveContext();
                      if (index < commandsFunctionsToExecute.length) {
                        setTimeout(() => {
                          commandsFunctionsToExecute[index](index + 1);
                        }, 1000);
                      }
                    };
                    commandsFunctionsToExecute.push(executeCommand);
                  }
                }
              } else {
                if (parsedData[i]) {
                  // Send removal commands...
                  const commandsToExecute = [];
                  const commandsData = [];
                  for (let ii = slots.length - 1; ii >= 0; ii--) {
                    const commandData = slotPrefix + slots[ii].toString(16).padStart(2, '0') + panelMACAddress + '000000000000000000000000';
                    commandsData.push(commandData);
                    commandsToExecute.push(...this.generateAqaraS1ScenePanelCommands('04', commandData));
                  }
                  this.configurationCommandsToExecute.push({
                    commandsToExecute: commandsToExecute,
                    commandsData: commandsData,
                    meta: {
                      index: 0,
                      deviceIndex: i,
                      panelIeeeAddresss,
                      failureCount: 0,
                    },
                  });
                }
              }
            }

            // // TODO: now set all as Online, but later make sure to mark offline devices if they're offline...
            // let that = this
            // commandsAmount ++
            // setTimeout(function() {
            //   let cmdToSend = this.generateAqaraS1ScenePanelCommands('05', deviceSerial + '080007fd' + '0000000' + (panelData[devicesControl[i]] ? '1' : '0'))[0]
            //   that.log(cmdToSend)
            //   that.client.put(panel + '/config', {preset: cmdToSend}).then((obj) => {

            //   }).catch((error) => {

            //   })
            // }, 500 * commandsAmount)
          }

          // let numberOfConfiguredScenes = 0
          let unusedSceneIDs = '';
          let configuredScenesData = '';
          for (let index = 0; index < sceneControls.length; index++) {
            const sceneName = sceneControls[index];
            const sceneConfig = panelData[sceneName] as AqaraS1ScenePanelSceneConfig | undefined;
            if (sceneConfig?.enabled) {
              // numberOfConfiguredScenes++
              // TODO: trim the name to the max of what possible on the panel...
              configuredScenesData += (sceneIDs[index] + sceneSerials[index] + sceneConfig.icon.toString(16).padStart(2, '0') + sceneConfig.name.length.toString(16).padStart(2, '0') + this.toHexStringFromCharacterString(sceneConfig.name));
            } else {
              unusedSceneIDs += sceneIDs[index];
            }
          }

          const commandsToExecute = [];
          const commandsData = [];
          if (unusedSceneIDs.length) {
            commandsData.push(unusedSceneIDs);
            commandsToExecute.push(...this.generateAqaraS1ScenePanelCommands('02', unusedSceneIDs, '73'));
          }
          if (configuredScenesData.length) {
            commandsData.push(configuredScenesData);
            commandsToExecute.push(...this.generateAqaraS1ScenePanelCommands('01', configuredScenesData, '73'));
          }

          if (!parsedData[AqaraS1ScenePanelSceneConfigDeviceIndex] || JSON.stringify(parsedData[AqaraS1ScenePanelSceneConfigDeviceIndex]) !== JSON.stringify(commandsData)) {
            this.configurationCommandsToExecute.push({
              commandsToExecute: commandsToExecute,
              commandsData: commandsData,
              meta: {
                index: 0,
                deviceIndex: AqaraS1ScenePanelSceneConfigDeviceIndex,
                panelIeeeAddresss,
                failureCount: 0,
              },
            });
          }
        }
      }

      if (commandsFunctionsToExecute.length) {
        commandsFunctionsToExecute[0](1);
      }
      if (this.configurationCommandsToExecute.length) {
        this.configurationCommandTimeout(); // So it will not remove the first command...
      }
    }
    // TODO: update switches state (on/off) on the state restore of the light (file loading of the state).
  }

  configurationCommandTimeout() {
    this.lastCommandTimeout = undefined; // this will make the executeNextConfigurationCommand() function to retry the last function again...
    this.executeNextConfigurationCommand();
  }

  executeNextConfigurationCommand() {
    const succeededCommand = this.lastCommandTimeout !== undefined;
    if (succeededCommand) {
      // cancel the timeout...
      clearTimeout(this.lastCommandTimeout);
      // advance the command index and if a device is fully configured, save its data.
      const currentConfiguredDeviceCommandsArray = this.configurationCommandsToExecute.length ? this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1] : undefined;
      if (currentConfiguredDeviceCommandsArray !== undefined) {
        if (currentConfiguredDeviceCommandsArray.meta.index + 1 === currentConfiguredDeviceCommandsArray.commandsToExecute.length || currentConfiguredDeviceCommandsArray.meta.failureCount >= 3) {
          if (currentConfiguredDeviceCommandsArray.meta.failureCount < 3) {
            const deviceIndex = currentConfiguredDeviceCommandsArray.meta.deviceIndex;
            this.log.info('Finished configuration for deviceIndex ' + deviceIndex + ', Saving the sent commands in the context.');
            const parsedData = this.aqaraS1ExecutedConfigurationsData?.[currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss];
            if (parsedData) {
              if (currentConfiguredDeviceCommandsArray.commandsToExecute[0].endsWith('000000000000000000000000')) { // Its a removed configuration...
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete parsedData[deviceIndex];
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete parsedData.names[deviceIndex];
              } else {
                parsedData[deviceIndex] = currentConfiguredDeviceCommandsArray.commandsData;
              }
              this.saveContext();
            }
          }
          // Remove this device from the configuration commands array
          this.configurationCommandsToExecute.pop();
        } else {
          currentConfiguredDeviceCommandsArray.meta.index++;
          currentConfiguredDeviceCommandsArray.meta.failureCount = 0; // Reset after a success so it will count it per command and not per device setup...
        }
      }
    }

    if (this.configurationCommandsToExecute.length) {
      const currentConfiguredDeviceCommandsArray = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1];
      const device = this.getDeviceEntity(currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss);

      // Check that the resource is reachable...
      if (device?.bridgedDevice?.getAttribute(BridgedDeviceBasicInformation.Cluster.id, 'reachable', this.log) !== true) {
        this.log.error('Configuration cannot being sent to unreachable accessories, skipping...');
        this.lastCommandTimeout = undefined;
        this.configurationCommandsToExecute.pop();
        this.executeNextConfigurationCommand();
        return;
      }

      // send the commands on the queue...
      const dataToSend = currentConfiguredDeviceCommandsArray.commandsToExecute[currentConfiguredDeviceCommandsArray.meta.index];
      this.log.debug('Going to send: ' + dataToSend + ' to panel IEEE: ' + currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss);
      this.publishCommand(currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss, { communication: dataToSend });
      // this.client.put(currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss + '/config', { preset: dataToSend }).then((obj) => {
      //   this.log.info('Sent: ' + dataToSend + ' to panel IEEE: ' + currentConfiguredDeviceCommandsArray.meta.panelIeeeAddresss + ', which is a command of device index: ' + currentConfiguredDeviceCommandsArray.meta.deviceIndex + ', command no. ' + (currentConfiguredDeviceCommandsArray.meta.index + 1) + ' of ' + currentConfiguredDeviceCommandsArray.commandsToExecute.length + ' commands');
      //   })
      //   .catch((error) => {
      //     // Retry will happen at our timeout (or already happened if the error is a timeout error which is long than our timeout of 5 seconds below...)
      //     if (error) {
      //       this.log.error(error);
      //     }
      //   });
      // set a timeout timer...
      this.lastCommandTimeout = setTimeout(() => {
        currentConfiguredDeviceCommandsArray.meta.failureCount++;
        if (currentConfiguredDeviceCommandsArray.meta.failureCount >= 3) {
          this.executeNextConfigurationCommand();
        } else {
          // In case the timed out command is a multiple parts command (type 46), go back to the first part in the commands set...
          if (currentConfiguredDeviceCommandsArray.commandsToExecute[currentConfiguredDeviceCommandsArray.meta.index][7] === '6') {
            const currentCommandPartNo = parseInt(currentConfiguredDeviceCommandsArray.commandsToExecute[currentConfiguredDeviceCommandsArray.meta.index].substring(12, 14), 16);
            currentConfiguredDeviceCommandsArray.meta.index -= (currentCommandPartNo - 1);
          }
          this.configurationCommandTimeout();
        }
      }, 10000); // 10 seconds timeout
    } else {
      this.log.info('Finished all configuration commands');
    }
  }

  // TODO: Handle weather data asked from panel (after panel reboot for example)...
  panelSentData(deviceIeeeAddress: string, data: string) {
    const dataStartIndex = 0;

    const dataArray = this.fromHexStringToBytes(data);

    const commandCategory = dataArray[dataStartIndex + 1]; // (71=to device, 72=from device and 73=is for all scenes transactions [config and usage])
    const commandType = dataArray[dataStartIndex + 3]; // 84=Attribute report of states, 24=ACK for commands, 44 commands for device (shouldn't happen here), 46=multi-part commands for device (also shouldn't happen here), c6=Multipart commands ACKs...

    const integrityByteIndex = commandType === 0xc6 ? (dataStartIndex + 7) : (dataStartIndex + 5);
    let commandActionByteIndex = dataStartIndex + 6;

    let sum = dataArray[dataStartIndex] + dataArray[dataStartIndex + 1] + dataArray[dataStartIndex + 2] + dataArray[dataStartIndex + 3] + dataArray[dataStartIndex + 4] + this.getInt8(dataArray[integrityByteIndex]);
    if (commandType === 0xc6) {
      sum += (dataArray[dataStartIndex + 5] + dataArray[dataStartIndex + 6]);
      commandActionByteIndex = dataStartIndex + 8;
    }
    const commandAction = dataArray[commandActionByteIndex]; // 1=state report/scenes config, 2=configs, 3=scenes activation, 4=removals, 5=set state/states ACKs, 6=state request

    this.log.debug('Data hex: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum);

    if (sum === 512 || sum === 256 || sum === 768) {
      if (commandType === 0x84) {
        const paramsSize = dataArray[dataStartIndex + 8];

        const deviceSerial = [dataArray[dataStartIndex + 9], dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16]];
        const stateParam = [dataArray[dataStartIndex + 17], dataArray[dataStartIndex + 18], dataArray[dataStartIndex + 19], dataArray[dataStartIndex + 20]];

        this.log.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial + ', stateParam: ' + stateParam);

        const deviceResourceType = this.toCharacterStringFromBytes(deviceSerial);
        const deviceSerialStr = this.toHexStringFromBytes(deviceSerial);

        if (commandCategory === 0x72 && commandAction === 0x01) { // State of device is reported and should set the controlled device to this state (Turn on or change position for example).
          if (this.platform.platformControls?.switchesOn) {
            if (deviceResourceType === 'air_cond' && stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Updated Air conditioner/Heater-Cooler device state
              const onOff = dataArray[dataStartIndex + 21] >= 0x10;
              const mode = dataArray[dataStartIndex + 21] - (onOff ? 0x10 : 0x0);
              const fan = parseInt(dataArray[dataStartIndex + 22].toString(16).padStart(2, '0').slice(0, 1), 16);
              const setTemperature = dataArray[dataStartIndex + 23];
              this.log.info('On/Off: ' + onOff + ', Mode: ' + mode + ', Fan: ' + fan + ', Set Temperature: ' + setTemperature);

              const devicesIeee = this.panelsToEndpoints['/' + deviceIeeeAddress + '/ac'];
              for (let i = devicesIeee.length - 1; i >= 0; i--) {
                const deviceIeeeItem = devicesIeee[i];
                const deviceToControl = this.getDeviceEntity(deviceIeeeItem);

                if (deviceToControl) {
                  const endpointToControl = deviceToControl;
                  if (endpointToControl) {
                    /* await */ endpointToControl.bridgedDevice?.setAttribute(OnOff.Cluster.id, 'onOff', onOff, endpointToControl.bridgedDevice.log);
                    endpointToControl.bridgedDevice?.commandHandler.executeHandler(onOff ? 'on' : 'off');
                    if (onOff) {
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(Thermostat.Cluster.id, 'systemMode', mode === 0 ? Thermostat.SystemMode.Heat : mode === 1 ? Thermostat.SystemMode.Cool : Thermostat.SystemMode.Auto, endpointToControl.bridgedDevice.log);
                      // endpointToControl.bridgedDevice?.commandHandler.executeHandler('changeToMode', { newMode: mode });

                      // serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.RotationSpeed).setValue(fan === 0 ? 25 : fan === 1 ? 50 : fan === 2 ? 75 : 100)
                      // if (mode === 0 || mode === 1) {
                      //   serviceToControl._service.getCharacteristic(mode === 0 ? this.platform.Characteristics.hap.HeatingThresholdTemperature : this.platform.Characteristics.hap.CoolingThresholdTemperature).setValue(setTemperature)
                      // }
                    }
                  }
                }
              }
            } else if (deviceResourceType.startsWith('curtain')) { // Curtains control
              if (stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
                // const positionCoverion = {'0000': 0, '3f80': 1, '4000': 2, '4040': 3, '4080': 4, '40a0': 5, '40c0': 6, '40e0': 7, '4100': 8, '4110': 9, '4120': 10,'4130': 11,'4140': 12,'4150': 13,'4160': 14,'4170': 15,'4180': 16,'4188': 17,'4190': 18,'4198': 19,'41a0': 20,'41a8': 21,'41b0': 22,'41b8': 23,'41c0': 24,'41c8': 25,'41d0': 26,'41d8': 27,'41e0': 28,'41e8': 29,'41f0': 30,'41f8': 31,'4200': 32,'4204': 33,'4208': 34,'420c': 35,'4210': 36,'4214': 37,'4218': 38,'421c': 39,'4220': 40,'4224': 41,'4228': 42,'422c': 43,'4230': 44,'4234': 45,'4238': 46,'423c': 47,'4240': 48,'4244': 49,'4248': 50,'424c': 51,'4250': 52,'4254': 53,'4258': 54,'425c': 55,'4260': 56,'4264': 57,'4268': 58,'426c': 59,'4270': 60,'4274': 61,'4278': 62,'427c': 63,'4280': 64,'4282': 65,'4284': 66,'4286': 67,'4288': 68,'428a': 69,'428c': 70,'428e': 71,'4290': 72,'4292': 73,'4294': 74,'4296': 75,'4298': 76,'429a': 77,'429c': 78,'429e': 79,'42a0': 80,'42a2': 81,'42a4': 82,'42a6': 83,'42a8': 84,'42aa': 85,'42ac': 86,'42ae': 87,'42b0': 88,'42b2': 89,'42b4': 90,'42b6': 91,'42b8': 92,'42ba': 93,'42bc': 94,'42be': 95,'42c0': 96,'42c2': 97,'42c4': 98,'42c6': 99,'42c8': 100}
                // const position = this.getAqaraIntFromHex((((dataArray[dataStartIndex + 21] & 0xFF) << 8) | (dataArray[dataStartIndex + 22] & 0xFF))) // positionCoverion[dataArray[dataStartIndex + 21].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 22].toString(16).padStart(2, '0')]
                const position = this.getFloatFromHex32Bit(dataArray[dataStartIndex + 21].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 22].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 23].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 24].toString(16).padStart(2, '0'));
                this.log.info('Position: ' + position);

                const devicesIeee = this.panelsToEndpoints['/' + deviceIeeeAddress + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1)];
                for (let i = devicesIeee.length - 1; i >= 0; i--) {
                  const deviceIeeeItem = devicesIeee[i];
                  const deviceToControl = this.getDeviceEntity(deviceIeeeItem);

                  if (deviceToControl) {
                    const endpointToControl = deviceToControl;
                    if (endpointToControl) {
                      /* await */ endpointToControl?.bridgedDevice?.setAttribute(WindowCovering.Cluster.id, 'targetPositionLiftPercent100ths', position * 100, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler('goToLiftPercentage', { request: { liftPercent100thsValue: position * 100 } });
                    }
                  }
                }
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position State
                const positionState = dataArray[dataStartIndex + 24];
                this.log.info('Position State: ' + positionState);

                const devicesIeee = this.panelsToEndpoints['/' + deviceIeeeAddress + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1)];
                for (let i = devicesIeee.length - 1; i >= 0; i--) {
                  const deviceIeeeItem = devicesIeee[i];
                  const deviceToControl = this.getDeviceEntity(deviceIeeeItem);

                  if (deviceToControl) {
                    const endpointToControl = deviceToControl;
                    if (endpointToControl) {
                      if (positionState < 0x02) { // Open or Close
                        // /* await */ endpointToControl?.bridgedDevice?.setAttribute(WindowCovering.Cluster.id, 'targetPositionLiftPercent100ths', (positionState === 0x01 ? 100 : 0) * 100, endpointToControl.bridgedDevice.log);
                        endpointToControl.bridgedDevice?.commandHandler.executeHandler(positionState === 0x01 ? 'downOrClose' : 'upOrOpen');
                        const operationState = positionState === 0x01 ? WindowCovering.MovementStatus.Closing : positionState === 0x00 ? WindowCovering.MovementStatus.Opening : WindowCovering.MovementStatus.Stopped;
                        /* await */ endpointToControl?.bridgedDevice?.setAttribute(
                          WindowCovering.Cluster.id,
                          'operationalStatus',
                          { global: operationState, lift: operationState, tilt: operationState },
                          endpointToControl.bridgedDevice.log,
                        );
                      } else { // Stop
                        // const position = endpointToControl?.bridgedDevice?.getAttribute(WindowCovering.Cluster.id, 'currentPositionLiftPercent100ths', endpointToControl.bridgedDevice.log);
                        // // if (isValidNumber(position, 0, 10000)) {
                        // /* await */ endpointToControl?.bridgedDevice?.setAttribute(WindowCovering.Cluster.id, 'targetPositionLiftPercent100ths', position, endpointToControl.bridgedDevice.log);
                        // // }
                        endpointToControl.bridgedDevice?.commandHandler.executeHandler('stopMotion');
                      }
                    }
                  }
                }
              }
            } else if (deviceResourceType.startsWith('lights/')) { // Lights control
              let onOff = undefined;
              let brightness = undefined;
              let colorTemperature = undefined;
              let colorX = undefined;
              let colorY = undefined;

              if (stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                onOff = dataArray[dataStartIndex + 24] === 0x01;
                this.log.info('On/Off: ' + onOff);
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                brightness = dataArray[dataStartIndex + 24];
                this.log.info('Brightness: ' + brightness);
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                colorTemperature = parseInt(dataArray[dataStartIndex + 23].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 24].toString(16).padStart(2, '0'), 16);
                this.log.info('Color Temperature: ' + colorTemperature);
              } else if (stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                colorX = parseInt(dataArray[dataStartIndex + 21].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 22].toString(16).padStart(2, '0'), 16);
                colorY = parseInt(dataArray[dataStartIndex + 23].toString(16).padStart(2, '0') + dataArray[dataStartIndex + 24].toString(16).padStart(2, '0'), 16);
                this.log.info('Color X: ' + colorX + ', Color Y: ' + colorY);
              }
              const devicesIeee = this.panelsToEndpoints['/' + deviceIeeeAddress + '/light_' + deviceResourceType.charAt(deviceResourceType.length - 1)];
              for (let i = devicesIeee?.length - 1; i >= 0; i--) {
                const endpointToExecute = devicesIeee[i]; // 0x5465654664646464(/l1)
                const pathComponents = endpointToExecute.split('/'); // [0x5465654664646464(, l1)]
                const entityIeee = pathComponents[0]; // 0x5465654664646464
                const entityEndpointName = pathComponents[1]; // (l1)
                const entityEndpointSuffix = entityEndpointName ? '_' + entityEndpointName : ''; // (_l1)
                const entityToControl = this.getDeviceEntity(entityIeee); // The main device
                // const endpointToControl = entityEndpointName ? entityToControl?.bridgedDevice?.getChildEndpointById(entityEndpointName) : entityToControl?.bridgedDevice; // The child endpoint if its a multi-child device...

                if (entityToControl) {
                  if (onOff !== undefined) {
                    this.publishCommand(entityIeee, { ['state' + entityEndpointSuffix]: onOff ? 'ON' : 'OFF' });
                    // No need to set noUpdate to false since here its a scene panel input, not a light state change etc...
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(OnOff.Cluster.id, 'onOff', onOff, endpointToControl.bridgedDevice.log);
                  }
                  if (brightness !== undefined) {
                    this.publishCommand(entityIeee, { ['brightness' + entityEndpointSuffix]: Math.round((Math.max(3, Math.min(254, (brightness * 2.54))) / 254) * 255) });
                    // No need to set noUpdate to false since here its a scene panel input, not a light state change etc...
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(LevelControl.Cluster.id, 'currentLevel', brightness, endpointToControl.bridgedDevice.log);
                  }
                  if (colorTemperature !== undefined) {
                    this.publishCommand(entityIeee, { ['color_temp' + entityEndpointSuffix]: colorTemperature });
                    // No need to set noUpdate to false since here its a scene panel input, not a light state change etc...
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', colorTemperature, endpointToControl.bridgedDevice.log);
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpointToControl.bridgedDevice.log);
                  }
                  if (colorX !== undefined && colorY !== undefined) {
                    this.publishCommand(entityIeee, { ['color' + entityEndpointSuffix]: { x: Math.round(colorX / 65536 * 10000) / 10000, y: Math.round(colorY / 65536 * 10000) / 10000 } });
                    // No need to set noUpdate to false since here its a scene panel input, not a light state change etc...
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentX', colorX, endpointToControl.bridgedDevice.log);
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentY', colorY, endpointToControl.bridgedDevice.log);
                    // /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentXAndCurrentY, endpointToControl.bridgedDevice.log);
                  }
                }
              }
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x06) { // Panel asking for data...
          this.log.debug('Asked data for param: ' + stateParam);
          if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa5) { // Names
            if (this.aqaraS1ActionsConfigData[deviceIeeeAddress]) {
              // this.log(this.aqaraS1ActionsConfigData[deviceIeeeAddress])
              const panelControlledDeviceConfig: AqaraS1ScenePanelConfigKey = (deviceResourceType.startsWith('lights/') ? 'light_' + deviceResourceType.charAt(deviceResourceType.length - 1) : deviceResourceType.startsWith('curtain') ? 'curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1) : 'ac') as AqaraS1ScenePanelConfigKey;
              let name = panelControlledDeviceConfig as string;
              // this.log(panelControlledDeviceConfig)
              const deviceConfig = this.aqaraS1ActionsConfigData[deviceIeeeAddress][panelControlledDeviceConfig];
              if (deviceConfig) {
                name = deviceConfig.name;
              }

              const dataToSend = this.generateNameCommand(name, deviceSerialStr);
              this._writeDataToPanel(deviceIeeeAddress, dataToSend);
              // TODO: save the name in the context for proper handling...
            }
          } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x07 && stateParam[3] === 0xfd) { // Online/Offline
            // TODO: maybe set the state, on groups always online, on others, use the device.reachable state. What with multiple devices resources controller with one device???
            this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '080007fd', '00000001'); // Just respond with "Online" mode...
          } else if (deviceResourceType === 'air_cond') {
            if (stateParam[0] === 0x0e && stateParam[2] === 0x00 && stateParam[3] === 0x55 && (stateParam[1] === 0x20 || stateParam[1] === 0x02)) { // Air conditioner/Heater-Cooler device state
              const panelDevicePath = '/' + deviceIeeeAddress + '/ac';
              const deviceIeee = this.panelsToEndpoints[panelDevicePath][0];
              const deviceToControl = this.getDeviceEntity(deviceIeee);

              if (deviceToControl) {
                const endpointToControl = deviceToControl;
                if (endpointToControl?.bridgedDevice) {
                  // accessoryToControl.service.updatePanel(panelDevicePath.split('/'));
                  this.sendACStateToPanel(deviceIeeeAddress, endpointToControl.bridgedDevice);
                }
              }
            } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa7) { // Modes
              const deviceConfig = this.aqaraS1ActionsConfigData[deviceIeeeAddress]['ac'];

              let modesStr = '';
              if (deviceConfig?.modes.includes('heat')) {
                modesStr += '00';
              }
              if (deviceConfig?.modes.includes('cool')) {
                modesStr += '01';
              }
              if (deviceConfig?.modes.includes('auto')) {
                modesStr += '02';
              }
              if (deviceConfig?.modes.includes('fan')) {
                modesStr += '03';
              }
              if (deviceConfig?.modes.includes('dry')) {
                modesStr += '04';
              }
              this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '08001fa7', (modesStr.length / 2).toString(16).padStart(2, '0') + modesStr);
            } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa8) { // Fan Modes
              const deviceConfig = this.aqaraS1ActionsConfigData[deviceIeeeAddress]['ac'];

              let fanModesStr = '';
              if (deviceConfig?.fan_modes.includes('low')) {
                fanModesStr += '00';
              }
              if (deviceConfig?.fan_modes.includes('medium')) {
                fanModesStr += '01';
              }
              if (deviceConfig?.fan_modes.includes('high')) {
                fanModesStr += '02';
              }
              if (deviceConfig?.fan_modes.includes('auto')) {
                fanModesStr += '03';
              }
              this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '08001fa8', (fanModesStr.length / 2).toString(16).padStart(2, '0') + fanModesStr);
            } else if (stateParam[0] === 0x08 && stateParam[1] === 0x00 && stateParam[2] === 0x1f && stateParam[3] === 0xa9) { // Temperature Ranges
              const deviceConfig = this.aqaraS1ActionsConfigData[deviceIeeeAddress]['ac'];

              let tempRangesStr = '';
              if (deviceConfig?.modes.includes('heat') && deviceConfig.temperature_ranges?.heat) {
                tempRangesStr += '00' + deviceConfig.temperature_ranges.heat.lowest.toString(16).padStart(2, '0') + deviceConfig.temperature_ranges.heat.highest.toString(16).padStart(2, '0');
              }
              if (deviceConfig?.modes.includes('cool') && deviceConfig.temperature_ranges?.cool) {
                tempRangesStr += '01' + deviceConfig.temperature_ranges.cool.lowest.toString(16).padStart(2, '0') + deviceConfig.temperature_ranges.cool.highest.toString(16).padStart(2, '0');
              }
              if (deviceConfig?.modes.includes('auto') && deviceConfig.temperature_ranges?.auto) {
                tempRangesStr += '02' + deviceConfig.temperature_ranges.auto.lowest.toString(16).padStart(2, '0') + deviceConfig.temperature_ranges.auto.highest.toString(16).padStart(2, '0');
              }
              if (deviceConfig?.modes.includes('fan') && deviceConfig.temperature_ranges?.fan) {
                tempRangesStr += '03' + deviceConfig.temperature_ranges.fan.lowest.toString(16).padStart(2, '0') + deviceConfig.temperature_ranges.fan.highest.toString(16).padStart(2, '0');
              }
              if (deviceConfig?.modes.includes('dry') && deviceConfig.temperature_ranges?.dry) {
                tempRangesStr += '04' + deviceConfig.temperature_ranges.dry.lowest.toString(16).padStart(2, '0') + deviceConfig.temperature_ranges.dry.highest.toString(16).padStart(2, '0');
              }
              this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '08001fa9', (tempRangesStr.length / 2).toString(16).padStart(2, '0') + tempRangesStr);
            } else {
              this.log.info('AC Requires data which is not handled!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            }
          } else if (deviceResourceType.startsWith('curtain')) {
            if (stateParam[0] === 0x01 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position
              const panelDevicePath = '/' + deviceIeeeAddress + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1);
              const deviceIeee = this.panelsToEndpoints[panelDevicePath][0];
              const deviceToControl = this.getDeviceEntity(deviceIeee);

              if (deviceToControl) {
                const endpointToControl = deviceToControl;
                if (endpointToControl?.bridgedDevice) {
                  // accessoryToControl.service.updatePanelPositionState(panelDevicePath.split('/'));
                  this.sendCoverPositionToPanel(deviceIeeeAddress, endpointToControl.bridgedDevice);
                }
              } else {
                this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '01010055', this.getHexFromFloat32Bit(0));
              }
            } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Position State
              const panelDevicePath = '/' + deviceIeeeAddress + '/curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1);
              const deviceIeee = this.panelsToEndpoints[panelDevicePath][0];
              const deviceToControl = this.getDeviceEntity(deviceIeee);

              if (deviceToControl) {
                const endpointToControl = deviceToControl;
                if (endpointToControl?.bridgedDevice) {
                  // accessoryToControl.service.updatePanelMovementState(panelDevicePath.split('/'));
                  this.sendCoverMovementModeToPanel(deviceIeeeAddress, endpointToControl.bridgedDevice);
                }
              } else {
                this.sendStateToPanel(deviceIeeeAddress, deviceSerialStr, '0e020055', '00000002');
              }
            }
          } else if (deviceResourceType.startsWith('lights/')) {
            const lightNo = deviceResourceType.charAt(deviceResourceType.length - 1);
            const panelDevicePath = '/' + deviceIeeeAddress + '/light_' + lightNo;
            const deviceIeee = this.panelsToEndpoints[panelDevicePath]?.[0];
            const deviceToControl = this.getDeviceEntity(deviceIeee);
            // TODO: Child endpoints!!!

            if (deviceToControl /* && accessoryToControl.values.serviceName === 'Light'*/) {
              const endpointToControl = deviceToControl;
              if (endpointToControl?.bridgedDevice) {
                if (stateParam[0] === 0x04 && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light On/Off
                  // accessoryToControl.service.updatePanelOnOffState(panelDevicePath.split('/'));
                  this.sendLightOnOffStateToPanel(deviceIeeeAddress, lightNo, endpointToControl.bridgedDevice);
                } else if (stateParam[0] === 0x0e && stateParam[1] === 0x01 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Brightness
                  // accessoryToControl.service.updatePanelBrightnessState(panelDevicePath.split('/'));
                  this.sendLightBrightnessStateToPanel(deviceIeeeAddress, lightNo, endpointToControl.bridgedDevice);
                } else if (stateParam[0] === 0x0e && stateParam[1] === 0x02 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light CT
                  // accessoryToControl.service.updatePanelColorTemperatureState(panelDevicePath.split('/'));
                  this.sendLightColorTemperatureStateToPanel(deviceIeeeAddress, lightNo, endpointToControl.bridgedDevice);
                } else if (stateParam[0] === 0x0e && stateParam[1] === 0x08 && stateParam[2] === 0x00 && stateParam[3] === 0x55) { // Light Color
                  // accessoryToControl.service.updatePanelColorState(panelDevicePath.split('/'));
                  this.sendLightColorStateToPanel(deviceIeeeAddress, lightNo, endpointToControl.bridgedDevice);
                }
              }
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x07) { // TODO: check what it is, it seems to be ACKs for completed lights configuration commmands somehow, not sure yet... Also, it seems it waiiting to some response from the coordinator, IDK what i should send yet...
          // Seems to be an error configuration setup report (basically resending the commands fixes it...)
          // Might be i can just ignore it and let my timeout technique to resend the data...
          this.log.info('Light configuration notification received... from: ' + deviceIeeeAddress + ', Hex data: ' + data);
        } else if (commandCategory === 0x73 && commandAction === 0x03) {
          if (this.platform.platformControls?.switchesOn) {
            const panelDevice = this.getDeviceEntity(deviceIeeeAddress);
            const sceneNo = parseInt(data[data.length - 1]);
            const sceneConfigName = ('scene_' + sceneNo) as AqaraS1ScenePanelConfigKey;

            const sceneConfig = this.aqaraS1ActionsConfigData?.[deviceIeeeAddress]?.[sceneConfigName] as AqaraS1ScenePanelSceneConfig | undefined;
            const sceneExecutionData = sceneConfig?.execute;
            if (sceneExecutionData) {
              const devicesIeee = Object.keys(sceneExecutionData);
              for (let i = devicesIeee.length - 1; i >= 0; i--) {
                const deviceIeeeItem = devicesIeee[i];
                const sceneExecutionActions = sceneExecutionData[deviceIeeeItem];
                const deviceToControl = this.getDeviceEntity(deviceIeeeItem);

                if (deviceToControl) {
                  const endpointToControl = deviceToControl;
                  if (endpointToControl) {
                    if (sceneExecutionActions.on !== undefined) {
                      const onOff = Boolean(sceneExecutionActions.on);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(OnOff.Cluster.id, 'onOff', onOff, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler(onOff ? 'on' : 'off');
                    }
                    if (sceneExecutionActions.brightness !== undefined) {
                      const brightness = Number(sceneExecutionActions.brightness);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(LevelControl.Cluster.id, 'currentLevel', brightness, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToLevel', { request: { level: brightness } });
                    }
                    if (sceneExecutionActions.colorTemperature !== undefined) {
                      const colorTemperature = Number(sceneExecutionActions.colorTemperature);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', colorTemperature, endpointToControl.bridgedDevice.log);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToColorTemperature', { request: { colorTemperatureMireds: colorTemperature } });
                    }
                    if (sceneExecutionActions.colorX !== undefined && sceneExecutionActions.colorY !== undefined) {
                      const colorX = Number(sceneExecutionActions.colorX);
                      const colorY = Number(sceneExecutionActions.colorY);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentX', colorX, endpointToControl.bridgedDevice.log);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentY', colorY, endpointToControl.bridgedDevice.log);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentXAndCurrentY, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToColor', { request: { colorX, colorY } });
                    }
                    if (sceneExecutionActions.hue !== undefined && sceneExecutionActions.saturation !== undefined) {
                      const hue = Number(sceneExecutionActions.hue);
                      const saturation = Number(sceneExecutionActions.saturation);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentHue', hue, endpointToControl.bridgedDevice.log);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentSaturation', saturation, endpointToControl.bridgedDevice.log);
                      /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, endpointToControl.bridgedDevice.log);
                      endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToHueAndSaturation', { request: { hue, saturation } });
                    }
                    // if (sceneExecutionActions.active !== undefined) { // For ACs for example
                    //   serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.Active).setValue(sceneExecutionActions.active)
                    // }
                    // if (sceneExecutionActions.targetTemperature !== undefined) { // For ACs and thermostats
                    //   const characteristic = undefined;
                    //   if (typeof accessoryToControl === 'HeaterCooler') {
                    //     const currentTargetHeaterCoolerState = serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.TargetHeaterCoolerState).value
                    //     if (currentTargetHeaterCoolerState === this.platform.Characteristics.hap.TargetHeaterCoolerState.COOL) {
                    //       characteristic = this.platform.Characteristics.hap.CoolingThresholdTemperature
                    //     } else if (currentTargetHeaterCoolerState === this.platform.Characteristics.hap.TargetHeaterCoolerState.HEAT) {
                    //       characteristic = this.platform.Characteristics.hap.HeatingThresholdTemperature
                    //     }
                    //   } else if (typeof accessoryToControl === 'Thermostat') {
                    //     characteristic = this.platform.Characteristics.hap.TargetTemperature
                    //   }
                    //   if (characteristic !== undefined) {
                    //     serviceToControl._service.getCharacteristic(characteristic).setValue(sceneExecutionActions.targetTemperature)
                    //   }
                    // }
                    // if (sceneExecutionActions.targetState !== undefined) { // For ACs and thermostats
                    //   const characteristic = undefined;
                    //   if (typeof accessoryToControl === 'HeaterCooler') {
                    //     characteristic = this.platform.Characteristics.hap.TargetHeaterCoolerState
                    //   } else if (typeof accessoryToControl === 'Thermostat') {
                    //     characteristic = this.platform.Characteristics.hap.TargetHeatingCoolingState
                    //   }
                    //   if (characteristic !== undefined) {
                    //     serviceToControl._service.getCharacteristic(characteristic).setValue(sceneExecutionActions.targetState)
                    //   }
                    // }
                    // if (sceneExecutionActions.rotationSpeed !== undefined) { // For ACs (, fans and thermostats?)
                    //   serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.RotationSpeed).setValue(sceneExecutionActions.rotationSpeed)
                    // }
                    // if (sceneExecutionActions.swingMode !== undefined) { // For ACs (, fans and thermostats?)
                    //   serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.SwingMode).setValue(sceneExecutionActions.swingMode)
                    // }
                    // if (sceneExecutionActions.holdPosition !== undefined) { // For WindowCovering
                    //   serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.HoldPosition).setValue(sceneExecutionActions.holdPosition) // Supposed to be boolean
                    // }
                    // if (sceneExecutionActions.targetPosition !== undefined) { // For WindowCovering
                    //   serviceToControl._service.getCharacteristic(this.platform.Characteristics.hap.TargetPosition).setValue(sceneExecutionActions.targetPosition)
                    // }

                    // Allow also triggering buttons actions, so in HomeKit it will execute the button automation.
                    if (sceneExecutionActions?.buttonAction === 'Single' || sceneExecutionActions?.buttonAction === 'Double' || sceneExecutionActions?.buttonAction === 'Long' || sceneExecutionActions?.buttonAction === 'Press' || sceneExecutionActions?.buttonAction === 'Release') {
                      // TODO: Test if it functions properly.
                      endpointToControl.bridgedDevice?.triggerSwitchEvent(sceneExecutionActions.buttonAction);
                    }
                  }
                }
              }
            }

            // const buttonService = panelSensor.buttonServices[sceneNo];
            panelDevice?.bridgedDevice?.getChildEndpoint(EndpointNumber(sceneNo))?.triggerSwitchEvent('Single'); // issue a single press event...
            this.log.info('Scene Activated... from: ' + deviceIeeeAddress + ', Hex data: ' + data);
          }
        } else {
          this.log.error('Unknown message from: ' + deviceIeeeAddress + ', Hex data: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16));
        }
      } else if (commandType === 0x24) {
        const paramsSize = dataArray[dataStartIndex + 8];

        if (commandCategory === 0x71 && commandAction === 0x02) { // ACKs for configuration commmands...
          if (this.configurationCommandsToExecute.length) {
            const configuredSlotID = this.toHexStringFromBytes([dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14]]);
            const currentConfiguredDeviceCommandsObject = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1];
            let currentCommand = currentConfiguredDeviceCommandsObject.commandsToExecute[currentConfiguredDeviceCommandsObject.meta.index];
            let slotIdIndex = 18;
            if (currentCommand[7] === '6') {
              slotIdIndex = 22;
              // check we're in the last commands part and set currentCommand to the first command of series...
              // const totalParts =  dataArray[dataStartIndex + 5]
              const partNo = dataArray[dataStartIndex + 6];
              currentCommand = currentConfiguredDeviceCommandsObject.commandsToExecute[currentConfiguredDeviceCommandsObject.meta.index - (partNo - 1)];
            }
            const commandSlotID = currentCommand.substring(slotIdIndex, slotIdIndex + 10);
            if (commandSlotID === configuredSlotID) {
              this.log.info('Configuration command Slot ID ' + configuredSlotID + ' ACK...');
              this.executeNextConfigurationCommand();
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x04) { // ACKs for configuration removal commmands...
          this.log.info('Configuration removal command ACK...');
          this.executeNextConfigurationCommand();
        } else if (commandCategory === 0x73 && commandAction === 0x01) { // ACKs for scene configuration commmands...
          // TODO: Maybe check that the rpath is the current command path, this is suffecient because we have only one command per panel...
          this.log.info('Scene configuration command ACK...');
          this.executeNextConfigurationCommand();
        } else if (commandCategory === 0x73 && commandAction === 0x02) { // ACKs for unused scenes configuration commmands...
          // TODO: Maybe check that the rpath is the current command path, this is suffecient because we have only one command per panel...
          this.log.info('Unused scenes configuration command ACK...');
          this.executeNextConfigurationCommand();
        } else if (commandCategory === 0x71 && commandAction === 0x05) { // ACKs for state commmands...
          const deviceSerial = [dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16], dataArray[dataStartIndex + 17]];

          this.log.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial);

          const deviceResourceType = this.toCharacterStringFromBytes(deviceSerial);
          // const deviceSerialStr = this.toHexStringFromBytes(deviceSerial)

          if (dataArray[dataStartIndex + 9] === 0x01) { // A device is missing... (We sent a state to unconfigured device. For example, we sent a light on/off state for light_1 while it isn't configured on the panel, so, we should (re)configure it...
            //
          } else if (dataArray[dataStartIndex + 9] === 0x00) {
            this.log.info('State update ACK, Param: 0x' + dataArray[dataStartIndex + 18] + '.');
            if (!this.aqaraS1ActionsConfigData[deviceIeeeAddress] || (deviceResourceType.startsWith('lights/') && !this.aqaraS1ActionsConfigData[deviceIeeeAddress][('light_' + deviceResourceType.charAt(deviceResourceType.length - 1) as AqaraS1ScenePanelConfigKey)]) || (deviceResourceType.startsWith('curtain') && !this.aqaraS1ActionsConfigData[deviceIeeeAddress][('curtain_' + deviceResourceType.charAt(deviceResourceType.length - 1)) as AqaraS1ScenePanelConfigKey]) || (deviceResourceType === 'air_cond' && !this.aqaraS1ActionsConfigData[deviceIeeeAddress].ac)) { // A device is configured on the panel, but shouldn't be there (removed from config...), so, we should remove its configuration...
              //
            }
          }
        } else if (commandCategory === 0x71 && commandAction === 0x08) { // ACKs for feel page updates commmands...
          const deviceSerial = [dataArray[dataStartIndex + 10], dataArray[dataStartIndex + 11], dataArray[dataStartIndex + 12], dataArray[dataStartIndex + 13], dataArray[dataStartIndex + 14], dataArray[dataStartIndex + 15], dataArray[dataStartIndex + 16], dataArray[dataStartIndex + 17]];

          this.log.debug('commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16) + ', deviceSerial: ' + deviceSerial);

          // deviceSerial should be === this.id for non temperature sensor weather updates...
          if (dataArray[dataStartIndex + 9] === 0x01) { // A device is missing...

          } else if (dataArray[dataStartIndex + 9] === 0x00) {
            this.log.info('Weather data update ACK, Param: 0x' + dataArray[dataStartIndex + 18] + '.');
            if (!this.aqaraS1ActionsConfigData[deviceIeeeAddress] || ((dataArray[dataStartIndex + 18] === 0x01 || dataArray[dataStartIndex + 18] === 0x02) && !this.aqaraS1ActionsConfigData[deviceIeeeAddress].temperature_sensor)) { // A device is set on the device, but shouldn't be there (removed from config...)

            }
          }
        } else {
          this.log.error('Unknown message from: ' + deviceIeeeAddress + ', Hex data: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16) + ', paramsSize: 0x' + paramsSize.toString(16));
        }
      } else if (commandType === 0xc6) {
        if (commandCategory === 0x71 && commandAction === 0x02) { // For multipart device configuration commands...
          const totalParts = dataArray[dataStartIndex + 5];
          const partNo = dataArray[dataStartIndex + 6];
          this.log.info('Multipart commands ACK received, part ' + partNo + ' of ' + totalParts + ' total.');
          if (partNo < totalParts) {
            if (this.configurationCommandsToExecute.length) {
              const currentCommandIndex = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1].meta.index;
              if (partNo === currentCommandIndex + 1) {
                this.executeNextConfigurationCommand();
              }
            }
          } else {
            // We should receive now commandType === 0x24 && commandCategory === 0x71 && commandAction === 0x02 above...
          }
        } else if (commandCategory === 0x73 && commandAction === 0x01) { // For multipart scene configuration commands...
          const totalParts = dataArray[dataStartIndex + 5];
          const partNo = dataArray[dataStartIndex + 6];
          this.log.info('Multipart commands ACK received, part ' + partNo + ' of ' + totalParts + ' total.');
          if (partNo < totalParts) {
            if (this.configurationCommandsToExecute.length) {
              const commandsSetData = this.configurationCommandsToExecute[this.configurationCommandsToExecute.length - 1];
              const commandBytes = this.fromHexStringToBytes(commandsSetData.commandsToExecute[commandsSetData.meta.index]);
              if (partNo === commandBytes[6]) {
                this.executeNextConfigurationCommand();
              }
            }
          } else {
            // We should receive now commandType === 0x24 && commandCategory === 0x73 && commandAction === 0x01 above...
          }
        } else {
          this.log.error('Unknown message from: ' + deviceIeeeAddress + ', Hex data: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16));
        }
      } else {
        this.log.error('Unknown message from: ' + deviceIeeeAddress + ', Hex data: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory.toString(16) + ', commandType: 0x' + commandType.toString(16) + ', commandAction: 0x' + commandAction.toString(16));
      }
    } else {
      this.log.error('Unknown message from: ' + deviceIeeeAddress + ', Hex data: ' + data + ', Data array: ' + dataArray + ', Integrity: ' + dataArray[integrityByteIndex] + ', Signed integrity: ' + this.getInt8(dataArray[integrityByteIndex]) + ', Sum: ' + sum + ', commandCategory: 0x' + commandCategory?.toString(16) + ', commandType: 0x' + commandType?.toString(16) + ', commandAction: 0x' + commandAction?.toString(16));
    }
  }

  generateNameCommand(name: string, device: string) {
    const nameSize = name.length;
    const nameHex = this.toHexStringFromCharacterString(name);

    const dataToSend = this.generateAqaraS1ScenePanelCommands('05', device + '08001fa5' + nameSize.toString(16).padStart(2, '0') + nameHex)[0];
    this.log.info('Name data: ' + dataToSend);

    return dataToSend;
  }

  generateAqaraS1ScenePanelCommands(cmdAction: string, data: string, cmdCatergory: string = '71') { // To device
    const commandsToExecute = [];
    const cmdDataType = '41'; // Octed String
    const dataSize = data.length / 2;
    const counter = '6d';
    if (dataSize <= 0x37) {
      const cmdType = '44'; // Single ZCL Command
      const commandSize = dataSize + 3;
      const integrity = 512 - (parseInt('aa', 16) + parseInt(cmdCatergory, 16) + commandSize + parseInt(cmdType, 16) + parseInt(counter, 16));
      const dataToSend = 'aa' + cmdCatergory + commandSize.toString(16).padStart(2, '0') + cmdType + counter + this.getUInt8(integrity).toString(16).padStart(2, '0') + cmdAction + cmdDataType + dataSize.toString(16).padStart(2, '0') + data;
      commandsToExecute.push(dataToSend);
    } else {
      const cmdType = '46'; // Multiple ZCL Commands
      let generatedCommandPartsDataIndex = 0;
      const partsData = [];

      const firstCommandPartDataSize = 53;
      const restCommandPartsDataSize = 56;
      while (generatedCommandPartsDataIndex < dataSize) {
        let stringEndPos = 0;
        if (partsData.length === 0) {
          stringEndPos = generatedCommandPartsDataIndex + firstCommandPartDataSize;
        } else {
          stringEndPos = generatedCommandPartsDataIndex + Math.min(restCommandPartsDataSize, (dataSize - generatedCommandPartsDataIndex));
        }
        partsData.push(data.substring(generatedCommandPartsDataIndex * 2, stringEndPos * 2));
        generatedCommandPartsDataIndex = stringEndPos;
      }

      for (let index = 0; index < partsData.length; index++) {
        const partData = partsData[index];
        const partDataSize = partData.length / 2;
        const commandSize = partDataSize + (index === 0 ? 3 : 0); // The first command contains the cmdType, dataType and dataSize.
        const integrity = 512 - (parseInt('aa', 16) + parseInt(cmdCatergory, 16) + commandSize + parseInt(cmdType, 16) + parseInt(counter, 16) + parseInt('' + partsData.length, 16) + parseInt('' + (index + 1), 16));
        if (index === 0) {
          const dataToSend = 'aa' + cmdCatergory + commandSize.toString(16).padStart(2, '0') + cmdType + counter + partsData.length.toString(16).padStart(2, '0') + (index + 1).toString(16).padStart(2, '0') + this.getUInt8(integrity).toString(16).padStart(2, '0') + cmdAction + cmdDataType + dataSize.toString(16).padStart(2, '0') + partData;
          commandsToExecute.push(dataToSend);
        } else {
          const dataToSend = 'aa' + cmdCatergory + commandSize.toString(16).padStart(2, '0') + cmdType + counter + partsData.length.toString(16).padStart(2, '0') + (index + 1).toString(16).padStart(2, '0') + this.getUInt8(integrity).toString(16).padStart(2, '0') + partData;
          commandsToExecute.push(dataToSend);
        }
      }
    }
    return commandsToExecute;
  }
}
