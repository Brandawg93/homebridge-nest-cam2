import { Logging } from 'homebridge';
import { NestEndpoints, handleError } from './endpoints';
import { CameraInfo, Properties, Zone } from './types/camera';
import { NestConfig } from './types/config';
import { MotionEvent } from './types/event';
import { NestStructure } from './structure';
import { Face } from './types/structure';
import querystring from 'querystring';
import { EventEmitter } from 'events';

type OnlyBooleans<T> = Pick<
  T,
  {
    [K in keyof T]: T[K] extends boolean ? K : never;
  }[keyof T]
>;

export const enum NestCamEvents {
  CAMERA_STATE_CHANGED = 'camera-change',
  CHIME_STATE_CHANGED = 'chime-change',
  CHIME_ASSIST_STATE_CHANGED = 'chime-assist-change',
  AUDIO_STATE_CHANGED = 'audio-change',
  DOORBELL_RANG = 'doorbell-rang',
  MOTION_DETECTED = 'motion-detected',
}

export class NestCam extends EventEmitter {
  private readonly config: NestConfig;
  private readonly log: Logging | undefined;
  private endpoints: NestEndpoints;
  public info: CameraInfo;
  private zones: Array<Zone> = [];
  private motionDetected = false;
  private doorbellRang = false;
  private importantOnly = true;
  private alertTypes = ['Motion', 'Sound', 'Person', 'Package Delivered', 'Package Retrieved', 'Face', 'Zone'];
  private alertCooldown = 180000;
  private alertInterval = 10000;
  private alertTimeout: NodeJS.Timeout | undefined;
  private alertFailures = 0;
  private alertsSend = true;
  private lastCuepoint = '';
  private lastUpdatedTime: Date;
  private lastAlertTypes: Array<string> = [];

  constructor(config: NestConfig, info: CameraInfo, log?: Logging) {
    super();
    this.log = log;
    this.config = config;
    this.info = info;
    this.lastUpdatedTime = new Date();
    this.alertCooldown = (config.options?.alertCooldownRate || 180) * 1000;
    if (this.alertCooldown > 300000) {
      this.alertCooldown = 300000;
    }
    this.alertInterval = (config.options?.alertCheckRate || 10) * 1000;
    if (this.alertInterval > 60000) {
      this.alertInterval = 60000;
    }
    this.endpoints = new NestEndpoints(config.options?.fieldTest);

    const alertTypes = config.options?.alertTypes;
    if (typeof alertTypes !== 'undefined') {
      log?.debug(`Using alertTypes from config: ${alertTypes}`);
      this.alertTypes = alertTypes.slice();
    }
    const importantOnly = config.options?.importantOnly;
    if (typeof importantOnly !== 'undefined') {
      log?.debug(`Using importantOnly from config: ${importantOnly}`);
      this.importantOnly = importantOnly;
    }
  }

  async setBooleanProperty(key: keyof OnlyBooleans<Properties>, value: boolean): Promise<boolean> {
    const query = querystring.stringify({
      [key]: value,
      uuid: this.info.uuid,
    });

    const response = await this.endpoints.sendRequest(
      this.config.access_token,
      this.endpoints.CAMERA_API_HOSTNAME,
      '/api/dropcams.set_properties',
      'POST',
      'json',
      'application/x-www-form-urlencoded',
      true,
      query,
    );

    try {
      if (response.status !== 0) {
        this.log?.error(`Unable to set property '${key}' for ${this.info.name} to ${value}`);
        return false;
      }
      this.info.properties[key] = value;
      return true;
    } catch (error) {
      handleError(this.log, error, `Error setting property for ${this.info.name}`);
    }
    return false;
  }

