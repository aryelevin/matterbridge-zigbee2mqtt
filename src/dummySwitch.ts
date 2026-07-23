// matterbridge-zigbee2mqtt-al/src/dummySwitch.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import fs from 'node:fs';

import { bridgedNode, dimmableLight, MatterbridgeEndpoint, onOffLight, onOffPlugInUnit, onOffLightSwitch, powerSource } from 'matterbridge';
import { OnOff } from 'matterbridge/matter/clusters';
import { Pushover } from 'pushover-sdk';

// import { OnOffBaseServer } from 'matterbridge/matter/behaviors';
import type { ZigbeePlatform } from './module.js';

const p = new Pushover({
  user: 'u5purs1ef7xrxn7rnd3rrp5vzfzb71',
  token: 'a4wt2oipy5cvm1nkjvgsnq1drh9mv2',
  // httpOptions: {
  //   proxy: process.env['http_proxy'],
  // },
  // onerror: function(error) {},
  // update_sounds: true // update the list of sounds every day - will
  // prevent app from exiting.
});

export type DummySwitchType = 'switch' | 'light' | 'dimmer' | 'outlet';

export interface DummySwitchConfig {
  name: string;
  stateful: boolean;
  type: DummySwitchType;
  reverse?: boolean;
  time?: number;
  resettable?: boolean;
  random?: boolean;
  debug?: boolean;
  notification?: {
    sound: string;
    muteNotificationIntervalInSec: number;
  };
}

/**
 *
 * @param {number} time in ms
 * @returns {number} randomized time between 0 and time
 */
function randomize(time: number = 0): number {
  return Math.floor(Math.random() * (time + 1));
}

export class DummySwitch {
  config: DummySwitchConfig;
  public device: MatterbridgeEndpoint;
  timer: NodeJS.Timeout | null;
  notificationMuted: boolean;
  callback?: (onOff: boolean) => void;

  constructor(platform: ZigbeePlatform, config: DummySwitchConfig, callback?: (onOff: boolean) => void) {
    this.config = config;
    this.callback = callback;

    this.timer = null;
    this.notificationMuted = false;

    if (this.config.type === 'switch') {
      // *********************** Create a switch device ***********************
      this.device = new MatterbridgeEndpoint([onOffLightSwitch, bridgedNode, powerSource], { id: this.config.name + ' Switch' }, this.config.debug);
      this.device.createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Switch', 'SWI00010_' + this.device.id, 0xfff1, 'AL Bridge', 'AL Switch');

      // this.switch = await this.addDevice(this.switch);
    } else if (this.config.type === 'dimmer') {
      // *********************** Create a dimmer device ***********************
      this.device = new MatterbridgeEndpoint([dimmableLight, bridgedNode, powerSource], { id: this.config.name + ' Dimmer' }, this.config.debug);
      this.device
        .createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Dimmer', 'DMR00014_' + this.device.id, 0xfff1, 'AL Bridge', 'AL Dimmer')
        .createDefaultLevelControlClusterServer();

      // this.dimmer = await this.addDevice(this.dimmer);

      // The cluster attributes are set by MatterbridgeLevelControlServer
      this.device.addCommandHandler('moveToLevel', ({ request: { level } }) => {
        this.device.log.debug(`Command moveToLevel called request: ${level}`);
      });
      this.device.addCommandHandler('moveToLevelWithOnOff', ({ request: { level } }) => {
        this.device.log.debug(`Command moveToLevelWithOnOff called request: ${level}`);
      });
    } else if (this.config.type === 'light') {
      // *********************** Create a on off light device ***********************
      this.device = new MatterbridgeEndpoint([onOffLight, bridgedNode, powerSource], { id: this.config.name + ' Light (on/off)' }, this.config.debug);
      this.device.createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Light', 'LON00013_' + this.device.id, 0xfff1, 'AL Bridge', 'AL Light');

      // this.lightOnOff = await this.addDevice(this.lightOnOff);
    } else {
      // *********************** Create an outlet device ***********************
      this.device = new MatterbridgeEndpoint([onOffPlugInUnit, bridgedNode, powerSource], { id: this.config.name + ' Outlet' }, this.config.debug);
      this.device.createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Outlet', 'OUT00019_' + this.device.id, 0xfff1, 'AL Bridge', 'AL Outlet');

      // this.outlet = await this.addDevice(this.outlet);
    }

    this.device.createDefaultIdentifyClusterServer().createDefaultGroupsClusterServer().createDefaultOnOffClusterServer().createDefaultPowerSourceWiredClusterServer();

    // The cluster attributes are set by MatterbridgeOnOffServer
    this.device.addCommandHandler('identify', ({ request: { identifyTime } }) => {
      this.device.log.info(`Command identify called identifyTime:${identifyTime}`);
    });
    this.device.addCommandHandler('on', () => {
      this.device.log.info('Command on called');
      this.onOffDidSet(true);

      // setTimeout(() => {
      //   // this.device.triggerEvent(OnOff.id, 'onOff$Changed', { stateValue: false }, this.device.log);
      //   this.device.setStateOf(OnOffBaseServer, { onOff: false });
      // }, 1000);
    });
    this.device.addCommandHandler('off', () => {
      this.device.log.info('Command off called');
      this.onOffDidSet(false);
    });
  }

