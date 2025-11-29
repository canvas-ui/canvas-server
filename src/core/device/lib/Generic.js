import pkg from 'node-machine-id';
const { machineIdSync } = pkg;
import os from 'os';
import ip from 'ip';
import { familySync } from 'detect-libc';

class GenericDevice {
    constructor() {
        this.id = machineIdSync(true).substr(0, 11);
        this.endianness = os.endianness();
        this.os = {
            arch: os.arch(),
            platform: os.platform(),
            release: os.release(),
            libc: familySync() || 'n/a',
            hostname: os.hostname(),
            homedir: os.homedir(),
            /*
        os.homedir()
        The value of homedir returned by os.userInfo() is provided by the operating system.
        This differs from the result of os.homedir(), which queries several environment variables
        for the home directory before falling back to the operating system response.
        */
        };

        this.network = {
            address: ip.address('public'), // Replace with getHostIP() ?
            hostname: os.hostname(), //TODO: Assignment fix
        };

        this.user = os.userInfo(); // Probably better to handle this on our own ?
    }

    get ip() {
        return this.network.address;
    }

    get activeIP() {
        return getActiveIP();
    }

    get hostname() {
        return this.network.hostname;
    }
}

export default GenericDevice;

function getActiveIP() {
    const nets = os.networkInterfaces();

    for (const i in nets) {
        const candidate = nets[i].filter(function (item) {
            return item.family === 'IPv4' && !item.internal;
        })[0];

        if (candidate) {
            return candidate.address;
        }
    }

    return '127.0.0.1';
}
