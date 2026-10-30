import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PromptLibrary } from '../../domain/prompt-library-store.js';
import { PROMPT_CODE_PATTERN } from '../../domain/prompt-library.js';
import { errorResponse, okResponseSchema } from '../schemas.js';
import { listResponse } from '../pagination.js';

const codeSchema = z.string().regex(PROMPT_CODE_PATTERN, 'a code starts with a letter and holds letters, digits, - or _ (max 64)').meta({ example: 'house-style' });

const promptSchema = z
  .object({
    code: codeSchema,
    description: z.string().meta({ example: 'Wording every agent turn shares.' }),
    text: z.string().meta({ example: 'Follow the house style. ${{ prompts.readOnlyRestraint }}' }),
    bundled: z.boolean().describe('Bundled prompts ship with Harmonic and are read-only; duplicate one to edit.'),
    resolved: z.string().describe('The text with every `${{ prompts.<code> }}` include expanded.'),
    usedBy: z.array(z.string()).describe('Codes of the prompts that include this one.'),
  })
  .meta({ id: 'Prompt' });

const promptBodySchema = z.object({ description: z.string().max(500), text: z.string().max(100_000) });
const createBodySchema = promptBodySchema.extend({ code: codeSchema });
const duplicateBodySchema = z.object({ code: codeSchema.optional().describe('Code for the copy; defaults to `<code>-copy`.') });
const codeParamsSchema = z.object({ code: codeSchema });

export async function promptRoutes(fastify: FastifyInstance, ctx: { prompts: PromptLibrary }): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const tags = ['Prompts'];

  app.get(
    '/prompts',
    {
      schema: {
        tags,
        description: 'List the Prompt Library: bundled and operator prompts, each with its resolved preview and the prompts that include it.',
        security,
        response: { 200: listResponse('prompts', promptSchema).describe('Every prompt, bundled first.') },
      },
    },
    async () => {
      const prompts = await ctx.prompts.list();
      return { prompts, total: prompts.length };
    },
  );

  app.get(
    '/prompts/:code',
    {
      schema: {
        tags,
        description: 'Read one prompt with its resolved preview and the prompts that include it.',
        security,
        params: codeParamsSchema,
        response: { 200: promptSchema.describe('The prompt.'), 404: errorResponse('No prompt has that code.') },
      },
    },
    async (req) => ctx.prompts.get(req.params.code),
  );

  app.post(
    '/prompts',
    {
      schema: {
        tags,
        description: 'Create a prompt. Includes of unknown codes and include cycles are refused.',
        security,
        body: createBodySchema,
        response: {
          201: promptSchema.describe('The new prompt.'),
          400: errorResponse('The text includes an unknown code or closes an include cycle.'),
          409: errorResponse('A prompt already has that code.'),
        },
      },
    },
    async (req, reply) => {
      const { code, description, text } = req.body;
      return reply.status(201).send(await ctx.prompts.create(code, description, text));
    },
  );

  app.put(
    '/prompts/:code',
    {
      schema: {
        tags,
        description: 'Replace an operator prompt. Bundled prompts are read-only; duplicate one to edit.',
        security,
        params: codeParamsSchema,
        body: promptBodySchema,
        response: {
          200: promptSchema.describe('The updated prompt.'),
          400: errorResponse('The text includes an unknown code or closes an include cycle.'),
          403: errorResponse('The prompt is bundled and read-only.'),
          404: errorResponse('No prompt has that code.'),
        },
      },
    },
    async (req) => ctx.prompts.update(req.params.code, req.body.description, req.body.text),
  );

  app.post(
    '/prompts/:code/duplicate',
    {
      schema: {
        tags,
        description: 'Make an editable copy of a prompt, bundled or not.',
        security,
        params: codeParamsSchema,
        body: duplicateBodySchema,
        response: {
          201: promptSchema.describe('The new prompt.'),
          404: errorResponse('No prompt has that code.'),
          409: errorResponse('The copy\'s code is already taken.'),
        },
      },
    },
    async (req, reply) => reply.status(201).send(await ctx.prompts.duplicate(req.params.code, req.body.code)),
  );

  app.delete(
    '/prompts/:code',
    {
      schema: {
        tags,
        description: 'Delete an operator prompt that no other prompt includes.',
        security,
        params: codeParamsSchema,
        response: {
          200: okResponseSchema.describe('The prompt was deleted.'),
          403: errorResponse('The prompt is bundled and cannot be deleted.'),
          404: errorResponse('No prompt has that code.'),
          409: errorResponse('Another prompt includes this one.'),
        },
      },
    },
    async (req) => {
      await ctx.prompts.delete(req.params.code);
      return { ok: true } as const;
    },
  );
}
