import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser, runAuthed } from '@api/plugins/auth.plugin.js';
import type {
  CreateWorkflowInput,
  ForkWorkflowInput,
  InstallWorkflowInput,
  UpdateWorkflowInput,
  WorkflowCollaboratorRole,
  WorkflowInstallationStatus,
  WorkflowLifecycleStatus,
  WorkflowRepositoryService,
  WorkflowVisibility,
} from './types.js';
import { WorkflowRepositoryError, validationError, type WorkflowRepositoryErrorCode } from './internal/errors.js';

/**
 * V2-002 — the /v2 workflow-repository HTTP surface.
 *
 * Routes are thin: authenticate (the shared auth plugin — a HUMAN principal
 * is required), extract + shape-check the payload, then delegate to the
 * {@link WorkflowRepositoryService}. Typed repository errors map to stable
 * statuses/codes; unknown failures propagate (fail closed, never swallowed).
 *
 * This is repository/versioning persistence only — no execution engine, no
 * workflow semantics (V2-003/V2-004/V2-005 own those surfaces).
 */
export interface V2WorkflowRepositoryRouteDeps {
  service: WorkflowRepositoryService;
}

const STATUS_BY_CODE: Record<WorkflowRepositoryErrorCode, number> = {
  validation: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'unsupported-protocol': 409,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map a typed repository error to its HTTP reply; rethrow anything else. */
function repoReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof WorkflowRepositoryError) {
    return reply.code(STATUS_BY_CODE[err.code]).send({ error: err.code });
  }
  throw err;
}

