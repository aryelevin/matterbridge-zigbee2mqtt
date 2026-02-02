// matterbridge-zigbee2mqtt/src/DummySwitch.js
// Copyright © 2025 Arye Levin. All rights reserved.
//
// Matterbridge plugin for Zigbee2MQTT.

// import * as fs from 'node:fs';

import { bridgedNode, MatterbridgeEndpoint, powerSource, onOffSwitch } from 'matterbridge';
import { LocationTag } from 'matterbridge/matter';
import { OnOff } from 'matterbridge/matter/clusters';
// import { OnOffBaseServer } from 'matterbridge/matter/behaviors';
import { payloadStringify } from 'node-ansi-logger';

import { ZigbeePlatform } from './module.js';
import { Payload } from './payloadTypes.js';

export class PlatformControls {
  platform: ZigbeePlatform;
  public device: MatterbridgeEndpoint;
  public switchesOnEndpoint: MatterbridgeEndpoint;
  public switchesOn: boolean = false;
  public switchesOnCommandsConfig?: { [key: string]: { [key: string]: string } };
  public switchesOffCommandsConfig?: { [key: string]: { [key: string]: string } };

  constructor(platform: ZigbeePlatform) {
    this.platform = platform;
    this.switchesOnCommandsConfig = this.platform.config.switchesOnStateCommands;
    this.switchesOffCommandsConfig = this.platform.config.switchesOffStateCommands;

    this.device = new MatterbridgeEndpoint([bridgedNode, powerSource], { id: 'Platform Controls' }, this.platform.config.debug);
    this.device.createDefaultIdentifyClusterServer().createDefaultPowerSourceWiredClusterServer();
    this.device.createDefaultBasicInformationClusterServer('Platform Controls', '0x8803047880', 4874, 'AL Systems', 77, 'Platform Controls 20EBN9910', 1144, '1.2.8');

    // *********************** Create a switch device ***********************
    this.switchesOnEndpoint = this.device.addChildDeviceType(
      'Enable Switches Switch',
      [onOffSwitch],
      { id: 'Enable Switches Switch', tagList: [{ mfgCode: null, namespaceId: LocationTag.Indoor.namespaceId, tag: LocationTag.Indoor.tag, label: 'Enable Switches Switch' }] },
      this.platform.config.debug,
    );
    // this.swicthesOnEndpoint.createDefaultBridgedDeviceBasicInformationClusterServer('Enable Switches Switch', 'SWI00010_' + this.swicthesOnEndpoint.id, 0xfff1, 'AL Bridge', 'AL Switch');

    this.switchesOnEndpoint.createDefaultIdentifyClusterServer().createDefaultGroupsClusterServer().createDefaultOnOffClusterServer();

    // The cluster attributes are set by MatterbridgeOnOffServer
    this.switchesOnEndpoint.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.switchesOnEndpoint.log.info(`Enable Switches Command identify called identifyTime:${identifyTime}`);
    });
    this.switchesOnEndpoint.addCommandHandler('on', async () => {
      this.switchesOnEndpoint.log.info('Enable Switches Command on called');
      this.switchesOnOffDidSet(true);
    });
    this.switchesOnEndpoint.addCommandHandler('off', async () => {
      this.switchesOnEndpoint.log.info('Enable Switches Command off called');
      this.switchesOnOffDidSet(false);
    });
  }

  setPlatformControlsConfiguration() {
    this.switchesOn = this.switchesOnEndpoint.getAttribute(OnOff.Cluster.id, 'onOff', this.switchesOnEndpoint.log);
  }

  private switchesOnOffDidSet(value: boolean) {
    this.switchesOn = value;

    const commandsToExecute = value ? this.switchesOnCommandsConfig : this.switchesOffCommandsConfig;
    if (commandsToExecute) {
      for (const cmdPath in commandsToExecute) {
        const cmdObject = commandsToExecute[cmdPath] as Payload;
        // Convert primitives from string...
        for (const key in cmdObject) {
          const value = cmdObject[key];
          if (value === 'true') {
            cmdObject[key] = true;
          } else if (value === 'false') {
            cmdObject[key] = false;
          } else if (String(Number(value)) === value) {
            cmdObject[key] = Number(value);
          }
          this.platform.publish(cmdPath, 'set', payloadStringify({ [key]: cmdObject[key] }));
        }
      }
    } else {
      this.switchesOnEndpoint.log.debug('No commands to execute');
    }
  }

  async setSwitchesOnOff(value: boolean) {
    await this.switchesOnEndpoint.setAttribute(OnOff.Cluster.id, 'onOff', value, this.switchesOnEndpoint.log);
    this.switchesOnOffDidSet(value);
  }
}
