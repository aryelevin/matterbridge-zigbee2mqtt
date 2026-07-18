// matterbridge-zigbee2mqtt-al/src/jewishCalendarSensor.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import EventEmitter from 'node:events';

import { contactSensor, MatterbridgeEndpoint } from 'matterbridge';
import { CommonLocationTag } from 'matterbridge/matter';
import { BasicInformationServer } from 'matterbridge/matter/behaviors';
import { BooleanState } from 'matterbridge/matter/clusters';

interface JewishCalendarSensorParams {
  name: string;
  debug: boolean;
}

export class JewishCalendarSensor {
  sensor: MatterbridgeEndpoint;
  private sensorState: boolean | undefined = undefined;
  private calendarState = false;
  _testMode: boolean = false;

  /**
   * Instantiate a delegate for an accessory corresponding to a device.
   *
   * @param {MatterbridgeEndpoint} accessory - The platform.
   * @param {JewishCalendarSensorParams} params - The params.
   */
  constructor(accessory: MatterbridgeEndpoint, params: JewishCalendarSensorParams) {
    this.sensor = accessory.addChildDeviceType(
      params.name,
      [contactSensor],
      { id: params.name, tagList: [{ mfgCode: null, namespaceId: CommonLocationTag.Indoor.namespaceId, tag: CommonLocationTag.Indoor.tag, label: params.name }] },
      params.debug,
    );
    // this.sensor.createDefaultIdentifyClusterServer();
    this.sensor.addClusterServers([BasicInformationServer.cluster.id]);
    this.sensor.createDefaultBasicInformationClusterServer(params.name, '0x8803047534' /* , 4874, 'AL Systems', 77, 'Eve Door 20EBN9901', 1144, '1.2.8'*/);
    this.sensor.createDefaultBooleanStateClusterServer(true);
    this.sensor.addFixedLabel('composed', params.name);
    this.sensor.addUserLabel('composed', params.name);
  }

  async update(isOpen: boolean) {
    this.calendarState = isOpen;
    await this.updateState();
  }

  private async updateState() {
    let contact = this.calendarState;
    if (this._testMode === true) {
      contact = !contact;
    }

    const newValue = !contact;
    if (this.sensorState !== newValue) {
      this.sensorState = newValue;
      await this.sensor.updateAttribute(BooleanState.id, 'stateValue', newValue, this.sensor.log);
      await this.sensor.triggerEvent(BooleanState.id, 'stateChange', { stateValue: newValue }, this.sensor.log);
    }
  }

  public set testMode(value: boolean) {
    this._testMode = value;
    void this.updateState();
  }
}