function body(req: FastifyRequest): Record<string, unknown> {
  if (req.body === null || req.body === undefined) return {};
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw validationError('request body must be a JSON object');
  }
  return req.body as Record<string, unknown>;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw validationError(`${field} must be a UUID`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string`);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === null) return null;
  return optionalString(value, field);
}

function paramUuid(req: FastifyRequest, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (value === undefined || !UUID_RE.test(value)) {
    throw validationError(`${name} must be a UUID`);
  }
  return value;
}

function requireVisibilityValue(value: unknown): WorkflowVisibility {
  requireString(value, 'visibility');
  return value as WorkflowVisibility;
}

export async function v2WorkflowRepositoryRoutes(
  app: FastifyInstance,
  deps: V2WorkflowRepositoryRouteDeps,
): Promise<void> {
  const service = deps.service;

  // ------------------------------------------------------------- workflows

  // POST /v2/workflows — create a workflow (member of the target tenant).
  app.post('/v2/workflows', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const input: CreateWorkflowInput = {
          actorId: user.id,
          tenantId: requireUuid(b.tenantId, 'tenantId'),
          name: requireString(b.name, 'name'),
          description: optionalNullableString(b.description, 'description') ?? null,
          visibility: requireVisibilityValue(b.visibility),
        };
        const record = await service.createWorkflow(input);
        return reply.code(201).send(record);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId — read (visibility-scoped).
  app.get('/v2/workflows/:workflowId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        return await service.getWorkflow({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
        });
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // PATCH /v2/workflows/:workflowId — update repository metadata
  // (name/description need write; visibility/lifecycle need manage).
  app.patch('/v2/workflows/:workflowId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const input: UpdateWorkflowInput = {
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          name: optionalString(b.name, 'name'),
          description: optionalNullableString(b.description, 'description'),
          visibility: b.visibility === undefined ? undefined : requireVisibilityValue(b.visibility),
          lifecycleStatus:
            b.lifecycleStatus === undefined
              ? undefined
              : (requireString(b.lifecycleStatus, 'lifecycleStatus') as WorkflowLifecycleStatus),
        };
        return await service.updateWorkflow(input);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // -------------------------------------------------------- collaborators

  // POST /v2/workflows/:workflowId/collaborators — grant (manage only).
  app.post('/v2/workflows/:workflowId/collaborators', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const record = await service.grantCollaborator({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          userId: requireUuid(b.userId, 'userId'),
          role: requireString(b.role, 'role') as WorkflowCollaboratorRole,
        });
        return reply.code(201).send(record);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/collaborators — list grants (read).
  app.get('/v2/workflows/:workflowId/collaborators', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const collaborators = await service.listCollaborators({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
        });
        return { collaborators };
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // DELETE /v2/workflows/:workflowId/collaborators/:userId — revoke (manage).
  app.delete('/v2/workflows/:workflowId/collaborators/:userId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const params = req.params as Record<string, string | undefined>;
        await service.revokeCollaborator({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          userId: requireUuid(params.userId, 'userId'),
        });
        return reply.code(204).send();
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // ------------------------------------------------------------- versions

  // POST /v2/workflows/:workflowId/versions — commit an immutable version
  // (write permission). Duplicate identity inputs converge deterministically.
  app.post('/v2/workflows/:workflowId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        if (b.content === undefined) {
          throw validationError('content is required');
        }
        let parentVersionId: string | null | undefined;
        if (b.parentVersionId === undefined) {
          parentVersionId = undefined; // default: the workflow's current version
        } else if (b.parentVersionId === null) {
          parentVersionId = null; // explicit root
        } else {
          parentVersionId = requireString(b.parentVersionId, 'parentVersionId');
        }
        let protocolVersion: string | undefined;
        if (b.protocolVersion !== undefined && b.protocolVersion !== null) {
          if (typeof b.protocolVersion !== 'string') {
            throw validationError('protocolVersion must be a string');
          }
          // Pass through verbatim (including empty) — the service classifies
          // anything outside the supported set as unsupported-protocol.
          protocolVersion = b.protocolVersion;
        }
        const record = await service.commitWorkflowVersion({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          content: b.content,
          message: optionalNullableString(b.message, 'message') ?? null,
          parentVersionId,
          protocolVersion,
        });
        return reply.code(201).send(record);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/versions — deterministic history list.
  app.get('/v2/workflows/:workflowId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const versions = await service.listVersions({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
        });
        return { versions };
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/versions/:versionId — addressable by id.
  app.get('/v2/workflows/:workflowId/versions/:versionId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const params = req.params as Record<string, string | undefined>;
        return await service.getWorkflowVersion({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          workflowVersionId: requireString(params.versionId, 'versionId'),
        });
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/versions/:versionId/lineage — ancestry walk.
  app.get('/v2/workflows/:workflowId/versions/:versionId/lineage', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const params = req.params as Record<string, string | undefined>;
        const lineage = await service.getWorkflowVersionLineage({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          workflowVersionId: requireString(params.versionId, 'versionId'),
        });
        return { lineage };
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/versions-by-digest/:digest — addressable
  // by content digest.
  app.get('/v2/workflows/:workflowId/versions-by-digest/:digest', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const params = req.params as Record<string, string | undefined>;
        return await service.getWorkflowVersionByDigest({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          contentDigest: requireString(params.digest, 'digest'),
        });
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // ----------------------------------------------------------------- fork

  // POST /v2/workflows/:workflowId/fork — new workflow identity + preserved
  // provenance (read access on the source; membership of the target tenant).
  app.post('/v2/workflows/:workflowId/fork', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const input: ForkWorkflowInput = {
          actorId: user.id,
          sourceWorkflowId: paramUuid(req, 'workflowId'),
          tenantId: requireUuid(b.tenantId, 'tenantId'),
          name: optionalString(b.name, 'name'),
          visibility: b.visibility === undefined ? undefined : requireVisibilityValue(b.visibility),
          // A workflow version id (wfv_…) — NOT a UUID.
          sourceVersionId: optionalString(b.sourceVersionId, 'sourceVersionId'),
        };
        const result = await service.forkWorkflow(input);
        return reply.code(201).send(result);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // -------------------------------------------------------- installations

  // POST /v2/workflows/:workflowId/installations — install (pins one
  // immutable version; converges per (workflow, tenant) without re-pinning).
  app.post('/v2/workflows/:workflowId/installations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const input: InstallWorkflowInput = {
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
          tenantId: requireUuid(b.tenantId, 'tenantId'),
          workflowVersionId: requireString(b.workflowVersionId, 'workflowVersionId'),
        };
        const record = await service.installWorkflow(input);
        return reply.code(201).send(record);
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/workflows/:workflowId/installations — list installs (read).
  app.get('/v2/workflows/:workflowId/installations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const installations = await service.listWorkflowInstallations({
          actorId: user.id,
          workflowId: paramUuid(req, 'workflowId'),
        });
        return { installations };
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/installations/:installationId — read (tenant-scoped).
  app.get('/v2/installations/:installationId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        return await service.getWorkflowInstallation({
          actorId: user.id,
          installationId: paramUuid(req, 'installationId'),
        });
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // PATCH /v2/installations/:installationId — explicit re-pin (customer
  // controlled) and enable/disable transitions (idempotent).
  app.patch('/v2/installations/:installationId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const b = body(req);
        const record = await service.updateWorkflowInstallation({
          actorId: user.id,
          installationId: paramUuid(req, 'installationId'),
          pinnedVersionId: optionalString(b.pinnedVersionId, 'pinnedVersionId'),
          status:
            b.status === undefined
              ? undefined
              : (requireString(b.status, 'status') as WorkflowInstallationStatus),
        });
        return record;
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // GET /v2/installations/:installationId/execution-target — the execution
  // resolution path an executor consumes: the pinned immutable version.
  // Fails closed (409) while the installation is disabled.
  app.get('/v2/installations/:installationId/execution-target', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        return await service.resolveExecutionTarget({
          actorId: user.id,
          installationId: paramUuid(req, 'installationId'),
        });
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });

  // DELETE /v2/installations/:installationId — uninstall (removes the
  // installation only; the immutable version is never mutated).
  app.delete('/v2/installations/:installationId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        await service.uninstallWorkflow({
          actorId: user.id,
          installationId: paramUuid(req, 'installationId'),
        });
        return reply.code(204).send();
      } catch (err) {
        return repoReply(reply, err);
      }
    });
  });
}
