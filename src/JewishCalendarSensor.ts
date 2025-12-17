// matterbridge-zigbee2mqtt/src/JewishCalendarSensor.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import EventEmitter from 'node:events';

import { MatterbridgeEndpoint, contactSensor } from 'matterbridge';
import { BooleanState } from 'matterbridge/matter/clusters';

// import * as Push from '../pushover.js'

// var p = new Push( {
//   user: 'u5purs1ef7xrxn7rnd3rrp5vzfzb71',
//   token: 'a4wt2oipy5cvm1nkjvgsnq1drh9mv2',
//   // httpOptions: {
//   //   proxy: process.env['http_proxy'],
//   //},
//   // onerror: function(error) {},
//   // update_sounds: true // update the list of sounds every day - will
//   // prevent app from exiting.
// })

interface JewishCalendarSensorParams {
  name: string;
  debug: boolean;
}

export class JewishCalendarSensor {
  sensor: MatterbridgeEndpoint;

  /**
   * Instantiate a delegate for an accessory corresponding to a device.
   *
   * @param {MatterbridgeEndpoint} accessory - The platform.
   * @param {JewishCalendarSensorParams} params - The params.
   */
  constructor(accessory: MatterbridgeEndpoint, params: JewishCalendarSensorParams) {
    this.sensor = accessory.addChildDeviceType(params.name, [contactSensor], { id: params.name }, params.debug);
    // this.sensor.createDefaultIdentifyClusterServer();
    // this.sensor.createDefaultBasicInformationClusterServer(params.name, '0x88030475', 4874, 'AL Systems', 77, 'Eve Door 20EBN9901', 1144, '1.2.8');
    this.sensor.createDefaultBooleanStateClusterServer(true);
  }

  async update(isOpen: boolean) {
    await this.sensor.setAttribute(BooleanState.Cluster.id, 'stateValue', isOpen, this.sensor.log);
    await this.sensor.triggerEvent(BooleanState.Cluster.id, 'stateChange', { stateValue: isOpen }, this.sensor.log);
  }
}
