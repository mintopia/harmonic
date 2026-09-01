import { listResponse } from '../pagination.js';
import { diffFileSchema } from '../../domain/unified-diff.js';

export const diffFilesResponseSchema = listResponse('files', diffFileSchema);
