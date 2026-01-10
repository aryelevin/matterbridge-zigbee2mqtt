// import * as fs from 'node:fs';
// import * as https from 'node:https';
// import * as http from 'node:http';
// import * as url from 'node:url';
// import * as qs from 'node:querystring';
// import * as path from 'node:path';
// import { ClientRequest, IncomingMessage } from 'node:http';

import { AnsiLogger, TimestampFormat, LogLevel } from 'node-ansi-logger';
// import { MatterbridgeEndpoint } from 'matterbridge';
import { ColorControl, LevelControl, OnOff /* , Thermostat, WindowCovering */ } from 'matterbridge/matter/clusters';
// import { EndpointNumber } from 'matterbridge/matter';
import { deepCopy, deepEqual } from 'matterbridge/utils';

import { ZigbeePlatform } from './module.js';
import { ZigbeeEntity } from './entity.js';
// import { OnOff } from 'matterbridge/matter/clusters';
import { Payload, PayloadValue } from './payloadTypes.js';

declare module './entity.js' {
  interface ZigbeeEntity {
    // sendState(commandName: string, data: Payload, cache: boolean): void;
    updateLastPayloadItem(key: string, value: string | number | boolean): void;
    getLastPayloadItem(key: string): PayloadValue;
    setNoUpdate(noUpdate: boolean): void;
    checkIfPropertyItemShouldBeExposed(key: string): boolean;
  }
}

// ZigbeeEntity.prototype.sendState = function (commandName: string, data: Payload, cache: boolean): void {
//   // this.saveCommands('off', dataToSend);
//   // this.log.debug(`Aqara S1 Scene Panel Command send called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${dataToSend.endpoint?.maybeId}:${dataToSend.endpoint?.maybeNumber}`);
//   // const isChildEndpoint = dataToSend.endpoint.deviceName !== this.entityName;
//   if (cache) {
//     this.cachePublish(commandName, data);
//   } else {
//     this.publishCommand(commandName, this.device ? (this.device?.friendly_name as string) : (this.group?.friendly_name as string), data);
//     this.noUpdate = false;
//   }
// };

ZigbeeEntity.prototype.updateLastPayloadItem = function (key: string, value: string): void {
  this.lastPayload[key] = value;
};
ZigbeeEntity.prototype.getLastPayloadItem = function (key: string): PayloadValue {
  return this.lastPayload[key];
};
ZigbeeEntity.prototype.setNoUpdate = function (noUpdate: boolean): void {
  this.noUpdate = noUpdate;
};
ZigbeeEntity.prototype.checkIfPropertyItemShouldBeExposed = function (key: string): boolean {
  if (this.group) {
    return true;
  }
  if (this.device?.definition?.exposes?.length) {
    const exposes = this.device.definition.exposes;
    for (const expose of exposes) {
      if (expose.features) {
        for (const feature of expose.features) {
          if (feature.property === key) {
            return true;
          }
        }
      } else if (key === expose.property) {
        return true;
      }
    }
  }
  return false;
};

export interface SwitchingControllerSwitchLinkConfig {
  enabled: boolean;
  vice_versa: boolean;
  update_state: boolean;
  linkedDevices?: string[]; // ["0x54abcd0987654321/l1_brightness", "0x541234567890abcd/l1_brightness"]
}

const SwitchTypes = {
  SwitchTypeIkeaTradfriFiveButtonsRound: 0,
  SwitchTypeHueDimmerFourButtons: 1,
  SwitchTypeIkeaRodretOrStyrbar: 2,
} as const; // `as const` makes all properties readonly and their values literal types

// Extract the type of the whole object
// type SwitchType = typeof SwitchTypes;

// Extract a union type of all the values (0 | 1 | 2)
type SwitchType = (typeof SwitchTypes)[keyof typeof SwitchTypes];

// If the source switch is configured with the button action (/on_press for example), then it will be considered as per action config and switchType is ignored while repeat is considered, otherwise switchType is considered and needed whilst repeat is ignored...
export interface SwitchingControllerSwitchConfig {
  enabled: boolean;
  switchType?: SwitchType;
  repeat?: boolean;
  linkedDevices: { [key: string]: PayloadValue }; // {"0x54abcd0987654321/brightness_l1": 254, "0x54abcd0987654321/state_l1": 'ON', "0x54abcd0987654321/state_l2": 'OFF', "0x54abcd0987654321/brightness_l1": 254, "0x54abcd0987654321/state_l1": 'ON', "0x54abcd0987654321/state_l2": 'OFF', "0x541234567890abcd/brightness_l3": 4, "0x541234567890abcd/state_l3": 'ON'}
}

