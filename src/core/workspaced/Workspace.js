'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import path from 'path';
import Conf from 'conf';
import createDebug from 'debug';
const debug = createDebug('workspace');

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
} from './lib/constants.js';

/*
 * Workspace
 */

class Workspace extends EventEmitter {

    #rootPath = null;
    #configStore = null;

    #db = null;
    #tree = null;

    #storageManager = null;
    #roleManager = null;

    constructor(options) {
        this.options = options;

        this.#db = null;
        this.#tree = null;

        if (!options.rootPath) {
            throw new Error('Root path is required');
        }

        this.#rootPath = options.rootPath;

        if (!options.configStore) {
            throw new Error('Config store is required');
        }

        this.#configStore = options.configStore;

        if (!options.db) {
            throw new Error('DB is required');
        }

        this.#db = options.db;

        if (!options.storageManager) {
            throw new Error('Storage manager is required');
        }

        this.#storageManager = options.storageManager;

        if (!options.roleManager) {
            throw new Error('Role manager is required');
        }

        this.#roleManager = options.roleManager;
    }

    /*
    * Lifecycle Methods
    */

    start(options) {

    }

    stop(options) {

    }

    restart(options) {
    }

    status(options) {
    }



    // Data Backends(fs, s3, imap)

    //


    /**
     * CRUD Methods
     */

    insert(data, metadata, options) {
        if (!data) {
            throw new Error('Data is required');
        }

        if (!metadata) {
            throw new Error('Metadata is required');
        }

        if (!options) {
            throw new Error('Options is required');
        }

        

    }

    update(data, metadata, options) {

    }

    remove(id, metadata, options) {

    }

    delete(id, options) {

    }

    get(id, options) {

    }

    list(options) {

    }

    search(query, options) {

    }

    /**
     * Private Methods
     */

}

export default Workspace;
