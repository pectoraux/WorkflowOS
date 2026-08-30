import type { DatabaseClient } from '@platform/index.js';
import type {
  ServiceAccount,
  ServiceAccountRepository,
  CapabilityPermissionRepository,
  CreateServiceAccountInput,
} from './identity-runtime.types.js';

/**
 * PostgreSQL-backed {@link ServiceAccountRepository} (WORK-063 invariant #3).
 *
 * A service account is a first-class MACHINE principal, distinct from a user.
 * It belongs to an organization and holds an explicit capability set. It
 * NEVER impersonates a human.
 */
export class PgServiceAccountRepository implements ServiceAccountRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateServiceAccountInput): Promise<ServiceAccount> {
    const result = await this.db.query<ServiceAccountRow>(
      `INSERT INTO wfos_service_accounts (organization_id, name, capabilities, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, name, capabilities, created_at, created_by`,
      [
        input.organizationId,
        input.name,
        arrayToPgText(input.capabilities),
        input.createdBy ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<ServiceAccount | null> {
    const result = await this.db.query<ServiceAccountRow>(
      `SELECT id, organization_id, name, capabilities, created_at, created_by
         FROM wfos_service_accounts WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async listForOrganization(organizationId: string): Promise<ServiceAccount[]> {
    const result = await this.db.query<ServiceAccountRow>(
      `SELECT id, organization_id, name, capabilities, created_at, created_by
         FROM wfos_service_accounts WHERE organization_id = $1 ORDER BY created_at ASC`,
      [organizationId],
    );
    return result.rows.map(mapRow);
  }

  async setCapabilities(
    id: string,
    capabilities: readonly string[],
  ): Promise<ServiceAccount | null> {
    const result = await this.db.query<ServiceAccountRow>(
      `UPDATE wfos_service_accounts SET capabilities = $2 WHERE id = $1
       RETURNING id, organization_id, name, capabilities, created_at, created_by`,
      [id, arrayToPgText(capabilities)],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_service_accounts WHERE id = $1', [id]);
  }
}

/**
 * PostgreSQL-backed {@link CapabilityPermissionRepository} — the capability →
 * permission mapping that lets machine principals flow through the SAME
 * AuthorizationService path (WORK-063: capability → permission mapping, never
 * a parallel authorization mechanism).
 */
export class PgCapabilityPermissionRepository implements CapabilityPermissionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listPermissionsForCapabilities(
    capabilities: readonly string[],
  ): Promise<string[]> {
    if (capabilities.length === 0) return [];
    // ANY — a permission granted by ANY of the capabilities is in the set.
    // The AuthorizationService then checks the specific requested permission
    // against this resolved set.
    const result = await this.db.query<{ permission_id: string }>(
      `SELECT DISTINCT permission_id FROM wfos_capability_permissions
        WHERE capability_id = ANY($1::text[])`,
      [arrayToPgText(capabilities)],
    );
    return result.rows.map((r) => r.permission_id);
  }

  async listAllCapabilities(): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      'SELECT id FROM wfos_capabilities ORDER BY id ASC',
    );
    return result.rows.map((r) => r.id);
  }
}

interface ServiceAccountRow {
  id: string;
  organization_id: string;
  name: string;
  capabilities: string[];
  created_at: Date;
  created_by: string | null;
}

function mapRow(row: ServiceAccountRow): ServiceAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    capabilities: row.capabilities ?? [],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/**
 * Convert a readonly string array to the pg TEXT[] parameter shape.
 * pg accepts JS string arrays directly for TEXT[] columns.
 */
function arrayToPgText(arr: readonly string[]): string[] {
  return [...arr];
}