export class SwitchingController {
  public log: AnsiLogger;
  platform: ZigbeePlatform;
  switchesLinksConfig: { [key: string]: SwitchingControllerSwitchLinkConfig }; // {"0x541234567890abcd/l2_brightness": {enabled: true, vice_versa: true, linkedDevice:["0x54abcd0987654321/brightness_l1", "0x541234567890abcd/brightness_l1"]}, "0x541234567890abcd/state_left": {enabled: true, vice_versa: true, linkedDevice:["0x54abcd0987654321/state_l1", "0x541234567890abcd/state_l2"]}}
  switchesLinksConfigData: { [key: string]: string[] };
  switchesActionsConfig: { [key: string]: SwitchingControllerSwitchConfig }; // {'0x541234567890abcd': {'enabled': true, switchType: 2, 'linkedDevices': {'0x54abcd0987654321/l1': '', '0x54abcd0987654322/center': ''}}, '0x541234567890abcd/single': {'enabled': true, 'repeat': false, 'linkedDevices': {'0x54abcd0987654321/state_l1': 'ON', '0x54abcd0987654322/l3': 'toggle_on'}}, '0x541234567890abcd/hold': {'enabled': true, 'repeat': true, 'linkedDevices': {'0x54abcd0987654321/brightness_l1': 254, '0x54abcd0987654322/center': 'bri_up'}}, '0x541234567890abcd/double': {'enabled': true, 'repeat': false, 'linkedDevices': {'0x54abcd0987654321/characteristic': {state_left: ON}, '0x54abcd0987654322/l2': 'bri_up'}}}
  longPressTimeoutIDs: { [key: string]: NodeJS.Timeout } = {};
  lastStates: { [key: string]: Payload } = {};
  entitiesExecutionValues: { [key: string]: PayloadValue } = {};

