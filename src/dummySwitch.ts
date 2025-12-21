// matterbridge-zigbee2mqtt/src/DummySwitch.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import * as fs from 'node:fs';

import { bridgedNode, MatterbridgeEndpoint, onOffLight, dimmableLight, powerSource, onOffSwitch, onOffOutlet } from 'matterbridge';
import { OnOff } from 'matterbridge/matter/clusters';

import { ZigbeePlatform } from './module.js';
import { Pushover } from './pushover.js';

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
  constructor(platform: ZigbeePlatform, config: DummySwitchConfig) {
    this.config = config;

    this.timer = null;
    this.notificationMuted = false;

    if (this.config.type === 'switch') {
      // *********************** Create a switch device ***********************
      this.device = new MatterbridgeEndpoint([onOffSwitch, bridgedNode, powerSource], { id: this.config.name + ' Switch' }, this.config.debug)
        .createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Switch', 'SWI00010', 0xfff1, 'AL Bridge', 'AL Switch')
        .createDefaultOnOffClusterServer()
        .createDefaultPowerSourceWiredClusterServer();

      // this.switch = await this.addDevice(this.switch);
    } else if (this.config.type === 'dimmer') {
      // *********************** Create a dimmer device ***********************
      this.device = new MatterbridgeEndpoint([dimmableLight, bridgedNode, powerSource], { id: this.config.name + ' Dimmer' }, this.config.debug)
        .createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Dimmer', 'DMR00014', 0xfff1, 'AL Bridge', 'AL Dimmer')
        .createDefaultOnOffClusterServer()
        .createDefaultLevelControlClusterServer()
        .createDefaultPowerSourceWiredClusterServer();

      // this.dimmer = await this.addDevice(this.dimmer);

      // The cluster attributes are set by MatterbridgeLevelControlServer
      this.device?.addCommandHandler('moveToLevel', async ({ request: { level } }) => {
        this.device?.log.debug(`Command moveToLevel called request: ${level}`);
      });
      this.device?.addCommandHandler('moveToLevelWithOnOff', async ({ request: { level } }) => {
        this.device?.log.debug(`Command moveToLevelWithOnOff called request: ${level}`);
      });
    } else if (this.config.type === 'light') {
      // *********************** Create a on off light device ***********************
      this.device = new MatterbridgeEndpoint([onOffLight, bridgedNode, powerSource], { id: this.config.name + ' Light (on/off)' }, this.config.debug)
        .createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Light (on/off)', 'LON00013', 0xfff1, 'AL Bridge', 'AL Light on/off')
        .createDefaultOnOffClusterServer()
        .createDefaultPowerSourceWiredClusterServer();

      // this.lightOnOff = await this.addDevice(this.lightOnOff);
    } else {
      // *********************** Create an outlet device ***********************
      this.device = new MatterbridgeEndpoint([onOffOutlet, bridgedNode, powerSource], { id: this.config.name + ' Outlet' }, this.config.debug)
        .createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(this.config.name + ' Outlet', 'OUT00019', 0xfff1, 'AL Bridge', 'AL Outlet')
        .createDefaultOnOffClusterServer()
        .createDefaultPowerSourceWiredClusterServer();

      // this.outlet = await this.addDevice(this.outlet);
    }

    // The cluster attributes are set by MatterbridgeOnOffServer
    this.device?.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.device?.log.info(`Command identify called identifyTime:${identifyTime}`);
    });
    this.device?.addCommandHandler('on', async () => {
      this.device?.log.info('Command on called');
      this.onOffDidSet(true);
    });
    this.device?.addCommandHandler('off', async () => {
      this.device?.log.info('Command off called');
      this.onOffDidSet(false);
    });
  }

  onOffDidSet(value: boolean) {
    const delay = this.config.random ? randomize(this.config.time || 1000) : (this.config.time || 1) * 1000;
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
        this.setOnOff(afterDelayValue);
      }, delay);

      if (this.config.notification) {
        if (this.notificationMuted === false) {
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

          const casigningcert = /* this._platform._configJson.caFile ? fs.readFileSync(this._platform._configJson.caFile) : */ undefined;
          p.send(
            paramsMsg,
            (err, result) => {
              if (err) {
                throw err;
              }
              if (result) {
                this.device.log.info(result);
              }
            },
            casigningcert,
          );

          // Mute further notifications for specified time
          this.notificationMuted = true;
          setTimeout(() => {
            this.notificationMuted = false;
            this.device.log.info('notification did now un-muted');
          }, this.config.notification.muteNotificationIntervalInSec * 1000);
        } else {
          this.device.log.info('notification is muted');
        }
      }
    }
  }

  async setOnOff(value: boolean) {
    await this.device?.setAttribute(OnOff.Cluster.id, 'onOff', value, this.device.log);
  }
}
