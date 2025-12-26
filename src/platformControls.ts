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

export class PlatformControls {
  platform: ZigbeePlatform;
  public device: MatterbridgeEndpoint;
  public swicthesOnEndpoint: MatterbridgeEndpoint;
  public switchesOn: boolean = false;

  constructor(platform: ZigbeePlatform) {
    this.platform = platform;

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

    const commandsToExecute = value ? this.platform.config.switchesOnStateCommands : this.platform.config.switchesOffStateCommands;
    if (commandsToExecute) {
      // for (const cmdEnum in commandsToExecute) {
      //   const cmd = commandsToExecute[cmdEnum]
      //   const cmdPath = cmd.resourcePath;
      //   const cmdObject = cmd.objectData;
      //   if (cmdPath && cmdObject) {
      //     const pathComponents = cmdPath.split('/');
      //     if (pathComponents.length === 5) {
      //       const aqaraS1Bridge = this.platform.gatewayMap[pathComponents[1]];
      //       if (aqaraS1Bridge) {
      //         aqaraS1Bridge.client.put('/' + pathComponents[2] + '/' + pathComponents[3] + '/' + pathComponents[4], cmdObject).then((obj) => {
      //           // aqaraS1Bridge.log('Success')
      //         }).catch((error) => {
      //           // aqaraS1Bridge.log('Error')
      //           this.device.log.error(error)
      //         })
      //       } else {
      //         this.device.log.debug('Bridge not found');
      //       }
      //     } else {
      //       this.device.log.debug('Command path is not correct length: ' + pathComponents.length);
      //     }
      //   } else {
      //     this.device.log.debug('Missing command data: ' + JSON.stringify(cmd));
      //   }
      // }
    } else {
      this.swicthesOnEndpoint.log.debug('No commands to execute');
    }
  }

  async setOnOff(value: boolean) {
    await this.swicthesOnEndpoint?.setAttribute(OnOff.Cluster.id, 'onOff', value, this.swicthesOnEndpoint.log);
  }
}
