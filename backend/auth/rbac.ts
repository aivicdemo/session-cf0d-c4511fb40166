import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface RBACContext {
  userId: string;
  role: Role;
  loginId: string;
}

export interface PermissionSet {
  canCreateRepairRequest: boolean;
  canUpdateRepairRequest: boolean;
  canDeleteRepairRequest: boolean;
  canViewRepairRequest: boolean;
  canManageProgress: boolean;
  canContactCustomer: boolean;
  canManageBilling: boolean;
  canManageMaster: boolean;
  canManageUsers: boolean;
  canBulkImport: boolean;
}

const rolePermissions: Record<Role, PermissionSet> = {
  admin: {
    canCreateRepairRequest: true,
    canUpdateRepairRequest: true,
    canDeleteRepairRequest: true,
    canViewRepairRequest: true,
    canManageProgress: true,
    canContactCustomer: true,
    canManageBilling: true,
    canManageMaster: true,
    canManageUsers: true,
    canBulkImport: true,
  },
  operator: {
    canCreateRepairRequest: true,
    canUpdateRepairRequest: true,
    canDeleteRepairRequest: false,
    canViewRepairRequest: true,
    canManageProgress: true,
    canContactCustomer: true,
    canManageBilling: true,
    canManageMaster: false,
    canManageUsers: false,
    canBulkImport: true,
  },
  viewer: {
    canCreateRepairRequest: false,
    canUpdateRepairRequest: false,
    canDeleteRepairRequest: false,
    canViewRepairRequest: true,
    canManageProgress: false,
    canContactCustomer: false,
    canManageBilling: false,
    canManageMaster: false,
    canManageUsers: false,
    canBulkImport: false,
  },
};

export function extractRBACContext(event: APIGatewayProxyEvent): RBACContext | null {
  const authHeader = event.headers['Authorization'] || event.headers['authorization'];
  if (!authHeader) {
    return null;
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    return {
      userId: decoded.userId || 'unknown',
      role: (decoded.role || 'viewer') as Role,
      loginId: decoded.loginId || 'unknown',
    };
  } catch {
    return null;
  }
}

export function getPermissions(role: Role): PermissionSet {
  return rolePermissions[role] || rolePermissions.viewer;
}

export function requirePermission(permissions: PermissionSet, permission: keyof PermissionSet): boolean {
  return permissions[permission] === true;
}

export function checkPermission(context: RBACContext | null, permission: keyof PermissionSet): boolean {
  if (!context) {
    return false;
  }
  const permissions = getPermissions(context.role);
  return requirePermission(permissions, permission);
}