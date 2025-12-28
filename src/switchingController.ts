// import * as fs from 'node:fs';
// import * as https from 'node:https';
// import * as http from 'node:http';
// import * as url from 'node:url';
// import * as qs from 'node:querystring';
// import * as path from 'node:path';
// import { ClientRequest, IncomingMessage } from 'node:http';

import { AnsiLogger, TimestampFormat, LogLevel } from 'node-ansi-logger';
// import { MatterbridgeEndpoint } from 'matterbridge';
// import { BridgedDeviceBasicInformation, ColorControl, LevelControl, OnOff, Thermostat, WindowCovering } from 'matterbridge/matter/clusters';
// import { EndpointNumber } from 'matterbridge/matter';

import { ZigbeePlatform } from './module.js';
import { ZigbeeEntity } from './entity.js';
// import { OnOff } from 'matterbridge/matter/clusters';
import { Payload, PayloadValue } from './payloadTypes.js';

declare module './entity.js' {
  interface ZigbeeEntity {
    sendState(commandName: string, data: Payload, cache: boolean): void;
    updateLastPayloadItem(key: string, value: string | number | boolean): void;
    getLastPayloadItem(key: string): PayloadValue;
  }
}

ZigbeeEntity.prototype.sendState = function (commandName: string, data: Payload, cache: boolean): void {
  // this.saveCommands('off', dataToSend);
  // this.log.debug(`Aqara S1 Scene Panel Command send called for ${this.ien}${this.isGroup ? this.group?.friendly_name : this.device?.friendly_name}${rs}${db} endpoint: ${dataToSend.endpoint?.maybeId}:${dataToSend.endpoint?.maybeNumber}`);
  // const isChildEndpoint = dataToSend.endpoint.deviceName !== this.entityName;
  if (cache) {
    this.cachePublish(commandName, data);
  } else {
    this.publishCommand(commandName, this.device?.friendly_name as string, data);
    this.noUpdate = false;
  }
};

ZigbeeEntity.prototype.updateLastPayloadItem = function (key: string, value: string): void {
  this.lastPayload[key] = value;
};
ZigbeeEntity.prototype.getLastPayloadItem = function (key: string): PayloadValue {
  return this.lastPayload[key];
};

export interface SwitchingControllerSwitchConfig {
  enabled: boolean;
  vice_versa: boolean;
  linkedDevices?: string[]; // ["0x54abcd0987654321/l1_brightness", "0x541234567890abcd/l1_brightness"]
}

export class SwitchingController {
  public log: AnsiLogger;
  platform: ZigbeePlatform;
  switchesLinksConfig: { [key: string]: SwitchingControllerSwitchConfig }; // {"0x541234567890abcd/l2_brightness": {enabled: true, vice_versa: true, linkedDevice:["0x54abcd0987654321/brightness_l1", "0x541234567890abcd/brightness_l1"]}, "0x541234567890abcd/state_left": {enabled: true, vice_versa: true, linkedDevice:["0x54abcd0987654321/state_l1", "0x541234567890abcd/state_l2"]}}
  switchesActionsConfigData: { [key: string]: string[] };
  entitiesExecutionQueues: { [key: string]: { [key: string]: PayloadValue } } = {}; // {"0x541234567890abcd": {'brightness_l3_ON': 'brightness_l2'}}