  private onOffDidSet(value: boolean): void {
    if (this.callback) {
      this.callback(value);
    }

    const delay = this.config.random ? randomize(this.config.time ?? 1000) : (this.config.time ?? 1000);
    let msg = 'Setting switch to ' + value;
    if (!this.config.stateful) {
      if ((value && !this.config.reverse) || (!value && this.config.reverse)) {
        msg += this.config.random ? ' (random delay ' : ' (delay ' + delay + ' ms)';
      }
    }
    if (this.config.debug === true) {
      this.device.log.info(msg);
    }

    if (
      !this.config.stateful && // Only for stateless switches
      ((value && !this.config.reverse) || // When reversed is set to false, then only when turns on, turn off after the delay
        (!value && this.config.reverse)) // When reversed is set to true, then only when turns off, turn on after the delay
    ) {
      if (this.config.resettable && this.timer !== null) {
        clearTimeout(this.timer);
      }
      const afterDelayValue = !value;
      this.timer = setTimeout(() => {
        void this.setOnOff(afterDelayValue);
      }, delay);

      if (this.config.notification) {
        if (this.notificationMuted) {
          this.device.log.info('notification is muted');
        } else {
          this.device.log.info('Send notification: ' + JSON.stringify(this.config.notification));
          const paramsMsg = {
            // These values correspond to the parameters detailed on https://pushover.net/api
            // 'message' is required. All other values are optional.
            message: 'Home', // required
            // title: "Well - this is fantastic",
            sound: this.config.notification.sound,
            // device: 'Aryes-iPhone-15-Pro-Max',
            priority: 1,
          };

          p.sendMessage(paramsMsg)
            .then((result) => {
              if (result) {
                this.device.log.info('success push, receipt: ', result.receipt);
              }
              return;
            })
            .catch((err: unknown) => {
              throw err;
            });

          // Mute further notifications for specified time
          this.notificationMuted = true;
          setTimeout(() => {
            this.notificationMuted = false;
            this.device.log.info('notification did now un-muted');
          }, this.config.notification.muteNotificationIntervalInSec * 1000);
        }
      }
    }
  }

  async setOnOff(value: boolean): Promise<void> {
    await this.device.setAttribute(OnOff.id, 'onOff', value, this.device.log);
    this.onOffDidSet(value);
  }

  async updateOnOff(value: boolean): Promise<void> {
    await this.device.setAttribute(OnOff.id, 'onOff', value, this.device.log);
  }
}
