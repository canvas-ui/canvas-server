'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import path from 'path';
import Conf from 'conf';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';

// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Db from '../../services/synapsd/src/index.js';
import Stored from '../../services/stored/src/index.js';
import { parseDocumentId } from '../../utils/documentId.js';

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
    #logger;

    #db = null;
    #stored = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;

    // Managers (injected)
    #storageManager = null;
    #roleManager = null;

    constructor(options) {
        super(options.eventEmitterOptions);
        this.options = options;

        if (!options.rootPath) {
            throw new Error('Root path is required');
        }

        this.#rootPath = options.rootPath;

        if (!options.configStore) {
            throw new Error('Config store is required');
        }

        this.#configStore = options.configStore;
        this.#logger = options.logger || createLogger('workspace');

        // Managers can be optional
        this.#storageManager = options.storageManager;
        this.#roleManager = options.roleManager;

        // Initialize status from config if available
        const persistedStatus = this.#configStore.get('status');
        if (persistedStatus && Object.values(WORKSPACE_STATUS_CODES).includes(persistedStatus)) {
             if ([WORKSPACE_STATUS_CODES.ACTIVE, WORKSPACE_STATUS_CODES.INACTIVE, WORKSPACE_STATUS_CODES.ERROR].includes(persistedStatus)) {
                 this.#status = persistedStatus;
            }
        }
    }

    /*
    * Getters / Setters
    */
    get id() { return this.#configStore.get('id'); }
    get name() { return this.#configStore.get('name'); }
    get label() { return this.#configStore.get('label', this.name || this.id); }
    get description() { return this.#configStore.get('description'); }
    get color() { return this.#configStore.get('color'); }
    get icon() { return this.#configStore.get('icon', null); }
    get homeScreen() { return this.#configStore.get('homeScreen', {}); }
    get links() { return this.#configStore.get('links', {}); }
    get type() { return this.#configStore.get('type', 'workspace'); }
    get owner() { return this.#configStore.get('owner'); }
    get rootPath() { return this.#rootPath; }
    get status() { return this.#status; }
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE; }
    get config() { return this.#configStore.store; }
    get acl() { return this.#configStore.get('acl'); }

    get services() {
        return this.#configStore.get('services') || {
            dotfiles: { enabled: false },
            home: { enabled: false, transports: ['webdav'] },
        };
    }

    get db() {
        if (!this.#db) throw new Error('Database not initialized');
        return this.#db;
    }

    get stored() { return this.#stored; }

    get tree() {
        if (!this.isActive || !this.#db?.tree) throw new Error('Tree not available');
        return this.#db.tree;
    }

    get directoryTree() {
        if (!this.isActive || !this.#db?.directoryTree) throw new Error('Directory tree not available');
        return this.#db.directoryTree;
    }

    get jsonTree() {
        if (!this.isActive || !this.#db) { throw new Error('Workspace not active'); }
        return this.#db.jsonTree;
    }

    get homePath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.home);
    }

    isServiceEnabled(serviceName) {
        const services = this.services;
        return services[serviceName]?.enabled === true;
    }

    setServiceConfig(serviceName, config) {
        const services = this.services;
        services[serviceName] = { ...services[serviceName], ...config };
        this.#configStore.set('services', services);
        this.emit('services.changed', { service: serviceName, config: services[serviceName] });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI Configuration
    // ─────────────────────────────────────────────────────────────────────────

    setIcon(url) {
        if (url == null || url === '') {
            this.#configStore.set('icon', null);
            this.emit('icon.changed', { id: this.id, icon: null });
            return true;
        }
        if (typeof url !== 'string') return false;
        this.#configStore.set('icon', url);
        this.emit('icon.changed', { id: this.id, icon: url });
        return true;
    }

    setHomeScreen(homeScreen) {
        if (homeScreen == null) {
            this.#configStore.set('homeScreen', {});
            this.emit('homeScreen.changed', { id: this.id, homeScreen: {} });
            return true;
        }
        if (typeof homeScreen !== 'object' || Array.isArray(homeScreen)) return false;
        this.#configStore.set('homeScreen', homeScreen);
        this.emit('homeScreen.changed', { id: this.id, homeScreen });
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Links
    // ─────────────────────────────────────────────────────────────────────────

    listLinks(type = null) {
        const links = this.links || {};
        if (!type) return links;
        return Array.isArray(links[type]) ? links[type] : [];
    }

    addLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (arr.includes(ref)) return true;

        links[type] = [...arr, ref];
        this.#configStore.set('links', links);
        this.emit('links.changed', { id: this.id, type, action: 'add', ref });
        return true;
    }

    removeLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (!arr.length) return true;

        const next = arr.filter(r => r !== ref);
        links[type] = next;
        this.#configStore.set('links', links);
        this.emit('links.changed', { id: this.id, type, action: 'remove', ref });
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async start() {
        if (this.isActive) return this;

        this.#logger.debug({ workspaceId: this.id }, 'Starting workspace');
        try {
            // Initialize DB
            const dbPath = path.join(this.#rootPath, WORKSPACE_DIRECTORIES.db || 'Db');
            this.#db = new Db({ path: dbPath });
            await this.#db.start();

            // Initialize Stored if home service is enabled
            if (this.isServiceEnabled('home')) {
                await this.#initializeStored();
            }

            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            this.emit('started', { id: this.id });
            return this;
        } catch (err) {
            console.error(`Failed to start workspace "${this.id}": ${err.message}`);
            this.#setStatus(WORKSPACE_STATUS_CODES.ERROR);
            throw err;
        }
    }

    async stop() {
        if (this.#status === WORKSPACE_STATUS_CODES.INACTIVE) return true;

        this.#logger.debug({ workspaceId: this.id }, 'Stopping workspace');
        try {
            if (this.#stored) {
                await this.#stored.stop();
                this.#stored = null;
            }
            if (this.#db) {
                await this.#db.shutdown();
                this.#db = null;
            }
            this.#setStatus(WORKSPACE_STATUS_CODES.INACTIVE);
            this.emit('stopped', { id: this.id });
            return true;
        } catch (err) {
             console.error(`Error stopping workspace "${this.id}": ${err.message}`);
             this.#setStatus(WORKSPACE_STATUS_CODES.ERROR);
             return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Home / Stored Management
    // ─────────────────────────────────────────────────────────────────────────

    async enableHome() {
        if (this.#stored) return;
        await this.#initializeStored();
        this.#logger.debug({ workspaceId: this.id }, 'Home service enabled');
    }

    async disableHome() {
        if (!this.#stored) return;
        await this.#stored.stop();
        this.#stored = null;
        this.#logger.debug({ workspaceId: this.id }, 'Home service disabled');
    }

    get isHomeEnabled() { return !!this.#stored; }

    // ─────────────────────────────────────────────────────────────────────────
    // CRUD Methods
    // ─────────────────────────────────────────────────────────────────────────

    async insert(data, { context = '/', directory = null, features = [], emitEvent = true } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.insertDocument(data, { context, directory, features, emitEvent });
    }

    async update(id, data, { context = null, directory = null, features = [] } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.updateDocument(id, data, { context, directory, features });
    }

    async remove(id, { context = '/', features = [] } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.removeDocument(id, context, features);
    }

    async delete(id) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.deleteDocument(parseDocumentId(id, 'Document ID'));
    }

    async get(id, options = { parse: true }) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.getDocumentById(id, options);
    }

    async list(options = {}) {
         if (!this.isActive) throw new Error('Workspace not active');
         const { contextSpec = '/', featureBitmapArray = [], filterArray = [], ...rest } = options;
         return await this.db.findDocuments(contextSpec, featureBitmapArray, filterArray, rest);
    }

    clearDatabaseSync() {
        if (!this.isActive) { throw new Error('Workspace not active'); }
        return this.db.clearSync();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token Management
    // ─────────────────────────────────────────────────────────────────────────

    createToken(options = {}) {
        const tokenId = uuidv4();
        const name = options.name || 'Workspace token';
        const description = options.description || '';
        const permissions = options.permissions || ['read', 'write'];
        const expiresAt = options.expiresAt || null;

        const randomPart = crypto.randomBytes(24).toString('hex');
        const tokenValue = `canvas-workspace-${randomPart}`;
        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

        const token = { id: tokenId, name, description, permissions, createdAt: new Date().toISOString(), expiresAt };

        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens) acl.tokens = {};
        acl.tokens[`sha256:${tokenHash}`] = token;
        this.#configStore.set('acl', acl);

        return { ...token, value: tokenValue, hash: `sha256:${tokenHash}` };
    }

    listTokens() {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        return Object.entries(acl.tokens || {}).map(([hash, token]) => ({ ...token, hash }));
    }

    deleteToken(hash) {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens || !acl.tokens[hash]) return false;
        delete acl.tokens[hash];
        this.#configStore.set('acl', acl);
        return true;
    }

    verifyToken(tokenValue) {
        if (!tokenValue) return null;

        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
        const hashKey = `sha256:${tokenHash}`;

        const acl = this.#configStore.get('acl') || { tokens: {} };
        const token = acl.tokens?.[hashKey];
        if (!token) return null;
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) return null;

        return { ...token, workspaceId: this.id, workspaceName: this.name };
    }

    toJSON() {
        return {
            ...this.config,
            id: this.id,
            icon: this.icon,
            homeScreen: this.homeScreen,
            status: this.status,
            isActive: this.isActive,
            rootPath: this.rootPath
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — Stored initialization + SynapsD sync
    // ─────────────────────────────────────────────────────────────────────────

    async #initializeStored() {
        const homePath = this.homePath;
        if (!existsSync(homePath)) {
            await fsPromises.mkdir(homePath, { recursive: true });
        }

        this.#stored = new Stored({
            index: { path: path.join(this.#rootPath, 'var', 'stored-index') },
            cache: { path: path.join(this.#rootPath, 'var', 'stored-cache') },
            checksums: ['sha256'],
            primaryChecksum: 'sha256',
        });

        // Home directory = file backend with watching
        this.#stored.addBackend('fs:home', {
            driver: 'file',
            root: homePath,
            watch: true,
        });

        // Wire Stored events → SynapsD document sync
        this.#stored.on('file:add', (data) => this.#onFileAdd(data));
        this.#stored.on('file:change', () => {}); // Stored emits unlink+add for changes
        this.#stored.on('file:unlink', (data) => this.#onFileUnlink(data));

        // Initial scan + sync
        const files = await this.#stored.scan();
        await this.#syncInitialFiles(files);
    }

    async #onFileAdd(data) {
        if (!this.isActive) return;
        const { key, checksums, size, mimeType } = data;
        if (!key || !checksums?.sha256) return;

        const filename = path.basename(key);
        if (!filename) return;

        const dataPath = `file://{WORKSPACE_ROOT}/home/${key}`;
        const checksumString = `sha256/${checksums.sha256}`;

        try {
            const existingDoc = await this.#db.getDocumentByChecksumString(checksumString);

            if (existingDoc) {
                const dataPaths = existingDoc.metadata?.dataPaths || [];
                if (!dataPaths.includes(dataPath)) {
                    dataPaths.push(dataPath);
                    await this.#db.updateDocument(existingDoc.id, {
                        metadata: { ...existingDoc.metadata, dataPaths },
                    });
                }
            } else {
                await this.#db.insertDocument({
                    schema: 'data/abstraction/file',
                    checksumArray: [checksumString],
                    data: { filename, size, mime: mimeType },
                    metadata: { dataPaths: [dataPath] },
                }, '/');
            }
        } catch (err) {
            this.#logger.debug(`Error syncing file add ${key}: ${err.message}`);
        }
    }

    async #onFileUnlink(data) {
        if (!this.isActive) return;
        const { key, checksums, locations } = data;
        if (!checksums?.sha256) return;

        const dataPath = `file://{WORKSPACE_ROOT}/home/${key}`;
        const checksumString = `sha256/${checksums.sha256}`;

        try {
            const existingDoc = await this.#db.getDocumentByChecksumString(checksumString);
            if (!existingDoc) return;

            const dataPaths = (existingDoc.metadata?.dataPaths || []).filter(p => p !== dataPath);

            if (locations?.length === 0 || dataPaths.length === 0) {
                await this.#db.deleteDocument(existingDoc.id);
            } else {
                await this.#db.updateDocument(existingDoc.id, {
                    metadata: { ...existingDoc.metadata, dataPaths },
                });
            }
        } catch (err) {
            this.#logger.debug(`Error syncing file unlink ${key}: ${err.message}`);
        }
    }

    async #syncInitialFiles(files) {
        if (!this.isActive || !files?.length) return;

        let synced = 0;
        for (const file of files) {
            if (!file.key || !file.checksums?.sha256) continue;
            const filename = path.basename(file.key);
            if (!filename) continue;

            const dataPath = `file://{WORKSPACE_ROOT}/home/${file.key}`;
            const checksumString = `sha256/${file.checksums.sha256}`;

            try {
                const existingDoc = await this.#db.getDocumentByChecksumString(checksumString);

                if (existingDoc) {
                    const dataPaths = existingDoc.metadata?.dataPaths || [];
                    if (!dataPaths.includes(dataPath)) {
                        dataPaths.push(dataPath);
                        await this.#db.updateDocument(existingDoc.id, {
                            metadata: { ...existingDoc.metadata, dataPaths },
                        });
                    }
                } else {
                    await this.#db.insertDocument({
                        schema: 'data/abstraction/file',
                        checksumArray: [checksumString],
                        data: { filename, size: file.size, mime: file.mimeType },
                        metadata: { dataPaths: [dataPath] },
                    }, '/');
                }
                synced++;
            } catch (err) {
                this.#logger.debug(`Error syncing initial file ${file.key}: ${err.message}`);
            }
        }
        this.#logger.debug(`Synced ${synced}/${files.length} initial files`);
    }

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }
}

export default Workspace;
