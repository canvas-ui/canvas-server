'use strict';

// Includes
import Context from './Context.js';

/**
 * Canvas
 */
class Canvas extends Context {
    constructor(name, options = {}) {
        super(name, { ...options, type: 'canvas' });
    }

    
}

export default Canvas;