  async getAlertTypes(): Promise<Array<string>> {
    const useZones = this.alertTypes.includes('Zone');
    const index = this.alertTypes.indexOf('Zone');
    if (index > -1) {
      this.alertTypes.splice(index, 1);
    }
    if (useZones) {
      const zones = await this.getZones();
      zones.forEach((zone) => {
        this.log?.debug(`Found zone ${zone.label} for ${this.info.name}`);
        this.alertTypes.push(`Zone - ${zone.label}`);
      });
    }

    if (this.info.capabilities.includes('stranger_detection')) {
      this.log?.debug(`${this.info.name} has stranger_detection`);
      const useFaces = this.alertTypes.includes('Face');
      const index = this.alertTypes.indexOf('Face');
      if (index > -1) {
        this.alertTypes.splice(index, 1);
      }
      if (useFaces) {
        const structureId = this.info.nest_structure_id.replace('structure.', '');
        const structure = new NestStructure(this.info, this.config, this.log);
        const faces = await structure.getFaces();
        if (faces) {
          faces.forEach((face: Face) => {
            if (face.name) {
              this.log?.debug(`Found face ${face.name} for ${structureId}`);
              this.alertTypes.push(`Face - ${face.name}`);
            }
            this.alertTypes.push('Face - Unknown');
          });
        }
      }

      return this.alertTypes;
    } else {
      // Remove 'Package Delivered', 'Package Retrieved', 'Face'
      const remove = ['Package Delivered', 'Package Retrieved', 'Face'];
      return this.alertTypes.filter((x) => !remove.includes(x));
    }
  }

  startAlertChecks(): void {
    if (!this.alertTimeout) {
      const self = this;
      this.alertTimeout = global.setInterval(async () => {
        await self.checkAlerts();
      }, this.alertInterval);
    }
  }

  stopAlertChecks(): void {
    if (this.alertTimeout) {
      clearInterval(this.alertTimeout);
      this.alertTimeout = undefined;
      this.emit(NestCamEvents.MOTION_DETECTED, false, this.alertTypes);
    }
  }

  private async checkAlerts(): Promise<void> {
    if (!this.alertsSend) {
      return;
    }
    if (!this.info.properties['streaming.enabled']) {
      this.emit(NestCamEvents.MOTION_DETECTED, false, this.alertTypes);
      return;
    }

    this.log?.debug(`Checking for alerts on ${this.info.name}`);
    try {
      const currDate = new Date();
      currDate.setMinutes(currDate.getMinutes() - 1);
      const epoch = Math.round(currDate.getTime() / 1000);
      const query = querystring.stringify({
        start_time: epoch,
      });
      const response: Array<MotionEvent> = await this.endpoints.sendRequest(
        this.config.access_token,
        `https://${this.info.nexus_api_nest_domain_host}`,
        `/cuepoint/${this.info.uuid}/2?${query}`,
        'GET',
      );
      this.alertFailures = 0;
      if (response.length > 0) {
        response.forEach((trigger) => {
          const { id, face_name, types, zone_ids, is_important } = trigger;
          this.lastCuepoint = id;
          // Add face to alert if name is not empty
          if (face_name) {
            this.log?.debug(`Found face for ${face_name || 'Unknown'} in event`);
            types?.push(`Face - ${face_name || 'Unknown'}`);

            //If there is a face, there is a person
            if (!types?.includes('person')) {
              types?.push('person');
            }
          }

          if (zone_ids.length > 0) {
            zone_ids.forEach((zone_id) => {
              const zone = this.zones.find((x) => x.id === zone_id);
              if (zone) {
                this.log?.debug(`Found zone for ${zone.label} in event`);
                types.push(`Zone - ${zone.label}`);
              }
            });
          }

          // Check importantOnly flag
          let important = true;
          if (this.importantOnly) {
            important = is_important;
          }

          if (important && types.includes('doorbell') && !this.doorbellRang) {
            this.triggerDoorbell();
          }

          if (important && !this.motionDetected) {
            if (types && types.length > 0) {
              const lastSubset = this.lastAlertTypes.filter((x) => !types.includes(x));
              this.emit(NestCamEvents.MOTION_DETECTED, false, lastSubset);
              const currSubset = types.filter((x) => !this.lastAlertTypes.includes(x));
              this.triggerMotion(currSubset);
              this.lastAlertTypes = types;
            }
          }
        });
        // Reset last cuepoint if not used in 5 seconds
        setTimeout(() => {
          this.lastCuepoint = '';
        }, 5000);
      } else {
        this.emit(NestCamEvents.MOTION_DETECTED, false, this.alertTypes);
        this.lastAlertTypes = [];
      }
    } catch (error) {
      handleError(this.log, error, 'Error checking alerts');
      if (this.alertFailures < 10) {
        this.alertFailures++;
      }
      this.alertsSend = false;
      setTimeout(() => {
        this.alertsSend = true;
      }, this.alertInterval * Math.pow(this.alertFailures, 2));
    }
  }

