// matterbridge-zigbee2mqtt-al/src/stateValidatorController.js
// Copyright © 2026 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import { MatterbridgeEndpoint } from 'matterbridge';
import { AnsiLogger, LogLevel, TimestampFormat } from 'matterbridge/logger';
import { ColorControl, LevelControl, OnOff /* , Thermostat, WindowCovering */ } from 'matterbridge/matter/clusters';
// import { EndpointNumber } from 'matterbridge/matter';
import { /* deepCopy,*/ deepEqual } from 'matterbridge/utils';

import { ZigbeeEntity } from './entity.js';
import type { ZigbeePlatform } from './module.js';
// import { OnOff } from 'matterbridge/matter/clusters';
import type { Payload, PayloadValue } from './payloadTypes.js';

declare module './entity.js' {
  interface ZigbeeEntity {
    // sendState(commandName: string, data: Payload, cache: boolean): void;
    updateLastPayloadItem(key: string, value: string | number | boolean): void;
    getLastPayloadItem(key: string): PayloadValue;
    setNoUpdate(noUpdate: boolean): void;
    checkIfPropertyItemShouldBeExposed(key: string): boolean;
    getEndpointOfProperty(property: string): string | undefined;
    getPropertyMap(): Map<string, { name: string; type: string; endpoint: string }>;
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
  if (this.isGroup) {
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
ZigbeeEntity.prototype.getEndpointOfProperty = function (property: string): string | undefined {
  return this.propertyMap.get(property)?.endpoint;
};
ZigbeeEntity.prototype.getPropertyMap = function (): Map<string, { name: string; type: string; endpoint: string }> {
  return this.propertyMap;
};

export class StateValidatorController {
  public log: AnsiLogger;
  platform: ZigbeePlatform;
  lastStates: { [key: string]: Payload } = {};
  monitoredEndpoints: { [key: string]: string | number }[];
  currentEndpointPutIndex: number;

  constructor(platform: ZigbeePlatform) {
    this.platform = platform;
    this.monitoredEndpoints = [];
    this.currentEndpointPutIndex = 0;

    this.log = new AnsiLogger({
      logName: 'StateValidatorController',
      logTimestampFormat: TimestampFormat.TIME_MILLIS,
      logLevel: platform.config.debug ? LogLevel.DEBUG : platform.log.logLevel,
    });
    this.log.debug(`Loaded: StateValidatorController`);
  }

  getDeviceEntity(ieee_address: string, separatedEndpointID?: string): ZigbeeEntity | undefined {
    const entity = ieee_address.startsWith('group-')
      ? this.platform.zigbeeEntities?.find((entity) => entity.isGroup && entity.group?.id === Number(ieee_address.split('-')[1]))
      : this.platform.zigbeeEntities?.find(
          (entity) =>
            entity.isDevice &&
            entity.device?.ieee_address === ieee_address &&
            (!separatedEndpointID || (separatedEndpointID && entity.bridgedDevice?.deviceName?.endsWith(separatedEndpointID))),
        );
    return entity;
  }

  publishCommand(device_ieee_address: string, payload: Payload): void {
    this.platform.publish(device_ieee_address, 'set', JSON.stringify(payload));
  }

  setStateValidatorControllerConfiguration(): void {
    this.currentEndpointPutIndex = 0;
    this.loadEndpointsToMonitor();
    setTimeout(() => {
      this.heartbeat(0);
    }, 5000);
  }

  loadEndpointsToMonitor(): void {
    this.monitoredEndpoints = [];
    const accessoriesArray = this.platform.zigbeeEntities;
    const effectiveEndpointTypes = new Set(['light', 'switch', 'outlet']);
    for (let i = 0; i < accessoriesArray.length; i++) {
      const entity = accessoriesArray[i];
      const propertiesMap = entity.getPropertyMap();
      // const servicesKeys = propertiesMap.keys();
      for (const key of propertiesMap.keys()) {
        const propertyMapObject = propertiesMap.get(key);
        if (propertyMapObject?.name === 'state' && effectiveEndpointTypes.has(propertyMapObject.type)) {
          const serviceToExamine =
            entity.isGroup && entity.group?.id ? 'group-' + entity.group.id : entity.isDevice && entity.device?.ieee_address ? entity.device.ieee_address : '';
          this.monitoredEndpoints.push({ deviceId: serviceToExamine, property: key, putStateCounter: 0 });
        }
      }
    }
  }

  heartbeat(beatNo: number): void {
    // this.platform._configJson.putStateEvery // Seconds!!!
    this.log.info('Heartbeat! ' + beatNo);

    if (this.monitoredEndpoints.length) {
      const index = this.platform.config.putStateRepeatCount > 0 ? this.currentEndpointPutIndex : beatNo % this.monitoredEndpoints.length;
      const endpoint = this.monitoredEndpoints[index];
      const lastState = this.lastStates[endpoint.deviceId]?.[endpoint.property];
      this.log.info('putState: ' + index + ', id: ' + endpoint.deviceId + ', property: ' + endpoint.property + ', lastState: ' + lastState);
      this.log.info('LastStates: ' + JSON.stringify(this.lastStates));
      if (lastState) {
        this.publishCommand(endpoint.deviceId as string, { [endpoint.property]: lastState });
      }
      if (this.platform.config.putStateRepeatCount > 0) {
        (endpoint.putStateCounter as number)++;
        if (endpoint.putStateCounter === this.platform.config.putStateRepeatCount) {
          this.monitoredEndpoints.splice(index, 1);
        } else {
          this.currentEndpointPutIndex++;
        }
        if (this.monitoredEndpoints.length === this.currentEndpointPutIndex) {
          this.currentEndpointPutIndex = 0;
          this.loadEndpointsToMonitor();
        }
      }
    }

    setTimeout(() => {
      this.heartbeat(beatNo + 1);
    }, 5000);
  }

  deviceHasChangedMatterAttributeInSwitchesOffMode(deviceIeee: string, endpoint: string, attribute: string, value: boolean | number, oldValue: boolean | number): void {
    this.deviceHasChangedMatterAttribute(deviceIeee, endpoint, attribute, value, oldValue, true);
  }

  // Should be called when matter side changed (By incoming event from z2m by manual control or z2m frontend control of a switch or light, or when user uses matter to control z2m - actionSourceIsFromMatter is true then...)
  // When actionSourceIsFromMatter is true, oldValue can be undefined...
  // If actionSourceIsFromMatter true, it means the change is from matter side (switching on/off from apps etc), if false, it means its from the device has changed (turned on on the physical device side or z2m FE for example)...
  // Make sure all calls to this method is after verified change of attribute value... (onOff changed from true to false etc..)
  deviceHasChangedMatterAttribute(
    deviceIeee: string,
    endpoint: string,
    attribute: string,
    value: boolean | number,
    oldValue: boolean | number,
    actionSourceIsFromMatter: boolean,
  ): boolean {
    if (attribute === 'onOff' || attribute === 'currentLevel') {
      const z2mValue = attribute === 'onOff' ? (value ? 'ON' : 'OFF') : value;
      const changedPropertyName = attribute === 'onOff' ? 'state' : 'brightness';
      const deviceEndpoint = deviceIeee + '/' + changedPropertyName + endpoint;
      // TODO: Maybe check if its supposed to be monitored...
      if (!this.lastStates[deviceIeee]) {
        this.lastStates[deviceIeee] = {};
      }
      this.lastStates[deviceIeee][changedPropertyName + endpoint] = z2mValue;
    }
    return true;
  }
}