  constructor(
    platform: ZigbeePlatform,
    switchesLinksConfig: { [key: string]: SwitchingControllerSwitchLinkConfig },
    switchesActionsConfig: { [key: string]: SwitchingControllerSwitchConfig },
  ) {
    this.platform = platform;
    this.switchesLinksConfig = switchesLinksConfig;
    this.switchesLinksConfigData = {};
    this.switchesActionsConfig = switchesActionsConfig;

    for (const sourceDevice in this.switchesLinksConfig) {
      const linkConfig = this.switchesLinksConfig[sourceDevice];
      if (linkConfig.enabled) {
        const linkedDevices = linkConfig.linkedDevices || [];
        if (!this.switchesLinksConfigData[sourceDevice]) this.switchesLinksConfigData[sourceDevice] = [];
        this.switchesLinksConfigData[sourceDevice].push(...linkedDevices);
        if (linkConfig.vice_versa) {
          for (let index = 0; index < linkedDevices.length; index++) {
            const linkedDeviceItem = linkedDevices[index];
            if (!this.switchesLinksConfigData[linkedDeviceItem]) this.switchesLinksConfigData[linkedDeviceItem] = [];
            const linkedDeviceLinks = this.switchesLinksConfigData[linkedDeviceItem];
            linkedDeviceLinks.push(sourceDevice);
          }

          for (let index = 0; index < linkedDevices.length; index++) {
            const linkedDeviceItem = linkedDevices[index];
            const linkedDeviceLinks = this.switchesLinksConfigData[linkedDeviceItem];

            for (let index2 = 0; index2 < linkedDeviceLinks.length; index2++) {
              const element = linkedDeviceLinks[index2];
              const linkesOfLinkedDeviceLinks = this.switchesLinksConfigData[element] || [];
              for (let index3 = 0; index3 < linkesOfLinkedDeviceLinks.length; index3++) {
                const element2 = linkesOfLinkedDeviceLinks[index3];
                if (element2 !== linkedDeviceItem && !linkedDeviceLinks.includes(element2)) {
                  linkedDeviceLinks.push(element2);
                }
              }
            }
          }
        }
      }
    }

    this.log = new AnsiLogger({
      logName: 'SwitchingController',
      logTimestampFormat: TimestampFormat.TIME_MILLIS,
      logLevel: platform.config.debug ? LogLevel.DEBUG : platform.log.logLevel,
    });
    this.log.debug(`Loaded: SwitchingController`);
    this.log.debug('switchesActionsConfigData contents: ' + JSON.stringify(this.switchesLinksConfigData));
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

  setSwitchingControllerConfiguration() {
    const devicesToListenToEvents: { [key: string]: boolean } = {};
    // for (const allEntitiesItem of this.platform.zigbeeEntities) {
    //   const sourceDevice = allEntitiesItem.device ? allEntitiesItem.device.ieee_address : allEntitiesItem.group ? 'group-' + allEntitiesItem.group.id : allEntitiesItem.entityName;
    //   devicesToListenToEvents[sourceDevice.split('/')[0]] = false;
    // }
    for (const sourceDevice in this.switchesLinksConfigData) {
      devicesToListenToEvents[sourceDevice.split('/')[0]] = true;
    }
    for (const sourceDevice in this.switchesActionsConfig) {
      devicesToListenToEvents[sourceDevice.split('/')[0]] = true;
    }
    for (const deviceIeee in devicesToListenToEvents) {
      if (!this.lastStates[deviceIeee]) {
        this.lastStates[deviceIeee] = {};
        const device = this.getDeviceEntity(deviceIeee);
        this.platform.z2m.on('MESSAGE-' + (device !== undefined ? device.entityName : deviceIeee), (payload: Payload) => {
          if (this.platform.platformControls?.switchesOn !== false) {
            if (!payload.action && deepEqual(this.lastStates[deviceIeee], payload, ['linkquality', 'last_seen', 'communication'])) return;
            // For Zigbee2MQTT -> Settings -> Advanced -> cache_state = true
            for (const key in payload) {
              const value = payload[key];
              if (
                (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
                (key === 'action' ||
                  (key === 'action_rotation_percent_speed' && (payload.action === 'rotation' || payload.action === 'start_rotating')) ||
                  value !== this.lastStates[deviceIeee][key]) &&
                device?.checkIfPropertyItemShouldBeExposed(key)
              ) {
                // Don't process items which isn't configured in switches action and switches links... (see above, initially all devices is set to false, then the configured ones is set to true).
                // if (devicesToListenToEvents[deviceIeee] === true) {
                this.log.info((device !== undefined ? device.entityName : deviceIeee) + ' value ' + key + ' changed from ' + this.lastStates[deviceIeee][key] + ' to ' + value + '.');
                this.switchStateChanged(deviceIeee || '', key, value, payload);
                // }
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
          }
        });
      }
    }
  }

  checkSwitchShabbatMode(deviceIeee: string, newPayload: Payload) {
    if (this.platform.platformControls?.switchesOn === false) {
      const device = this.getDeviceEntity(deviceIeee);
      const entityIeee = device?.device ? device.device.ieee_address : device?.group ? device.group.friendly_name : deviceIeee;
      if (device) {
        for (const key in newPayload) {
          const keyComponents = key.split('_');
          const value = newPayload[key];
          const lastPayloadValue = this.lastStates[entityIeee] ? this.lastStates[entityIeee][key] : device.getLastPayloadItem(key);
          if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && value !== lastPayloadValue && device.checkIfPropertyItemShouldBeExposed(key)) {
            this.log.info(device.entityName + ' value ' + key + ' changed from ' + lastPayloadValue + ' to ' + value + '.');
            if (key.startsWith('state')) {
              const newOnOffState = value === 'ON';
              const endpointToControl = keyComponents.length === 2 ? device.bridgedDevice?.getChildEndpointById(keyComponents[1]) : device.bridgedDevice;
              if (endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff') !== newOnOffState) { // Allow change from the platform itself...
                newPayload[key] = lastPayloadValue;
                this.publishCommand(deviceIeee, { [key]: lastPayloadValue }); // change it back
              } else if (this.lastStates[entityIeee]) {
                // Update linked switches...
                this.switchStateChanged(entityIeee, key, value, newPayload);
                this.lastStates[entityIeee][key] = value;
              }
            } else if (key.startsWith('brightness')) {
              // TODO:
            } else if (key.startsWith('color_temp')) {
              // TODO:
            } else if (key.startsWith('color') && !key.startsWith('color_mode')) {
              // TODO:
            }
          }
        }
      }
    }
  }

  // deviceEndpointPath is the device IEEE address with the endpoint, data is the changed state
  // for example, if the deviceEndpointPath is: /0x541234567890abcd/state_left and data is 'ON', then it means that a device with childEndpoint named state_left have turned on.
  switchStateChanged(deviceIeee: string, key: string, value: string | number | boolean, newPayload: Payload) {
    if (key === 'action') {
      this.processIncomingButtonEvent(deviceIeee, value as string);
      return;
    }
    if (key === 'action_rotation_percent_speed') {
      this.processIncomingRotationPercentageEvent(deviceIeee, value as number, newPayload);
      return;
    }
    const deviceEndpointPath = deviceIeee + '/' + key;

    const linkedDevices = this.switchesLinksConfigData[deviceEndpointPath];
    if (!linkedDevices?.length) {
      return;
    }

    if (this.entitiesExecutionValues[deviceIeee] && this.entitiesExecutionValues[deviceIeee] !== value) {
      this.publishCommand(deviceIeee, { [key]: this.entitiesExecutionValues[deviceIeee] }); // change it back
      const device = this.getDeviceEntity(deviceIeee);
      device?.setNoUpdate(false);
      return;
    }

    const payloads: { [key: string]: { [key: string]: string | number | boolean } } = {};
    for (let i = linkedDevices.length - 1; i >= 0; i--) {
      const linkedDeviceItem = linkedDevices[i];
      const linkedDevicePathComponents = linkedDeviceItem.split('/');
      const linkedDeviceIeee = linkedDevicePathComponents[0];
      const paramToControl = linkedDevicePathComponents[1];

      if (
        (linkedDeviceIeee === deviceIeee && newPayload[paramToControl] !== value) ||
        (linkedDeviceIeee !== deviceIeee && this.lastStates[linkedDeviceIeee]?.[paramToControl] !== value)
      ) {
        // Don't update whats not needed to be updated...
        if (!payloads[linkedDeviceIeee]) {
          payloads[linkedDeviceIeee] = {};
        }
        payloads[linkedDeviceIeee][paramToControl] = value;
      }
    }

    for (const entity in payloads) {
      const payload = payloads[entity];
      for (const endpoint in payload) {
        const value = payload[endpoint];
        this.publishCommand(entity, { [endpoint]: value });
        if (this.lastStates[entity]) {
          this.lastStates[entity][endpoint] = value;
          this.switchStateChanged(entity, endpoint, value, this.lastStates[entity]);
          // // Check if there's linkes from this controlled entity to another (chained events), but make sure it isn't already in this payloads which will make it happen twice and will screw up the logic
          // const linkedDevices = this.switchesLinksConfigData[entity + '/' + endpoint];
          // if (linkedDevices.length) {

          // }
        }
      }
      // If the linked light is same device/entity as the source, then make no update to be false to allow the state of the linked lights to be up to date...
      if (deviceIeee === entity) {
        const device = this.getDeviceEntity(deviceIeee);
        device?.setNoUpdate(false);
      }
      this.entitiesExecutionValues[entity] = value;
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.entitiesExecutionValues[entity];
      }, 2000);
    }

    // const panelDevice = this.getDeviceEntity(deviceEndpointPath);
    // const sceneNo = parseInt(data[data.length - 1]);
    // const sceneConfigName = ('scene_' + sceneNo) as AqaraS1ScenePanelConfigKey;

    // const sceneConfig = this.aqaraS1ActionsConfigData?.[deviceEndpointPath]?.[sceneConfigName] as AqaraS1ScenePanelSceneConfig | undefined;
    // const sceneExecutionData = sceneConfig?.execute;
    // if (sceneExecutionData) {
    //   const devicesIeee = Object.keys(sceneExecutionData);
    //   for (let i = devicesIeee.length - 1; i >= 0; i--) {
    //     const deviceIeeeItem = devicesIeee[i];
    //     const sceneExecutionActions = sceneExecutionData[deviceIeeeItem];
    //     const deviceToControl = this.getDeviceEntity(deviceIeeeItem);

    //     if (deviceToControl) {
    //       const endpointToControl = deviceToControl;
    //       if (endpointToControl) {
    //         if (sceneExecutionActions.on !== undefined) {
    //           const onOff = Boolean(sceneExecutionActions.on);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(OnOff.Cluster.id, 'onOff', onOff, endpointToControl.bridgedDevice.log);
    //           endpointToControl.bridgedDevice?.commandHandler.executeHandler(onOff ? 'on' : 'off');
    //         }
    //         if (sceneExecutionActions.brightness !== undefined) {
    //           const brightness = Number(sceneExecutionActions.brightness);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(LevelControl.Cluster.id, 'currentLevel', brightness, endpointToControl.bridgedDevice.log);
    //           endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToLevel', { request: { level: brightness } });
    //         }
    //         if (sceneExecutionActions.colorTemperature !== undefined) {
    //           const colorTemperature = Number(sceneExecutionActions.colorTemperature);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', colorTemperature, endpointToControl.bridgedDevice.log);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpointToControl.bridgedDevice.log);
    //           endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToColorTemperature', { request: { colorTemperatureMireds: colorTemperature } });
    //         }
    //         if (sceneExecutionActions.colorX !== undefined && sceneExecutionActions.colorY !== undefined) {
    //           const colorX = Number(sceneExecutionActions.colorX);
    //           const colorY = Number(sceneExecutionActions.colorY);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentX', colorX, endpointToControl.bridgedDevice.log);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentY', colorY, endpointToControl.bridgedDevice.log);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentXAndCurrentY, endpointToControl.bridgedDevice.log);
    //           endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToColor', { request: { colorX, colorY } });
    //         }
    //         if (sceneExecutionActions.hue !== undefined && sceneExecutionActions.saturation !== undefined) {
    //           const hue = Number(sceneExecutionActions.hue);
    //           const saturation = Number(sceneExecutionActions.saturation);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentHue', hue, endpointToControl.bridgedDevice.log);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'currentSaturation', saturation, endpointToControl.bridgedDevice.log);
    //           /* await */ endpointToControl.bridgedDevice?.setAttribute(ColorControl.Cluster.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, endpointToControl.bridgedDevice.log);
    //           endpointToControl.bridgedDevice?.commandHandler.executeHandler('moveToHueAndSaturation', { request: { hue, saturation } });
    //         }
    //         // Allow also triggering buttons actions, so in HomeKit it will execute the button automation.
    //         if (sceneExecutionActions?.buttonAction === 'Single' || sceneExecutionActions?.buttonAction === 'Double' || sceneExecutionActions?.buttonAction === 'Long' || sceneExecutionActions?.buttonAction === 'Press' || sceneExecutionActions?.buttonAction === 'Release') {
    //           // TODO: Test if it functions properly.
    //           endpointToControl.bridgedDevice?.triggerSwitchEvent(sceneExecutionActions.buttonAction);
    //         }
    //       }
    //     }
    //   }
    // }

    // // const buttonService = panelSensor.buttonServices[sceneNo];
    // panelDevice?.bridgedDevice?.getChildEndpoint(EndpointNumber(sceneNo))?.triggerSwitchEvent('Single'); // issue a single press event...
    // this.log.info('Scene Activated... from: ' + deviceEndpointPath + ', Hex data: ' + data);
  }

  processIncomingRotationPercentageEvent(switchIeee: string, rotationPercentage: number, newPayload: Payload) {
    const actionsConfig = this.switchesActionsConfig[switchIeee + '/action_rotation_percent_speed' + '_' + newPayload['action_rotation_button_state']];
    if (actionsConfig.enabled) {
      for (const linkedDevice in actionsConfig.linkedDevices) {
        if (!linkedDevice.startsWith('http')) { // TODO: find the correct way on this new system...
          const actionToDo = actionsConfig.linkedDevices[linkedDevice];
          const pathComponents = linkedDevice.split('/');
          const entityIeee = pathComponents[0];
          const entityEndpoint = pathComponents[1] ? '_' + pathComponents[1] : '';
          const entityToControl = this.getDeviceEntity(entityIeee);
          const endpointToControl = entityEndpoint !== '' ? entityToControl?.bridgedDevice?.getChildEndpointById(entityEndpoint.substring(1)) : entityToControl?.bridgedDevice;

          if (entityToControl) {
            if (actionToDo === 'brightness') {
              if (endpointToControl?.hasClusterServer(LevelControl.Cluster.id) && endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                if (!endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff')) {
                  if (rotationPercentage > 0) {
                    if (this.lastStates[entityIeee]['brightness' + entityEndpoint] !== 3 || this.lastStates[entityIeee]['state' + entityEndpoint] !== 'ON') {
                      this.publishCommand(entityIeee, { ['brightness' + entityEndpoint]: 3, ['state' + entityEndpoint]: 'ON' });
                      // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                    }
                  }
                } else {
                  const currentBrightness = Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                  const newBrightnessState = Math.round((Math.max(3, Math.min(254, currentBrightness + (rotationPercentage * 2.54))) / 254) * 255); // 3 is 1% and 254 is 100% in the 255 scale...
                  if (this.lastStates[entityIeee]['brightness' + entityEndpoint] !== newBrightnessState) {
                    this.publishCommand(entityIeee, { ['brightness' + entityEndpoint]: newBrightnessState });
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  }
                }
              }
            } else if (actionToDo === 'color_temp') {
              if (endpointToControl?.hasClusterServer(ColorControl.Cluster.id) && endpointToControl?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                const currentColorTemperature = endpointToControl?.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
                const newColorTemperatureState = Math.round(Math.max(153, Math.min(500, currentColorTemperature + rotationPercentage))); // TODO: take the min/max from the object itself...
                if (this.lastStates[entityIeee]['color_temp' + entityEndpoint] !== newColorTemperatureState) {
                  this.publishCommand(entityIeee, { ['color_temp' + entityEndpoint]: newColorTemperatureState });
                  // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                }
              }
            }
          }
        } else {
          // const actionToDo = actionsConfig.httpActionsToDo[resourceToExecute];
          // if (/* this.platform.state.remotes_on && */ actionToDo) {
          //   // const jsonObject = JSON.parse(JSON.stringify(actionConfig.json))
          //   // jsonObject.action = actionToDo

          //   const jsonObject = JSON.parse(JSON.stringify(actionToDo.body_json['' + buttonevent]));
          //   const data = JSON.stringify(jsonObject);

          //   const options = {
          //     hostname: actionToDo.host,
          //     port: actionToDo.port,
          //     path: actionToDo.path,
          //     method: 'POST',
          //     headers: {
          //       'Content-Type': 'application/json',
          //       'Content-Length': data.length,
          //     },
          //   };

          //   const repeatFunction = (delay: number, timeoutKey: string) => {
          //     this.longPressTimeoutIDs[timeoutKey] = setTimeout(() => {
          //       this.log.info('Long press being on URL!!!');

          //       const req = http.request(options, (res) => {
          //         this.log.info(`statusCode: ${res.statusCode}`);

          //         if (res.statusCode === 200) {
          //           this.log.info('Command sent and received successfully');
          //         }

          //         res.on('data', d => {
          //           // process.stdout.write(d)
          //           this.log.info(d);
          //         });
          //       });

          //       req.on('error', (error) => {
          //         console.error(error);
          //       });

          //       req.write(data);
          //       req.end();

          //       // TODO: check and make a logic to specify when to start and stop the repeating process (currently all operations will be repeated until next buttonevent)
          //       repeatFunction(300, timeoutKey);
          //     }, delay);
          //   };
          //   repeatFunction(0, keyForTimeoutAction);
          // }
        }
      }
    }
  }

  processIncomingButtonEvent(switchIeee: string, buttonEvent: string) {
    const actionsConfigPreConfiguredSwitchType = this.switchesActionsConfig[switchIeee];
    const switchTypeInt = actionsConfigPreConfiguredSwitchType?.switchType; // 0 = Old IKEA round 5 button remote, 1 = Hue Switch Remote, 2 = New IKEA rect 4 buttons (Supports the 2 buttons one [No CT control])
    const actionsConfig = this.switchesActionsConfig[switchIeee + '/' + buttonEvent];
    const combinedLinks = [];
    if (actionsConfigPreConfiguredSwitchType && actionsConfigPreConfiguredSwitchType.enabled && switchTypeInt) {
      this.log.info('Switch: ' + switchIeee + ', button event: ' + buttonEvent + ', config: ', JSON.stringify(actionsConfigPreConfiguredSwitchType));
      combinedLinks.push(actionsConfigPreConfiguredSwitchType.linkedDevices);
    }
    if (actionsConfig && actionsConfig.enabled) {
      this.log.info('Switch: ' + switchIeee + '/' + buttonEvent + ', config: ', JSON.stringify(actionsConfig));
      combinedLinks.push(actionsConfig.linkedDevices);
    }

    if (combinedLinks.length) {
      for (let index = 0; index < combinedLinks.length; index++) {
        const endpointsToExecute = combinedLinks[index];

        for (const endpointToExecute in endpointsToExecute) {
          // First cancel any timeouts we've created for the long press handling...
          const keyForTimeoutAction = switchIeee + endpointToExecute;
          clearTimeout(this.longPressTimeoutIDs[keyForTimeoutAction]);

          if (!endpointToExecute.startsWith('http')) { // TODO: find the correct way on this new system...
            let continueRepeat = true;
            let actionToDo = endpointsToExecute[endpointToExecute] || ''; // The value: like 'ON' in case of state...

            if (actionToDo === '') { // Its a switchType based action...
              if (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons) {
                continueRepeat = false;
              }
              if (
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'brightness_move_up') ||
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_up_hold') ||
                (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'up_hold')
              ) {
                // Start Increasing the Brightness and turn on at lowest brighness if Off...
                actionToDo = 'on_low_bri_up';
              } else if (
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'brightness_move_down') ||
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_down_hold') ||
                (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'down_hold')
              ) {
                actionToDo = 'bri_down';
              } else if (
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) &&
                buttonEvent === 'arrow_right_hold'
              ) {
                actionToDo = 'ct_down';
              } else if (
                (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) &&
                buttonEvent === 'arrow_left_hold'
              ) {
                actionToDo = 'ct_up';
              } else {
                continueRepeat = false;

                if (
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'toggle_hold') ||
                  (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'on_hold')
                ) {
                  // Turn On with default settings (including CT)...
                  actionToDo = 'on_defaults';
                } else if (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'toggle') { // Toggle power and if  it turns on, set to full brightness...
                  actionToDo = 'toggle_on_full_bri';
                } else if (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'on_press') { // Turn On and if On already, set to full brightness...
                  actionToDo = 'on_or_full_bri';
                } else if (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'on') { // Turn On at full brightness and if On already just increase the brightness...
                  actionToDo = 'on_full_bri_or_bri_up';
                } else if (
                  (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'up_press') ||
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_up_click')
                ) {
                  // Turn On with lowest brightness or increase the brightness if On already
                  actionToDo = 'on_low_bri_up';
                } else if (
                  (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'down_press') ||
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_down_click')
                ) {
                  // Decrease the brightness
                  actionToDo = 'bri_down';
                } else if (
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) &&
                  buttonEvent === 'arrow_right_click'
                ) {
                  // Increase the CT
                  actionToDo = 'ct_down';
                } else if (
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || switchTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) &&
                  buttonEvent === 'arrow_left_click'
                ) {
                  // Decrease the CT
                  actionToDo = 'ct_up';
                } else if (
                  (switchTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'off') ||
                  (switchTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'off_press')
                ) {
                  actionToDo = 'off';
                }
              }
            } else {
              continueRepeat = actionsConfig.repeat || false;
            }

            const pathComponents = endpointToExecute.split('/');
            const entityIeee = pathComponents[0];
            const entityEndpoint = pathComponents[1] ? '_' + pathComponents[1] : '';
            const entityToControl = this.getDeviceEntity(entityIeee);
            const endpointToControl = entityEndpoint !== '' ? entityToControl?.bridgedDevice?.getChildEndpointById(entityEndpoint.substring(1)) : entityToControl?.bridgedDevice;

            if (entityToControl) {
              const repeatZBFunction = (delay: number, timeoutKey: string) => {
                this.longPressTimeoutIDs[timeoutKey] = setTimeout(() => {
                  if (typeof actionToDo === 'string' && actionToDo.startsWith('on_low_bri')) {
                    if (endpointToControl?.hasClusterServer(LevelControl.Cluster.id) && endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      if (!endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff')) {
                        this.publishCommand(entityIeee, { ['brightness' + entityEndpoint]: 3, ['state' + entityEndpoint]: 'ON' });
                        // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                        if (actionToDo === 'on_low_bri') {
                          continueRepeat = false;
                        }
                      } else if (actionToDo === 'on_low_bri_up') {
                        const currentBrightness = Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                        const newBrightnessState = Math.min(254, currentBrightness + 13); // 254 is 100% in the 255 scale...
                        this.publishCommand(entityIeee, { ['brightness' + entityEndpoint]: newBrightnessState });
                        // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                        if (newBrightnessState === 254) {
                          continueRepeat = false;
                        }
                      } else {
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'bri_down') {
                    if (endpointToControl?.hasClusterServer(LevelControl.Cluster.id) && endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      const currentBrightness = Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      const newBrightnessState = Math.max(3, currentBrightness - 13); // 3 is 1% in the 255 scale...
                      this.publishCommand(entityIeee, { ['brightness' + entityEndpoint]: newBrightnessState });
                      // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                      if (newBrightnessState === 3) {
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'ct_down') {
                    if (endpointToControl?.hasClusterServer(ColorControl.Cluster.id) && endpointToControl?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      const currentColorTemperature = endpointToControl?.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
                      const newColorTemperatureState = Math.max(153, currentColorTemperature - 32);
                      this.publishCommand(entityIeee, { ['color_temp' + entityEndpoint]: newColorTemperatureState });
                      // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                      if (newColorTemperatureState === 153) { // TODO: take the min/max from the object itself...
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'ct_up') {
                    if (endpointToControl?.hasClusterServer(ColorControl.Cluster.id) && endpointToControl?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      const currentColorTemperature = endpointToControl?.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
                      const newColorTemperatureState = Math.min(500, currentColorTemperature + 32);
                      this.publishCommand(entityIeee, { ['color_temp' + entityEndpoint]: newColorTemperatureState });
                      // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                      if (newColorTemperatureState === 500) { // TODO: take the min/max from the object itself...
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'on_defaults') {
                    const payload: Payload = { ['state' + entityEndpoint]: 'ON' };
                    if (endpointToControl?.hasClusterServer(LevelControl.Cluster.id) && endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      payload['brightness' + entityEndpoint] = 254;
                    }
                    if (endpointToControl?.hasClusterServer(ColorControl.Cluster.id) && endpointToControl?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      // service.getCharacteristic(that.platform.Characteristics.hap.ColorTemperature).setValue(actionsConfig.actionsToDo?.['' + buttonevent]?.defaultCT || 363)
                      payload['color_temp' + entityEndpoint] = 363;
                    }
                    this.publishCommand(entityIeee, payload);
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  } else if (typeof actionToDo === 'string' && actionToDo.startsWith('toggle_on')) {
                    const currentOnOff = endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff');
                    const newPowerState = !currentOnOff;
                    const payload: Payload = { ['state' + entityEndpoint]: newPowerState ? 'ON' : 'OFF' };
                    if (
                      actionToDo === 'toggle_on_full_bri' &&
                      newPowerState &&
                      endpointToControl?.hasClusterServer(LevelControl.Cluster.id) &&
                      endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')
                    ) {
                      const currentBrightness = Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      if (currentBrightness !== 254) {
                        payload['brightness' + entityEndpoint] = 254;
                      }
                    }
                    this.publishCommand(entityIeee, payload);
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  } else if (actionToDo === 'on_or_full_bri') {
                    const currentOnOff = endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff');
                    const payload: Payload = { ['state' + entityEndpoint]: 'ON' };
                    if (
                      currentOnOff &&
                      endpointToControl?.hasClusterServer(LevelControl.Cluster.id) &&
                      endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')
                    ) {
                      if (Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255) !== 254) {
                        payload['brightness' + entityEndpoint] = 254;
                      }
                    }
                    this.publishCommand(entityIeee, payload);
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  } else if (actionToDo === 'on_full_bri_or_bri_up') {
                    const payload: Payload = {};
                    const currentOnOff = endpointToControl?.getAttribute(OnOff.Cluster.id, 'onOff');
                    if (!currentOnOff) {
                      payload['state' + entityEndpoint] = 'ON';
                    }
                    if (endpointToControl?.hasClusterServer(LevelControl.Cluster.id) && endpointToControl?.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      const currentBrightness = Math.round((endpointToControl?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      if (!currentOnOff) {
                        if (currentBrightness !== 254) {
                          payload['brightness' + entityEndpoint] = 254;
                        }
                      } else {
                        const newBrightnessState = Math.min(254, currentBrightness + 13); // 254 is 100% in the 255 scale...
                        payload['brightness' + entityEndpoint] = newBrightnessState;
                      }
                    }
                    this.publishCommand(entityIeee, payload);
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  } else if (actionToDo === 'off') {
                    this.publishCommand(entityIeee, { ['state' + entityEndpoint]: 'OFF' });
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  } else {
                    // const service = accessoryToControl.serviceByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                    // const characteristics = actionsConfig.actionsToDo['' + buttonevent].characteristics
                    // for (let ii = 0; ii < characteristics.length; ii++) {
                    //   const characteristicData = characteristics[ii]
                    //   service._characteristicDelegates[characteristicData.key]?._characteristic?.setValue(characteristicData.value)
                    // }
                    // This is a command to send an endpoint...
                    this.publishCommand(entityIeee, { [entityEndpoint]: actionToDo });
                    // No need to set noUpdate to false since here its switches control and the trigger is not a lights which turned on or off etc but action of a button...
                  }

                  if (continueRepeat) {
                    this.log.info('Long press being on ZigBee service!!!');
                    repeatZBFunction(300, timeoutKey);
                  }
                }, delay);
              };
              repeatZBFunction(0, keyForTimeoutAction);
            }
          } else {
            // const actionToDo = actionsConfig.httpActionsToDo[resourceToExecute];
            // if (/* this.platform.state.remotes_on && */ actionToDo) {
            //   // const jsonObject = JSON.parse(JSON.stringify(actionConfig.json))
            //   // jsonObject.action = actionToDo

            //   const jsonObject = JSON.parse(JSON.stringify(actionToDo.body_json['' + buttonevent]));
            //   const data = JSON.stringify(jsonObject);

            //   const options = {
            //     hostname: actionToDo.host,
            //     port: actionToDo.port,
            //     path: actionToDo.path,
            //     method: 'POST',
            //     headers: {
            //       'Content-Type': 'application/json',
            //       'Content-Length': data.length,
            //     },
            //   };

            //   const repeatFunction = (delay: number, timeoutKey: string) => {
            //     this.longPressTimeoutIDs[timeoutKey] = setTimeout(() => {
            //       this.log.info('Long press being on URL!!!');

            //       const req = http.request(options, (res) => {
            //         this.log.info(`statusCode: ${res.statusCode}`);

            //         if (res.statusCode === 200) {
            //           this.log.info('Command sent and received successfully');
            //         }

            //         res.on('data', d => {
            //           // process.stdout.write(d)
            //           this.log.info(d);
            //         });
            //       });

            //       req.on('error', (error) => {
            //         console.error(error);
            //       });

            //       req.write(data);
            //       req.end();

            //       // TODO: check and make a logic to specify when to start and stop the repeating process (currently all operations will be repeated until next buttonevent)
            //       repeatFunction(300, timeoutKey);
            //     }, delay);
            //   };
            //   repeatFunction(0, keyForTimeoutAction);
            // }
          }
        }
      }
    }
  }
}
