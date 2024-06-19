import {
  FromNumUuid,
  FromRadioUuid,
  LogRadioUuid,
  ServiceUuid,
  ToRadioUuid,
} from "../constants.js";
import { MeshDevice } from "../meshDevice.js";
import * as Types from "../types.js";
import { typedArrayToBuffer } from "../utils/index.js";

/** Allows to connect to a Meshtastic device via bluetooth */
export class BleConnection extends MeshDevice {
  /** Defines the connection type as ble */
  public connType: Types.ConnectionTypeName;

  public portId: string;

  /** Currently connected BLE device */
  public device: BluetoothDevice | undefined;

  private gattServer: BluetoothRemoteGATTServer | undefined;

  /** Short Description */
  private service: BluetoothRemoteGATTService | undefined;

  /** Short Description */
  private toRadioCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;

  /** Short Description */
  private fromRadioCharacteristic:
    | BluetoothRemoteGATTCharacteristic
    | undefined;

  /** Short Description */
  private fromNumCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;

  /** Logs from radio (device) */
  private logRadioCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;

  private timerUpdateFromRadio: NodeJS.Timeout | null = null;

  constructor(configId?: number) {
    super(configId);

    this.log = this.log.getSubLogger({ name: "HttpConnection" });

    this.connType = "ble";
    this.portId = "";
    this.device = undefined;
    this.service = undefined;
    this.gattServer = undefined;
    this.toRadioCharacteristic = undefined;
    this.fromRadioCharacteristic = undefined;
    this.fromNumCharacteristic = undefined;
    this.logRadioCharacteristic = undefined;
    // this.pendingRead = false;

    this.log.debug(
      Types.Emitter[Types.Emitter.Constructor],
      "🔷 BleConnection instantiated"
    );
  }

  /**
   * Gets web bluetooth support avaliability for the device
   *
   * @returns {Promise<void>}
   */
  public supported(): Promise<boolean> {
    return navigator.bluetooth.getAvailability();
  }

  /**
   * Gets list of bluetooth devices that can be passed to `connect`
   *
   * @returns {Promise<BluetoothDevice[]>} Array of avaliable BLE devices
   */
  public getDevices(): Promise<BluetoothDevice[]> {
    return navigator.bluetooth.getDevices();
  }

  /**
   * Opens browser dialog to select a device
   */
  public getDevice(filter?: RequestDeviceOptions): Promise<BluetoothDevice> {
    return navigator.bluetooth.requestDevice(
      filter ?? {
        filters: [{ services: [ServiceUuid] }],
      }
    );
  }

  /**
   * Initiates the connect process to a Meshtastic device via Bluetooth
   */
  public async connect({
    device,
    deviceFilter,
  }: Types.BleConnectionParameters): Promise<void> {
    /** Set device state to connecting */
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnecting);

    /** Set device if specified, else request. */
    this.device = device ?? (await this.getDevice(deviceFilter));

    this.portId = this.device.id;

    /** Setup event listners */
    this.device.addEventListener("gattserverdisconnected", () => {
      this.log.info(
        Types.Emitter[Types.Emitter.Connect],
        "Device disconnected"
      );
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.complete();
    });

    /** Connect to device */
    await this.device.gatt
      ?.connect()
      .then((server) => {
        this.log.info(
          Types.Emitter[Types.Emitter.Connect],
          `✅ Got GATT Server for device: ${server.device.id}`
        );
        this.gattServer = server;
      })
      .catch((e: Error) => {
        this.log.error(
          Types.Emitter[Types.Emitter.Connect],
          `❌ Failed to connect: ${e.message}`
        );
      });

    await this.gattServer
      ?.getPrimaryService(ServiceUuid)
      .then((service) => {
        this.log.info(
          Types.Emitter[Types.Emitter.Connect],
          `✅ Got GATT Service for device: ${service.device.id}`
        );
        this.service = service;
      })
      .catch((e: Error) => {
        this.log.error(
          Types.Emitter[Types.Emitter.Connect],
          `❌ Failed to get primary service: q${e.message}`
        );
      });

    [ToRadioUuid, FromRadioUuid, FromNumUuid, LogRadioUuid].map(
      async (uuid) => {
        await this.service
          ?.getCharacteristic(uuid)
          .then((characteristic) => {
            this.log.info(
              Types.Emitter[Types.Emitter.Connect],
              `✅ Got Characteristic ${characteristic.uuid} for device: ${characteristic.uuid}`
            );
            switch (uuid) {
              case ToRadioUuid: {
                this.toRadioCharacteristic = characteristic;
                break;
              }
              case FromRadioUuid: {
                this.fromRadioCharacteristic = characteristic;
                break;
              }
              case FromNumUuid: {
                this.fromNumCharacteristic = characteristic;
                break;
              }
              case LogRadioUuid: {
                this.logRadioCharacteristic = characteristic;
                break;
              }
            }
          })
          .catch((e: Error) => {
            this.log.error(
              Types.Emitter[Types.Emitter.Connect],
              `❌ Failed to get toRadio characteristic: q${e.message}`
            );
          });
      }
    );

    await this.fromNumCharacteristic?.startNotifications(); // TODO: catch

    this.fromNumCharacteristic?.addEventListener(
      "characteristicvaluechanged",
      () => {
        this.readFromRadio();
      }
    );

    await this.logRadioCharacteristic?.startNotifications(); // TODO: catch

    this.fromNumCharacteristic?.addEventListener(
      "characteristicvaluechanged",
      (event) => {
        debugger;
        const logMessage = (event.target as BluetoothRemoteGATTCharacteristic)
          .value;

        this.log.error(
          Types.Emitter[Types.Emitter.RadioLog],
          `📡 ${logMessage}`
        );
      }
    );

    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);

    this.configure().catch(() => {
      // TODO: FIX, workaround for `wantConfigId` not getting acks.
    });

    this.timerUpdateFromRadio = setInterval(() => this.readFromRadio(), 1000);
  }

  /** Disconnects from the Meshtastic device */
  public disconnect(): void {
    this.device?.gatt?.disconnect();
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
    this.complete();
    if (this.timerUpdateFromRadio) {
      clearInterval(this.timerUpdateFromRadio);
    }
    this.timerUpdateFromRadio = null;
  }

  /**
   * Pings device to check if it is avaliable
   *
   * @todo Implement
   */
  public async ping(): Promise<boolean> {
    return await Promise.resolve(true);
  }

  /** Short description */
  protected async readFromRadio(): Promise<void> {
    // if (this.pendingRead) {
    //   return Promise.resolve();
    // }
    // this.pendingRead = true;
    let readBuffer = new ArrayBuffer(1);

    while (readBuffer.byteLength > 0 && this.fromRadioCharacteristic) {
      await this.fromRadioCharacteristic
        .readValue()
        .then((value) => {
          readBuffer = value.buffer;

          if (value.byteLength > 0) {
            this.handleFromRadio(new Uint8Array(readBuffer));
          }
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);
        })
        .catch((e: Error) => {
          readBuffer = new ArrayBuffer(0);
          this.log.error(
            Types.Emitter[Types.Emitter.ReadFromRadio],
            `❌ ${e.message}`
          );
        });
    }
    // this.pendingRead = false;
  }

  /**
   * Sends supplied protobuf message to the radio
   */
  protected async writeToRadio(data: Uint8Array): Promise<void> {
    await this.toRadioCharacteristic?.writeValue(typedArrayToBuffer(data));
    // This should be automatic (onCharacteristicValueChanged)
    await this.readFromRadio();
  }
}
