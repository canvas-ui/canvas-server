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

    #index = null;
    #tree = null;

    constructor(options) {
        this.options = options;

        this.#index = null;
        this.#tree = null;

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

}

export default Workspace;
