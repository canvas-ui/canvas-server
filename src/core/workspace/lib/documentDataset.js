export const DEFAULT_DOCUMENT_DATASET = 'main';
export const INCOMING_DOCUMENT_DATASET = 'incoming';
export const INCOMING_MOUNT_NAME = '.incoming';
export const INCOMING_MOUNT_PATH = '/.incoming';

export function normalizeDocumentDataset(dataset = DEFAULT_DOCUMENT_DATASET) {
    if (typeof dataset !== 'string') {
        return DEFAULT_DOCUMENT_DATASET;
    }

    const normalized = dataset.trim().replace(/^\./, '');
    return normalized || DEFAULT_DOCUMENT_DATASET;
}

export function isIncomingMountPath(contextSpec = '/') {
    return contextSpec === INCOMING_MOUNT_PATH || contextSpec.startsWith(`${INCOMING_MOUNT_PATH}/`);
}

export function resolveMountedDocumentScope({ dataset = DEFAULT_DOCUMENT_DATASET, contextSpec = '/' } = {}) {
    const normalizedContextSpec = typeof contextSpec === 'string' && contextSpec ? contextSpec : '/';
    if (isIncomingMountPath(normalizedContextSpec)) {
        const mountedContext = normalizedContextSpec.slice(INCOMING_MOUNT_PATH.length) || '/';
        return {
            dataset: INCOMING_DOCUMENT_DATASET,
            contextSpec: mountedContext.startsWith('/') ? mountedContext : `/${mountedContext}`,
        };
    }

    return {
        dataset: normalizeDocumentDataset(dataset),
        contextSpec: normalizedContextSpec,
    };
}

export function buildMountedIncomingTree(mainTree, incomingTree) {
    const root = mainTree ? structuredClone(mainTree) : {
        id: '/',
        type: 'root',
        name: '/',
        label: '/',
        description: '',
        children: [],
    };

    const incomingNode = {
        id: 'dataset:incoming',
        type: 'mount',
        name: INCOMING_MOUNT_NAME,
        label: INCOMING_MOUNT_NAME,
        description: 'Incoming ingestion dataset',
        locked: true,
        children: Array.isArray(incomingTree?.children) ? incomingTree.children : [],
    };

    const children = Array.isArray(root.children) ? [...root.children] : [];
    const existingIndex = children.findIndex((child) => child?.name === INCOMING_MOUNT_NAME);
    if (existingIndex >= 0) {
        children[existingIndex] = incomingNode;
    } else {
        children.push(incomingNode);
    }

    root.children = children;
    return root;
}
