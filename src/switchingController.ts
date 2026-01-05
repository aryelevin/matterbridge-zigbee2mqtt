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

import { ZigbeePlatform } from './module.js';
import { ZigbeeEntity } from './entity.js';
// import { OnOff } from 'matterbridge/matter/clusters';
import { Payload, PayloadValue } from './payloadTypes.js';
import { deepCopy, deepEqual } from 'matterbridge/utils';

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
type SwitchType = typeof SwitchTypes[keyof typeof SwitchTypes];

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
  entitiesExecutionQueues: { [key: string]: { [key: string]: PayloadValue } } = {}; // {"0x541234567890abcd": {'brightness_l3_ON': 'brightness_l2', 'data': 200}} // PayloadValue is because the data field...
  switchesActionsConfig: { [key: string]: SwitchingControllerSwitchConfig }; // {'0x541234567890abcd': {'enabled': true, switchType: 2, 'linkedDevices': {'0x54abcd0987654321': 'l1', '0x54abcd0987654322': 'center'}}, '0x541234567890abcd/single': {'enabled': true, 'repeat': false, 'linkedDevices': {'0x54abcd0987654321/state_l1': 'ON', '0x54abcd0987654322/toggle_on': 'l3'}}, '0x541234567890abcd/hold': {'enabled': true, 'repeat': true, 'linkedDevices': {'0x54abcd0987654321/brightness_l1': 254, '0x54abcd0987654322/bri_up': 'center'}}, '0x541234567890abcd/double': {'enabled': true, 'repeat': false, 'linkedDevices': {'0x54abcd0987654321/characteristic': {state_left: ON}, '0x54abcd0987654322/bri_up': 'l2'}}}
  // switchesActionsConfigData: { [key: string]: { [key: string]: PayloadValue } } = {};
  longPressTimeoutIDs: { [key: string]: NodeJS.Timeout } = {};
  lastStates: { [key: string]: Payload } = {};

  constructor(platform: ZigbeePlatform, switchesLinksConfig: { [key: string]: SwitchingControllerSwitchLinkConfig }, switchesActionsConfig: { [key: string]: SwitchingControllerSwitchConfig }) {
    this.platform = platform;
    this.switchesLinksConfig = switchesLinksConfig;
    this.switchesLinksConfigData = {};
    this.switchesActionsConfig = switchesActionsConfig;
    // this.switchesActionsConfigData = {};

    for (const sourceDevice in this.switchesLinksConfig) {
      const linkConfig = this.switchesLinksConfig[sourceDevice];
      if (linkConfig.enabled) {
        const linkedDevices = linkConfig.linkedDevices || [];
        this.switchesLinksConfigData[sourceDevice] = linkedDevices;
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

    for (const sourceDevice in this.switchesActionsConfig) {
      const actionsConfig = this.switchesActionsConfig[sourceDevice];
      if (actionsConfig.enabled) {
        // const linkedDevices = actionsConfig.linkedDevices || {};
        // this.switchesLinksConfigData[sourceDevice] = linkedDevices;
        // if (linkConfig.vice_versa) {
        //   for (let index = 0; index < linkedDevices.length; index++) {
        //     const linkedDeviceItem = linkedDevices[index];
        //     if (!this.switchesLinksConfigData[linkedDeviceItem]) this.switchesLinksConfigData[linkedDeviceItem] = [];
        //     const linkedDeviceLinks = this.switchesLinksConfigData[linkedDeviceItem];
        //     linkedDeviceLinks.push(sourceDevice);
        //   }

        //   for (let index = 0; index < linkedDevices.length; index++) {
        //     const linkedDeviceItem = linkedDevices[index];
        //     const linkedDeviceLinks = this.switchesLinksConfigData[linkedDeviceItem];

        //     for (let index2 = 0; index2 < linkedDeviceLinks.length; index2++) {
        //       const element = linkedDeviceLinks[index2];
        //       const linkesOfLinkedDeviceLinks = this.switchesLinksConfigData[element] || [];
        //       for (let index3 = 0; index3 < linkesOfLinkedDeviceLinks.length; index3++) {
        //         const element2 = linkesOfLinkedDeviceLinks[index3];
        //         if (element2 !== linkedDeviceItem && !linkedDeviceLinks.includes(element2)) {
        //           linkedDeviceLinks.push(element2);
        //         }
        //       }
        //     }
        //   }
        // }
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
    const entity = this.platform.zigbeeEntities?.find((entity) => entity.device?.ieee_address === ieee_address);
    return entity;
  }

  setSwitchingControllerConfiguration() {
    const devicesToListenToEvents = [];
    for (const sourceDevice in this.switchesLinksConfigData) {
      devicesToListenToEvents.push(sourceDevice.split('/')[0]);
    }
    for (const sourceDevice in this.switchesActionsConfig) {
      devicesToListenToEvents.push(sourceDevice.split('/')[0]);
    }
    for (const deviceIeee of devicesToListenToEvents) {
      if (!this.lastStates[deviceIeee]) {
        this.lastStates[deviceIeee] = {};
        const device = this.getDeviceEntity(deviceIeee);
        if (device) {
          this.platform.z2m.on('MESSAGE-' + device.entityName, (payload: Payload) => {
            if (!payload.action && deepEqual(this.lastStates[deviceIeee], payload, ['linkquality', 'last_seen', 'communication'])) return;
            // For Zigbee2MQTT -> Settings -> Advanced -> cache_state = true
            for (const key in payload) {
              const value = payload[key];
              if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && (key === 'action' || value !== this.lastStates[deviceIeee][key])) {
                this.log.info('Value ' + key + ' changed from ' + this.lastStates[deviceIeee][key] + ' to ' + value + '.');
                this.switchStateChanged(deviceIeee || '', key, value, payload);
                // this.platform.aqaraS1ScenePanelConroller?.switchStateChanged(deviceIeee || '', key, value, payload);
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
  }

  // deviceEndpointPath is the device IEEE address with the endpoint, data is the changed state
  // for example, if the deviceEndpointPath is: /0x541234567890abcd/state_left and data is 'ON', then it means that a device with childEndpoint named state_left have turned on.
  switchStateChanged(deviceIeee: string, key: string, value: string | number | boolean, newPayload: Payload) {
    if (key === 'action') {
      this.processIncomingButtonEvent(deviceIeee, value as string);
      return;
    }
    const deviceEndpointPath = deviceIeee + '/' + key;

    const linkedDevices = this.switchesLinksConfigData[deviceEndpointPath];
    if (!linkedDevices?.length) {
      return;
    }

    if (this.entitiesExecutionQueues[deviceIeee] && Object.keys(this.entitiesExecutionQueues[deviceIeee]).length > 1) { // > 1 because we save the data also and never remove it (will overwritten when a new queue is constructed)
      const queueValue = this.entitiesExecutionQueues[deviceIeee]['value'];
      const entityToControl = this.getDeviceEntity(deviceIeee);
      // Enforce the desired state until completion of the queue...
      if (queueValue !== value) {
        entityToControl?.sendState('cachedPublishLight', { [key]: queueValue }, false);
      } else {
        const entityQueue = this.entitiesExecutionQueues[deviceIeee];
        const nextExecution = entityQueue[key + '_' + value];
        if (nextExecution !== undefined) {
          if (nextExecution !== '') {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete entityQueue[key + '_' + value];
            entityToControl?.sendState('cachedPublishLight', { [nextExecution as string]: value }, false);
          } else { // For the last action in the chain use delay to unlock the linkage (should be for Tuya only which have toggling issues when changing multiple endpoints of an entity in short amount of time).
            setTimeout(() => {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete entityQueue[key + '_' + value];
            }, 2000); // When it was 1000, then controlling tuya from matterbridge itself too quickly used to create a racing condition and endless toggling of the all switches on this device entities involved...
          }
        }
      }
      return;
    }

    if (this.platform.platformControls?.switchesOn) {
      const payloads: { [key: string]: { [key: string]: string | number | boolean } } = {};
      for (let i = linkedDevices.length - 1; i >= 0; i--) {
        const linkedDeviceItem = linkedDevices[i];
        const linkedDevicePathComponents = linkedDeviceItem.split('/');
        const linkedDeviceIeee = linkedDevicePathComponents[0];
        const entityToControl = this.getDeviceEntity(linkedDeviceIeee);

        if (entityToControl) {
          const paramToControl = linkedDevicePathComponents[1];
          if ((linkedDeviceIeee === deviceIeee && newPayload[paramToControl] !== value) || (linkedDeviceIeee !== deviceIeee && this.lastStates[linkedDeviceIeee][paramToControl] !== value)) { // Don't update whats not needed to be updated...
            // const entityToControlEndpoints = entityToControl.device?.endpoints;
            // if (typeof entityToControlEndpoints === 'object' && Object.keys(entityToControlEndpoints).length === 1 && entityToControlEndpoints['1'].clusters.input.includes('manuSpecificTuya') && !entityToControlEndpoints['1'].clusters.input.includes('genOnOff')) {
            //   // This is tuya, needs special queue logic
            //   this.log.info('This is a Tuya device, using queues for switching control logic...');

              if (!payloads[linkedDeviceIeee]) {
                payloads[linkedDeviceIeee] = {};
              }
              payloads[linkedDeviceIeee][paramToControl] = value;
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
            this.entitiesExecutionQueues[entity][endpoint + '_' + value] = endpoints[index + 1];
          }
          this.entitiesExecutionQueues[entity][endpoints[endpoints.length - 1] + '_' + value] = '';
          this.entitiesExecutionQueues[entity]['value'] = value;
          const paramToControl = endpoints[0];
          entityToControl?.sendState('cachedPublishLight', { [paramToControl]: value }, false);
        } else {
          if (payload && entityToControl) {
            // this.platform.publish(endpoints[0], 'set', payloadStringify(payload));
            entityToControl.sendState('cachedPublishLight', payload, true);
          }
        }
      }
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

  processIncomingButtonEvent(switchIeee: string, buttonEvent: string) {
    const actionsConfigPreConfiguredSwitchType = this.switchesActionsConfig[switchIeee];
    const sensorTypeInt = actionsConfigPreConfiguredSwitchType?.switchType; // 0 = Old IKEA round 5 button remote, 1 = Hue Switch Remote, 2 = New IKEA rect 4 buttons (Supports the 2 buttons one [No CT control])
    const actionsConfig = this.switchesActionsConfig[switchIeee + '/' + buttonEvent];
    const combinedLinks = [];
    if (actionsConfigPreConfiguredSwitchType && actionsConfigPreConfiguredSwitchType.enabled && sensorTypeInt) {
      this.log.info('Switch: %s, button event: %s, config: %s', switchIeee, buttonEvent, JSON.stringify(actionsConfigPreConfiguredSwitchType));
      combinedLinks.push(actionsConfigPreConfiguredSwitchType.linkedDevices);
    }
    if (actionsConfig && actionsConfig.enabled) {
      this.log.info('Switch: %s, config: %s', switchIeee + '/' + buttonEvent, JSON.stringify(actionsConfig));
      combinedLinks.push(actionsConfig.linkedDevices);
    }

    if (combinedLinks.length) {
      for (let index = 0; index < combinedLinks.length; index++) {
        const endpointsToExecute = combinedLinks[index];

        for (const endpointToExecute in endpointsToExecute) {
          // First cancel any timeouts we've created for the long press handling...
          const keyForTimeoutAction = switchIeee + endpointToExecute;
          clearTimeout(this.longPressTimeoutIDs[keyForTimeoutAction]);

          const endpointToExecuteItem = endpointsToExecute[endpointToExecute]; // The value: like 'ON' in case of state...

          if (endpointToExecute.startsWith('/')) { // TODO: find the correct way on this new system...
            const pathComponents = endpointToExecute.split('/');
            let actionToDo = '';
            let continueRepeat = true;

            if (pathComponents.length <= 1) {
              if (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons) {
                continueRepeat = false;
              }
              if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'brightness_move_up') || (sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_up_hold') || (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'up_hold')) { // Start Increasing the Brightness and turn on at lowest brighness if Off...
                actionToDo = 'on_low_bri_up';
              } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'brightness_move_down') || (sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_down_hold') || (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'down_hold')) {
                actionToDo = 'bri_down';
              } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) && buttonEvent === 'arrow_right_hold') {
                actionToDo = 'ct_down';
              } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) && buttonEvent === 'arrow_left_hold') {
                actionToDo = 'ct_up';
              } else {
                continueRepeat = false;

                if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'toggle_hold') || (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'on_hold')) { // Turn On with default settings (including CT)...
                  actionToDo = 'on_defaults';
                } else if (sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'toggle') { // Toggle power and if  it turns on, set to full brightness...
                  actionToDo = 'toggle_on_full_bri';
                } else if (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'on_press') { // Turn On and if On already, set to full brightness...
                  actionToDo = 'on_or_full_bri';
                } else if (sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'on') { // Turn On at full brightness and if On already just increase the brightness...
                  actionToDo = 'on_full_bri_or_bri_up';
                } else if ((sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'up_press') || (sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_up_click')) { // Turn On with lowest brightness or increase the brightness if On already
                  actionToDo = 'on_low_bri_up';
                } else if ((sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'down_press') || (sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound && buttonEvent === 'brightness_down_click')) { // Decrease the brightness
                  actionToDo = 'bri_down';
                } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) && buttonEvent === 'arrow_right_click') { // Increase the CT
                  actionToDo = 'ct_down';
                } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar || sensorTypeInt === SwitchTypes.SwitchTypeIkeaTradfriFiveButtonsRound) && buttonEvent === 'arrow_left_click') { // Decrease the CT
                  actionToDo = 'ct_up';
                } else if ((sensorTypeInt === SwitchTypes.SwitchTypeIkeaRodretOrStyrbar && buttonEvent === 'off') || (sensorTypeInt === SwitchTypes.SwitchTypeHueDimmerFourButtons && buttonEvent === 'off_press')) {
                  actionToDo = 'off';
                }
              }
            } else {
              continueRepeat = actionsConfig.repeat || false;
              actionToDo = pathComponents[1];
            }

            const entityToControl = this.getDeviceEntity(pathComponents[0]);

            if (entityToControl) {
              const repeatZBFunction = (delay: number, timeoutKey: string) => {
                this.longPressTimeoutIDs[timeoutKey] = setTimeout(() => {
                  if (actionToDo.startsWith('on_low_bri')) {
                    if (entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      if (!entityToControl.bridgedDevice?.getAttribute(OnOff.Cluster.id, 'onOff')) {
                        entityToControl.sendState('cachedPublishLight', { ['brightness_' + endpointToExecuteItem]: 3, ['state_' + endpointToExecuteItem]: 'ON' }, true);
                        if (actionToDo === 'on_low_bri') {
                          continueRepeat = false;
                        }
                      } else if (actionToDo === 'on_low_bri_up') {
                        const currentBrightness = Math.round((entityToControl.bridgedDevice?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                        const newBrightnessState = Math.min(254, currentBrightness + 13); // 254 is 100% in the 255 scale...
                        const endpointStateName = 'brightness_' + endpointToExecuteItem;
                        entityToControl.sendState('cachedPublishLight', { [endpointStateName]: newBrightnessState }, true);
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
                    if (entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      const currentBrightness = Math.round((entityToControl.bridgedDevice?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      const newBrightnessState = Math.max(3, currentBrightness - 13); // 3 is 1% in the 255 scale...
                      const endpointStateName = 'brightness_' + endpointToExecuteItem;
                      entityToControl.sendState('cachedPublishLight', { [endpointStateName]: newBrightnessState }, true);
                      if (newBrightnessState === 3) {
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'ct_down') {
                    if (entityToControl.bridgedDevice?.hasClusterServer(ColorControl.Cluster.id) && entityToControl.bridgedDevice?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      const currentColorTemperature = entityToControl.bridgedDevice.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
                      const newColorTemperatureState = Math.max(153, currentColorTemperature - 32);
                      const endpointStateName = 'color_temp_' + endpointToExecuteItem;
                      entityToControl.sendState('cachedPublishLight', { [endpointStateName]: newColorTemperatureState }, true);
                      if (newColorTemperatureState === 153) { // TODO: take the min/max from the object itself...
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'ct_up') {
                    if (entityToControl.bridgedDevice?.hasClusterServer(ColorControl.Cluster.id) && entityToControl.bridgedDevice?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      const currentColorTemperature = entityToControl.bridgedDevice.getAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds');
                      const newColorTemperatureState = Math.min(500, currentColorTemperature + 32);
                      const endpointStateName = 'color_temp_' + endpointToExecuteItem;
                      entityToControl.sendState('cachedPublishLight', { [endpointStateName]: newColorTemperatureState }, true);
                      if (newColorTemperatureState === 500) { // TODO: take the min/max from the object itself...
                        continueRepeat = false;
                      }
                    } else {
                      continueRepeat = false;
                    }
                  } else if (actionToDo === 'on_defaults') {
                    const payload: Payload = { ['state_' + endpointToExecuteItem]: 'ON' };
                    if (entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      payload['brightness_' + endpointToExecuteItem] = 254;
                    }
                    if (entityToControl.bridgedDevice?.hasClusterServer(ColorControl.Cluster.id) && entityToControl.bridgedDevice?.hasAttributeServer(ColorControl.Cluster.id, 'colorTemperatureMireds')) {
                      // service.getCharacteristic(that.platform.Characteristics.hap.ColorTemperature).setValue(actionsConfig.actionsToDo?.['' + buttonevent]?.defaultCT || 363)
                      payload['color_temp_' + endpointToExecuteItem] = 363;
                    }
                    entityToControl.sendState('cachedPublishLight', payload, true);
                  } else if (actionToDo.startsWith('toggle_on')) {
                    const currentOnOff = entityToControl.bridgedDevice?.getAttribute(OnOff.Cluster.id, 'onOff');
                    const newPowerState = !currentOnOff;
                    const payload: Payload = { ['state_' + endpointToExecuteItem]: newPowerState ? 'ON' : 'OFF' };
                    if (actionToDo === 'toggle_on_full_bri' && newPowerState && entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      const currentBrightness = Math.round((entityToControl.bridgedDevice?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      if (currentBrightness !== 254) {
                        payload['brightness_' + endpointToExecuteItem] = 254;
                      }
                    }
                    entityToControl.sendState('cachedPublishLight', payload, true);
                  } else if (actionToDo === 'on_or_full_bri') {
                    const currentOnOff = entityToControl.bridgedDevice?.getAttribute(OnOff.Cluster.id, 'onOff');
                    const payload: Payload = { ['state_' + endpointToExecuteItem]: 'ON' };
                    if (currentOnOff && entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      if (Math.round((entityToControl.bridgedDevice?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255) !== 254) {
                        payload['brightness_' + endpointToExecuteItem] = 254;
                      }
                    }
                  } else if (actionToDo === 'on_full_bri_or_bri_up') {
                    const payload: Payload = {};
                    const currentOnOff = entityToControl.bridgedDevice?.getAttribute(OnOff.Cluster.id, 'onOff');
                    if (!currentOnOff) {
                      payload['state_' + endpointToExecuteItem] = 'ON';
                    }
                    if (entityToControl.bridgedDevice?.hasClusterServer(LevelControl.Cluster.id) && entityToControl.bridgedDevice.hasAttributeServer(LevelControl.Cluster.id, 'currentLevel')) {
                      const currentBrightness = Math.round((entityToControl.bridgedDevice?.getAttribute(LevelControl.Cluster.id, 'currentLevel') / 254) * 255);
                      if (!currentOnOff) {
                        if (currentBrightness !== 254) {
                          payload['brightness_' + endpointToExecuteItem] = 254;
                        }
                      } else {
                        const newBrightnessState = Math.min(254, currentBrightness + 13); // 254 is 100% in the 255 scale...
                        payload['brightness_' + endpointToExecuteItem] = newBrightnessState;
                      }
                    }
                  } else if (actionToDo === 'off') {
                    const endpointStateName = 'state_' + endpointToExecuteItem;
                    entityToControl.sendState('cachedPublishLight', { [endpointStateName]: 'OFF' }, true);
                  } else { // This is a command to send an endpoint...
                    // const service = accessoryToControl.serviceByRpath['/' + pathComponents[2] + '/' + pathComponents[3]]
                    // const characteristics = actionsConfig.actionsToDo['' + buttonevent].characteristics
                    // for (let ii = 0; ii < characteristics.length; ii++) {
                    //   const characteristicData = characteristics[ii]
                    //   service._characteristicDelegates[characteristicData.key]?._characteristic?.setValue(characteristicData.value)
                    // }
                    entityToControl.sendState('cachedPublishLight', { [actionToDo]: endpointToExecuteItem }, true);
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
