export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'VIEWER';
export type Permission =
  | 'attendance:view' | 'attendance:correct' | 'attendance:export'
  | 'employees:view' | 'employees:manage' | 'devices:manage' | 'devices:view_mac'
  | 'routers:view' | 'routers:manage' | 'org:manage' | 'users:manage' | 'audit:view';

const VIEW: Permission[] = ['attendance:view', 'employees:view', 'routers:view'];
const MATRIX: Record<Role, Permission[]> = {
  SUPER_ADMIN: [...VIEW, 'attendance:correct', 'attendance:export', 'employees:manage', 'devices:manage', 'devices:view_mac',
    'routers:manage', 'org:manage', 'users:manage', 'audit:view'],
  ADMIN: [...VIEW, 'attendance:correct', 'attendance:export', 'employees:manage', 'devices:manage', 'devices:view_mac', 'org:manage'],
  HR: [...VIEW, 'attendance:correct', 'attendance:export', 'employees:manage'],
  VIEWER: [...VIEW],
};

export const can = (role: Role, p: Permission): boolean => MATRIX[role]?.includes(p) ?? false;
export const ROLES = Object.keys(MATRIX) as Role[];
