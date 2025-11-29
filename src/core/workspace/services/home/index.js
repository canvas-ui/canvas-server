'use strict';

import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import EventEmitter from 'eventemitter2';
import { createDebug } from '../../../../utils/log/index.js';

const debug = createDebug('home-service');

class HomeService extends EventEmitter {
    constructor(options = {}) {
        super();
        this.workspaceManager = options.workspaceManager;
        if (!this.workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    async initialize() {
        debug('HomeService initialized');
        return this;
    }

    /**
     * Get the home directory path for a workspace
     * Creates the directory if it doesn't exist
     */
    async getHomePath(workspaceIdOrObject, requestingUserId) {
        let workspace;
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            workspace = workspaceIdOrObject;
        } else {
            workspace = await this.workspaceManager.getWorkspaceById(workspaceIdOrObject, requestingUserId);
        }

        if (!workspace) {
            debug(`Workspace not found for user ${requestingUserId}`);
            return null;
        }

        const homePath = path.join(workspace.rootPath, 'home');

        // Ensure it exists
        if (!existsSync(homePath)) {
            debug(`Creating home directory at ${homePath}`);
            await fsPromises.mkdir(homePath, { recursive: true });
        }

        return homePath;
    }
}

export default HomeService;

