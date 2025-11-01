'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import Conf from 'conf';
import { v4 as uuidv4 } from 'uuid';
import AdmZip from 'adm-zip';
import createDebug from 'debug';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
} from './lib/constants.js';

/**
 * Workspace Manager
 */


class WorkspaceManager extends EventEmitter {

    // Internals
    #workspaceIndex;

    // Runtime/state
    #initialized = false;

    constructor(options = {}) {
        super(options.eventEmitterOptions);
        this.#initialized = false;
    }

    async initialize() {
        if (this.#initialized) { return true; }

        // Initialize the workspace manager
        this.#initialized = true;
        return this;
    }


    /**
     * Workspace Lifecycle
     */

    async listWorkspaces() { }

    async hasWorkspace(workspaceName) { }

    async getWorkspace(workspaceName) { }

    async getWorkspaceConfig(workspaceName) { }

    async createWorkspace(workspaceName, options = {}) {

    }

    async deleteWorkspace(workspaceName) { }

    async importWorkspace(workspaceName) { }

    async exportWorkspace(workspaceName) { }

     /**
     * Workspace Control Methods
     */

    async startWorkspace(workspaceName) { }

    async stopWorkspace(workspaceName) { }

    async restartWorkspace(workspaceName) { }

    async getWorkspaceStatus(workspaceName) { }


     /**
     * Private Methods
     */



}

export default WorkspaceManager;
