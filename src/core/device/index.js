import logger, { createDebug } from '../../utils/log/index.js';
const debug = createDebug('device-manager');
import EventEmitter from 'eventemitter2';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';

// Device implementations
import GenericDevice from './lib/Generic.js';

/**
 * Device Manager
 *
 * Manages device information and connections
 */
class DeviceManager extends EventEmitter {
    #devices = new Map();
    #currentDevice;
    #initialized = false;
    #configPath;

    constructor(options = {}) {
        super();
        this.#configPath = options.configPath || null;
    }

    async initialize() {
        if (this.#initialized) {
            return;
        }

        debug('Initializing device manager');

        // Create current device
        this.#currentDevice = this.createDevice({
            name: os.hostname(),
            type: this.#detectDeviceType(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            isCurrentDevice: true,
        });

        // Load saved devices if config path is provided
        if (this.#configPath && existsSync(this.#configPath)) {
            try {
                const devicesData = JSON.parse(await fs.readFile(this.#configPath, 'utf8'));

                for (const deviceData of devicesData) {
                    if (deviceData.id !== this.#currentDevice.id) {
                        this.createDevice(deviceData);
                    }
                }

                debug(`Loaded ${this.#devices.size} devices from config`);
            } catch (err) {
                debug(`Error loading devices from config: ${err.message}`);
            }
        }

        this.#initialized = true;
    }

    /**
     * Create a new device
     * @param {Object} options - Device options
     * @returns {Object} - Created device
     */
    createDevice(options = {}) {
        const id = options.id || uuidv4();
        const device = new GenericDevice({
            id,
            name: options.name || 'Unknown Device',
            type: options.type || 'generic',
            platform: options.platform,
            arch: options.arch,
            release: options.release,
            isCurrentDevice: options.isCurrentDevice || false,
            lastSeen: options.lastSeen || new Date().toISOString(),
        });

        this.#devices.set(id, device);

        if (options.isCurrentDevice) {
            this.#currentDevice = device;
        }

        this.emit('device.created', device);

        return device;
    }

    /**
     * Get the current device
     * @returns {Object} - Current device
     */
    getCurrentDevice() {
        return this.#currentDevice;
    }

    /**
     * Get a device by ID
     * @param {string} id - Device ID
     * @returns {Object} - Device object
     */
    getDevice(id) {
        return this.#devices.get(id);
    }

    /**
     * List all devices
     * @returns {Array<Object>} - Array of device objects
     */
    listDevices() {
        return Array.from(this.#devices.values());
    }

    /**
     * Update a device
     * @param {string} id - Device ID
     * @param {Object} data - Device data to update
     * @returns {Object} - Updated device
     */
    updateDevice(id, data) {
        const device = this.#devices.get(id);

        if (!device) {
            throw new Error(`Device with id "${id}" not found`);
        }

        Object.assign(device, data);
        device.lastSeen = new Date().toISOString();

        this.emit('device.updated', device);

        return device;
    }

    /**
     * Remove a device
     * @param {string} id - Device ID
     * @returns {boolean} - True if device was removed
     */
    removeDevice(id) {
        if (this.#currentDevice && this.#currentDevice.id === id) {
            throw new Error('Cannot remove current device');
        }

        const result = this.#devices.delete(id);

        if (result) {
            this.emit('device.removed', id);
        }

        return result;
    }

    /**
     * Save devices to config
     * @returns {Promise<void>}
     */
    async saveDevices() {
        if (!this.#configPath) {
            return;
        }

        try {
            const devicesData = Array.from(this.#devices.values()).map((device) => device.toJSON());
            await fs.writeFile(this.#configPath, JSON.stringify(devicesData, null, 2));
            debug(`Saved ${devicesData.length} devices to config`);
        } catch (err) {
            debug(`Error saving devices to config: ${err.message}`);
            throw err;
        }
    }

    /**
     * Detect device type based on platform and other factors
     * @returns {string} - Device type
     */
    #detectDeviceType() {
        const platform = os.platform();

        if (platform === 'darwin') {
            return 'mac';
        } else if (platform === 'win32') {
            return 'windows';
        } else if (platform === 'linux') {
            // Check if running in a container
            if (process.env.CONTAINER || process.env.DOCKER) {
                return 'container';
            }

            // Check if running on a server
            if (!process.env.DISPLAY) {
                return 'server';
            }

            return 'linux';
        } else if (platform === 'android') {
            return 'android';
        } else if (platform === 'ios') {
            return 'ios';
        }

        return 'generic';
    }
}

const deviceManager = new DeviceManager();
deviceManager.initialize();

// Default export
export default deviceManager;