  constructor(platform: ZigbeePlatform, switchesLinksConfig: { [key: string]: SwitchingControllerSwitchConfig }) {
    this.platform = platform;
    this.switchesLinksConfig = switchesLinksConfig;
    this.switchesActionsConfigData = {};

    for (const sourceDevice in this.switchesLinksConfig) {
      const linkConfig = this.switchesLinksConfig[sourceDevice];
      if (linkConfig.enabled) {
        const linkedDevices = linkConfig.linkedDevices || [];
        this.switchesActionsConfigData[sourceDevice] = linkedDevices;
        if (linkConfig.vice_versa) {
          for (let index = 0; index < linkedDevices.length; index++) {
            const linkedDeviceItem = linkedDevices[index];
            if (!this.switchesActionsConfigData[linkedDeviceItem]) this.switchesActionsConfigData[linkedDeviceItem] = [];
            const linkedDeviceLinks = this.switchesActionsConfigData[linkedDeviceItem];
            linkedDeviceLinks.push(sourceDevice);
          }

          for (let index = 0; index < linkedDevices.length; index++) {
            const linkedDeviceItem = linkedDevices[index];
            const linkedDeviceLinks = this.switchesActionsConfigData[linkedDeviceItem];

            for (let index2 = 0; index2 < linkedDeviceLinks.length; index2++) {
              const element = linkedDeviceLinks[index2];
              const linkesOfLinkedDeviceLinks = this.switchesActionsConfigData[element] || [];
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
    this.log.debug('switchesActionsConfigData contents: ' + JSON.stringify(this.switchesActionsConfigData));
  }

  getDeviceEntity(ieee_address: string) {
    const entity = this.platform.zigbeeEntities?.find((entity) => entity.device?.ieee_address === ieee_address);
    return entity;
  }

  // deviceEndpointPath is the device IEEE address with the endpoint, data is the changed state
  // for example, if the deviceEndpointPath is: /0x541234567890abcd/state_left and data is 'ON', then it means that a device with childEndpoint named state_left have turned on.
  switchStateChanged(deviceEndpointPath: string, data: string | number | boolean, newPayload: Payload) {
    const linkedDevices = this.switchesActionsConfigData[deviceEndpointPath] || [];
    if (!linkedDevices.length) {
      return;
    }

    const deviceEndpointPathComponents = deviceEndpointPath.split('/');
    const deviceIeee = deviceEndpointPathComponents[0];

    if (this.entitiesExecutionQueues[deviceIeee] && Object.keys(this.entitiesExecutionQueues[deviceIeee]).length > 1) { // > 1 because we save the data also and never remove it (will overwritten when a new queue is constructed)
      const queueData = this.entitiesExecutionQueues[deviceIeee]['data'];
      const entityToControl = this.getDeviceEntity(deviceIeee);
      // Enforce the desired state until completion of the queue...
      if (queueData !== data) {
        entityToControl?.sendState('cachedPublishLight', { [deviceEndpointPathComponents[1]]: queueData }, false);
      } else {
        const entityQueue = this.entitiesExecutionQueues[deviceIeee];
        const nextExecution = entityQueue[deviceEndpointPathComponents[1] + '_' + data];
        if (nextExecution !== undefined) {
          if (nextExecution !== '') {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete entityQueue[deviceEndpointPathComponents[1] + '_' + data];
            entityToControl?.sendState('cachedPublishLight', { [nextExecution as string]: data }, false);
          } else { // For the last action in the chain use delay to unlock the linkage (should be for Tuya only which have toggling issues when changing multiple endpoints of an entity in short amount of time).
            setTimeout(() => {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete entityQueue[deviceEndpointPathComponents[1] + '_' + data];
            }, 2000); // When it was 1000, then controlling tuya from matterbridge itself too quickly used to create a racing condition and endless toggling of the all switches on this device entities involved...
          }
        }
      }
      return;
    }

    const payloads: { [key: string]: { [key: string]: string | number | boolean } } = {};
    for (let i = linkedDevices.length - 1; i >= 0; i--) {
      const linkedDeviceItem = linkedDevices[i];
      const linkedDevicePathComponents = linkedDeviceItem.split('/');
      const linkedDeviceIeee = linkedDevicePathComponents[0];
      const entityToControl = this.getDeviceEntity(linkedDeviceIeee);

      if (entityToControl) {
        const paramToControl = linkedDevicePathComponents[1];
        if ((linkedDeviceIeee === deviceIeee && newPayload[paramToControl] !== data) || (linkedDeviceIeee !== deviceIeee && entityToControl.getLastPayloadItem(paramToControl) !== data)) { // Don't update whats not needed to be updated...
          // const entityToControlEndpoints = entityToControl.device?.endpoints;
          // if (typeof entityToControlEndpoints === 'object' && Object.keys(entityToControlEndpoints).length === 1 && entityToControlEndpoints['1'].clusters.input.includes('manuSpecificTuya') && !entityToControlEndpoints['1'].clusters.input.includes('genOnOff')) {
          //   // This is tuya, needs special queue logic
          //   this.log.info('This is a Tuya device, using queues for switching control logic...');

            if (!payloads[linkedDeviceIeee]) {
              payloads[linkedDeviceIeee] = {};
            }
            payloads[linkedDeviceIeee][paramToControl] = data;
          // } else {
          //   entityToControl.sendState('cachedPublishLight', { [paramToControl]: data }, true);
          // }

          // entityToControl.updateLastPayloadItem(paramToControl, data);
          // if (linkedDeviceIeee === deviceIeee) {
          //   newPayload[paramToControl] = data;
          // }
        }

        // const endpoint = entityToControl.bridgedDevice?.getChildEndpointById(paramToControl.split('_')[1]);
        // endpoint?.commandHandler.executeHandler(data === 'ON' ? 'on' : 'off', { cluster: OnOff.Cluster.id, endpoint: endpoint });
      }
    }

    for (const entity in payloads) {
      const payload = payloads[entity];
      const endpoints = Object.keys(payload);
      const entityToControl = this.getDeviceEntity(entity);
      if (endpoints.length > 1) {
        if (!this.entitiesExecutionQueues[entity]) {
          this.entitiesExecutionQueues[entity] = {};
        }
        for (let index = 0; index < endpoints.length - 1; index++) {
          const endpoint = endpoints[index];
          this.entitiesExecutionQueues[entity][endpoint + '_' + data] = endpoints[index + 1];
        }
        this.entitiesExecutionQueues[entity][endpoints[endpoints.length - 1] + '_' + data] = '';
        this.entitiesExecutionQueues[entity]['data'] = data;
        const paramToControl = endpoints[0];
        entityToControl?.sendState('cachedPublishLight', { [paramToControl]: data }, false);
      } else {
        if (payload && entityToControl) {
          entityToControl.sendState('cachedPublishLight', payload, true);
        }
      }
    }

    if (newPayload) {
      //
    }

    if (this.platform.platformControls?.switchesOn) {
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
  }
}
