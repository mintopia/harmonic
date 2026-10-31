import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { WorkflowLibrary } from '../../domain/workflow-library-store.js';
import { WORKFLOW_NAME_PATTERN } from '../../domain/workflow.js';
import { errorResponse } from '../schemas.js';
import { listResponse } from '../pagination.js';

const nameSchema = z.string().regex(WORKFLOW_NAME_PATTERN, 'a name starts with a lowercase letter and holds lowercase letters, digits, - or _ (max 64)').meta({ example: 'implement' });

const workflowSchema = z
  .object({
    name: nameSchema,
    description: z.string(),
    text: z.string().describe('The workflow YAML exactly as saved.'),
    bundled: z.boolean().describe('Bundled workflows ship with Harmonic and are read-only; duplicate one to edit.'),
    version: z.number().int().describe('The current version; every save creates the next one.'),
  })
  .meta({ id: 'Workflow' });

const textBodySchema = z.object({ text: z.string().max(200_000).describe('The workflow YAML.') });
const nameParamsSchema = z.object({ name: nameSchema });
const versionParamsSchema = z.object({ name: nameSchema, version: z.coerce.number().int().min(1) });

export async function workflowRoutes(fastify: FastifyInstance, ctx: { workflows: WorkflowLibrary }): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const tags = ['Workflows'];
  const invalid = errorResponse('The YAML does not validate; `error.issues` lists each problem with its line and column. Nothing was written.');

  app.get(
    '/workflows',
    { schema: { tags, description: 'List the workflow library: bundled workflows first, then operator workflows.', security, response: { 200: listResponse('workflows', workflowSchema).describe('Every workflow, bundled first.') } } },
    async () => {
      const workflows = ctx.workflows.list();
      return { workflows, total: workflows.length };
    },
  );

  app.get(
    '/workflows/:name',
    { schema: { tags, description: 'Read one workflow at its current version.', security, params: nameParamsSchema, response: { 200: workflowSchema.describe('The workflow.'), 404: errorResponse('No workflow has that name.') } } },
    async (req) => ctx.workflows.get(req.params.name),
  );

  app.put(
    '/workflows/:name',
    {
      schema: {
        tags,
        description: 'Save a workflow, creating it or adding a version. The YAML is validated against the schema and invariants first.',
        security,
        params: nameParamsSchema,
        body: textBodySchema,
        response: { 200: workflowSchema.describe('The saved workflow at its new version.'), 400: invalid, 403: errorResponse('The workflow is bundled and read-only.') },
      },
    },
    async (req) => ctx.workflows.save(req.params.name, req.body.text),
  );

  app.post(
    '/workflows/import',
    {
      schema: {
        tags,
        description: 'Import a workflow YAML file; its `name` key names it. The file is stored byte for byte.',
        security,
        body: textBodySchema,
        response: { 201: workflowSchema.describe('The imported workflow.'), 400: invalid, 409: errorResponse('A workflow already has that name.') },
      },
    },
    async (req, reply) => reply.status(201).send(await ctx.workflows.import(req.body.text)),
  );

  app.get(
    '/workflows/:name/export',
    {
      schema: {
        tags,
        description: 'Download the workflow as the YAML file that was saved.',
        security,
        params: nameParamsSchema,
        response: { 200: z.string().describe('The workflow YAML file.'), 404: errorResponse('No workflow has that name.') },
      },
    },
    async (req, reply) => reply.type('application/yaml; charset=utf-8').send(ctx.workflows.get(req.params.name).text),
  );

  app.post(
    '/workflows/:name/duplicate',
    {
      schema: {
        tags,
        description: 'Make an editable copy of a workflow, bundled or not.',
        security,
        params: nameParamsSchema,
        body: z.object({ name: nameSchema.optional().describe('Name for the copy; defaults to `<name>-copy`.') }),
        response: { 201: workflowSchema.describe('The new workflow.'), 404: errorResponse('No workflow has that name.'), 409: errorResponse('The copy\'s name is taken.') },
      },
    },
    async (req, reply) => reply.status(201).send(await ctx.workflows.duplicate(req.params.name, req.body.name)),
  );

  app.get(
    '/workflows/:name/versions',
    {
      schema: {
        tags,
        description: 'List the version numbers still kept: the current one and any a Ticket references.',
        security,
        params: nameParamsSchema,
        response: { 200: z.object({ versions: z.array(z.number().int()) }).describe('Kept version numbers, ascending.'), 404: errorResponse('No workflow has that name.') },
      },
    },
    async (req) => ({ versions: await ctx.workflows.listVersions(req.params.name) }),
  );

  app.get(
    '/workflows/:name/versions/:version',
    {
      schema: {
        tags,
        description: 'Read one immutable version of a workflow.',
        security,
        params: versionParamsSchema,
        response: { 200: workflowSchema.describe('That version of the workflow.'), 404: errorResponse('No such workflow or version.') },
      },
    },
    async (req) => ctx.workflows.getVersion(req.params.name, req.params.version),
  );
}
