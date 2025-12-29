// matterbridge-zigbee2mqtt/src/DummySwitch.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import * as fs from 'node:fs';

import { bridgedNode, MatterbridgeEndpoint, powerSource, onOffSwitch } from 'matterbridge';
import { LocationTag } from 'matterbridge/matter';
import { OnOff } from 'matterbridge/matter/clusters';
// import { OnOffBaseServer } from 'matterbridge/matter/behaviors';

import { ZigbeePlatform } from './module.js';
import { Payload } from './payloadTypes.js';
import { payloadStringify } from 'node-ansi-logger';

export class PlatformControls {
  platform: ZigbeePlatform;
  public device: MatterbridgeEndpoint;
  public swicthesOnEndpoint: MatterbridgeEndpoint;
  public switchesOn: boolean = false;
  public switchesOnCommandsConfig?: { [key: string]: { [key: string]: string } };
  public switchesOffCommandsConfig?: { [key: string]: { [key: string]: string } };

  constructor(platform: ZigbeePlatform) {
    this.platform = platform;
    this.switchesOnCommandsConfig = this.platform.config.switchesOnCommands;
    this.switchesOffCommandsConfig = this.platform.config.switchesOffCommands;

    this.device = new MatterbridgeEndpoint([bridgedNode, powerSource], { id: 'Platform Controls' }, this.platform.config.debug);
    this.device.createDefaultIdentifyClusterServer().createDefaultPowerSourceWiredClusterServer();
    this.device.createDefaultBasicInformationClusterServer('Platform Controls', '0x8803047880', 4874, 'AL Systems', 77, 'Platform Controls 20EBN9910', 1144, '1.2.8');

    // *********************** Create a switch device ***********************
    this.swicthesOnEndpoint = this.device.addChildDeviceType(
      'Enable Switches Switch',
      [onOffSwitch],
      { id: 'Enable Switches Switch', tagList: [{ mfgCode: null, namespaceId: LocationTag.Indoor.namespaceId, tag: LocationTag.Indoor.tag, label: 'Enable Switches Switch' }] },
      this.platform.config.debug,
    );
    // this.swicthesOnEndpoint.createDefaultBridgedDeviceBasicInformationClusterServer('Enable Switches Switch', 'SWI00010_' + this.swicthesOnEndpoint.id, 0xfff1, 'AL Bridge', 'AL Switch');

    this.swicthesOnEndpoint.createDefaultIdentifyClusterServer().createDefaultGroupsClusterServer().createDefaultOnOffClusterServer();

    // The cluster attributes are set by MatterbridgeOnOffServer
    this.swicthesOnEndpoint?.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.swicthesOnEndpoint?.log.info(`Command identify called identifyTime:${identifyTime}`);
    });
    this.swicthesOnEndpoint?.addCommandHandler('on', async () => {
      this.swicthesOnEndpoint?.log.info('Command on called');
      this.onOffDidSet(true);

      // setTimeout(() => {
      //   // this.device.triggerEvent(OnOff.Cluster.id, 'onOff$Changed', { stateValue: false }, this.device.log);
      //   this.device.setStateOf(OnOffBaseServer, { onOff: false });
      // }, 1000);
    });
    this.swicthesOnEndpoint?.addCommandHandler('off', async () => {
      this.swicthesOnEndpoint?.log.info('Command off called');
      this.onOffDidSet(false);
    });

    process.nextTick(() => {
      this.switchesOn = this.swicthesOnEndpoint.getAttribute(OnOff.Cluster.id, 'onOff', this.swicthesOnEndpoint.log);
    });
  }

  onOffDidSet(value: boolean) {
    this.switchesOn = value;

    const commandsToExecute = value ? this.switchesOnCommandsConfig : this.switchesOffCommandsConfig;
    if (commandsToExecute) {
      for (const cmdPath in commandsToExecute) {
        const cmdObject = commandsToExecute[cmdPath] as Payload;
        this.platform.publish(cmdPath, 'set', payloadStringify(cmdObject));
      }
    } else {
      this.swicthesOnEndpoint.log.debug('No commands to execute');
    }
  }

  async setOnOff(value: boolean) {
    await this.swicthesOnEndpoint?.setAttribute(OnOff.Cluster.id, 'onOff', value, this.swicthesOnEndpoint.log);
  }
}
