'use strict';

import ResponseObject from '../../ResponseObject.js';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';

/**
 * Role Template Routes
 * Provides REST endpoints for browsing available role templates
 */
export default async function roleTemplateRoutes(fastify, options) {

  const templatesPath = path.join(process.cwd(), 'extensions', 'roles');

  /**
   * List available role templates
   * GET /role-templates
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const templates = [];

      // Scan extensions/roles directory
      if (existsSync(templatesPath)) {
        const dirs = await fs.readdir(templatesPath);

        for (const dir of dirs) {
          const templatePath = path.join(templatesPath, dir);
          const roleJsonPath = path.join(templatePath, 'role.json');

          // Check if directory and has role.json
          const stat = await fs.stat(templatePath);
          if (stat.isDirectory() && existsSync(roleJsonPath)) {
            try {
              const roleJson = await fs.readFile(roleJsonPath, 'utf-8');
              const template = JSON.parse(roleJson);
              templates.push({
                id: template.id || dir,
                name: template.name || dir,
                description: template.description || '',
                version: template.version || '1.0.0',
                type: template.type || 'workspace',
                category: template.category || 'general',
                tags: template.tags || []
              });
            } catch (error) {
              request.log.error(`Failed to load template ${dir}: ${error.message}`);
            }
          }
        }
      }

      const response = new ResponseObject().success({ templates });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Get role template by name
   * GET /role-templates/:templateName
   */
  fastify.get('/:templateName', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { templateName } = request.params;
      const roleJsonPath = path.join(templatesPath, templateName, 'role.json');

      if (!existsSync(roleJsonPath)) {
        const response = new ResponseObject().notFound(`Template not found: ${templateName}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const roleJson = await fs.readFile(roleJsonPath, 'utf-8');
      const template = JSON.parse(roleJson);

      const response = new ResponseObject().found({ template });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