  async getZones(): Promise<Array<Zone>> {
    try {
      const response: Array<Zone> = await this.endpoints.sendRequest(
        this.config.access_token,
        `https://${this.info.nexus_api_nest_domain_host}`,
        `/cuepoint_category/${this.info.uuid}`,
        'GET',
      );

      const validZones: Array<Zone> = [];
      response.forEach((zone) => {
        if (zone.label && !zone.hidden && zone.type === 'region') {
          validZones.push(zone);
        }
      });

      this.zones = validZones;
      return validZones;
    } catch (error) {
      handleError(this.log, error, `Error getting zones for ${this.info.name} camera`);
    }

    return [];
  }

  async getSnapshot(height: number): Promise<Buffer> {
    const query = querystring.stringify({
      uuid: this.info.uuid,
    });

    if (this.lastCuepoint) {
      return await this.getEventSnapshot(height);
    }
    return await this.endpoints.sendRequest(
      this.config.access_token,
      `https://${this.info.nexus_api_nest_domain_host}`,
      `/get_image?${query}`,
      'GET',
      'arraybuffer',
    );
  }

  async getEventSnapshot(height: number): Promise<Buffer> {
    const query = querystring.stringify({
      uuid: this.info.uuid,
      cuepoint_id: this.lastCuepoint,
      num_frames: 1,
      height: height,
      format: 'sprite',
    });
    this.lastCuepoint = '';
    return await this.endpoints.sendRequest(
      this.config.access_token,
      `https://${this.info.nexus_api_nest_domain_host}`,
      `/get_event_clip?${query}`,
      'GET',
      'arraybuffer',
    );
  }

  async updateData(info?: CameraInfo): Promise<CameraInfo> {
    if (!info) {
      // Only update if more than one second has elapsed
      const checkTime = new Date(this.lastUpdatedTime);
      checkTime.setSeconds(checkTime.getSeconds() + 1);
      if (new Date().getTime() < checkTime.getTime()) {
        return this.info;
      }

      const query = querystring.stringify({
        uuid: this.info.uuid,
      });

      try {
        const response: any = await this.endpoints.sendRequest(
          this.config.access_token,
          this.endpoints.CAMERA_API_HOSTNAME,
          `/api/cameras.get_with_properties?${query}`,
          'GET',
        );

        info = response.items[0];
      } catch (error) {
        handleError(this.log, error, `Error updating ${this.info.name} camera`);
      }
    }
    if (info) {
      const curr_streaming = this.info.properties['streaming.enabled'];
      const curr_chime = this.info.properties['doorbell.indoor_chime.enabled'];
      const curr_assist = this.info.properties['doorbell.chime_assist.enabled'];
      const curr_audio = this.info.properties['audio.enabled'];

      this.info = info;
      this.lastUpdatedTime = new Date();
      const newProps = info.properties;
      if (curr_streaming !== newProps['streaming.enabled']) {
        this.emit(NestCamEvents.CAMERA_STATE_CHANGED, newProps['streaming.enabled']);
      }
      if (curr_chime !== newProps['doorbell.indoor_chime.enabled']) {
        this.emit(NestCamEvents.CHIME_STATE_CHANGED, newProps['doorbell.indoor_chime.enabled']);
      }
      if (curr_assist !== newProps['doorbell.chime_assist.enabled']) {
        this.emit(NestCamEvents.CHIME_ASSIST_STATE_CHANGED, newProps['doorbell.chime_assist.enabled']);
      }
      if (curr_audio !== newProps['audio.enabled']) {
        this.emit(NestCamEvents.AUDIO_STATE_CHANGED, newProps['audio.enabled']);
      }
    }

    return this.info;
  }

  private triggerMotion(types: Array<string>): void {
    const self = this;
    this.emit(NestCamEvents.MOTION_DETECTED, true, types);
    this.motionDetected = true;

    setTimeout(async () => {
      self.motionDetected = false;
      self.log?.debug('Cooldown has ended');
    }, this.alertCooldown);
  }

  private triggerDoorbell(): void {
    const self = this;
    this.emit(NestCamEvents.DOORBELL_RANG);
    this.doorbellRang = true;
    setTimeout(() => {
      self.doorbellRang = false;
    }, this.alertCooldown);
  }
}
