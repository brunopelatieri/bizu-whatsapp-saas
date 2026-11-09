import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Papéis de plataforma do plugin `admin`, gravados em `user.role`. Suporte só lê: o
 * plugin não compara o papel do alvo, e com `ban` ou `revoke` o suporte derrubaria o
 * proprietário. Ninguém personifica por aqui: o caminho HTTP do plugin fica desligado
 * até a política de consentimento (fase 9).
 */
export const platformAccessControl = createAccessControl(defaultStatements);

export const platformRoles = {
  user: platformAccessControl.newRole({ user: [], session: [] }),
  platform_owner: platformAccessControl.newRole({
    user: [
      "create",
      "list",
      "set-role",
      "ban",
      "impersonate",
      "delete",
      "set-password",
      "set-email",
      "set-phone",
      "get",
      "update",
    ],
    session: ["list", "revoke", "delete"],
  }),
  platform_support: platformAccessControl.newRole({
    user: ["list", "impersonate", "get"],
    session: ["list"],
  }),
};

/** Catálogo de permissões do tenant. Definido uma vez, para servidor e cliente. */
export const statements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  role: ["create", "update", "delete"],
  billing: ["read", "manage"],
  customer: ["read", "create", "update", "delete", "invite"],
  settings: ["read", "update"],
  audit: ["read"],
  file: ["read", "upload", "delete"],
  support: ["grant"],
  channel: ["read", "manage"],
  tag: ["manage"],
} as const;

export type Resource = keyof typeof statements;
export type Action<R extends Resource = Resource> =
  (typeof statements)[R][number];
export type Permission = {
  [R in Resource]: `${R}:${Action<R>}`;
}[Resource];

/** Recurso que o plugin exige para gerir papéis. Acompanha `role`: só o owner tem. */
const pluginRoleActions = ["create", "read", "update", "delete"] as const;

export const tenantAccessControl = createAccessControl({
  ...statements,
  ac: pluginRoleActions,
});

export const tenantRoles = {
  owner: tenantAccessControl.newRole({ ...statements, ac: pluginRoleActions }),
  admin: tenantAccessControl.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    billing: ["read"],
    customer: ["read", "create", "update", "delete", "invite"],
    settings: ["read", "update"],
    audit: ["read"],
    file: ["read", "upload", "delete"],
    channel: ["read", "manage"],
    tag: ["manage"],
  }),
  member: tenantAccessControl.newRole({
    customer: ["read", "create", "update", "invite"],
    settings: ["read"],
    file: ["read", "upload"],
    channel: ["read"],
  }),
};

export type StaticRole = keyof typeof tenantRoles;

export const STATIC_ROLES = Object.keys(tenantRoles) as StaticRole[];

export const ROLE_LABELS: Record<StaticRole, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  member: "Colaborador",
};

/** Lista plana `recurso:ação`, sem o `ac` interno do plugin. */
export function flattenStatements(permissions: Record<string, readonly string[]>) {
  return Object.entries(permissions).flatMap(([resource, actions]) =>
    resource === "ac" ? [] : actions.map((action) => `${resource}:${action}`),
  );
}

export const allPermissions = flattenStatements(statements) as Permission[];

/** Nunca entram em papel personalizado: quem as tem é só o owner. */
export const reservedPermissions: readonly Permission[] = [
  "organization:delete",
  "role:create",
  "role:update",
  "role:delete",
  "billing:manage",
  "support:grant",
];

export const assignablePermissions = allPermissions.filter(
  (permission) => !reservedPermissions.includes(permission),
);

export function isStaticRole(role: string): role is StaticRole {
  return Object.hasOwn(tenantRoles, role);
}

/** `member.role` guarda papéis separados por vírgula. */
export function splitRoles(role: string) {
  return role
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Nome de exibição: papel personalizado aparece como foi criado. */
export function roleLabel(role: string) {
  return splitRoles(role)
    .map((name) => (isStaticRole(name) ? ROLE_LABELS[name] : name))
    .join(", ");
}

export function isOwner(role: string) {
  return splitRoles(role).includes("owner");
}

/** Permissões de cada papel disponível em um tenant: estáticos + personalizados. */
export type RoleCatalog = Record<string, readonly string[]>;

export const staticRoleCatalog: RoleCatalog = Object.fromEntries(
  STATIC_ROLES.map((role) => [
    role,
    flattenStatements(tenantRoles[role].statements),
  ]),
);

/** Agrupa `customer:read` em `{ customer: ["read"] }`, a forma que o plugin grava. */
export function toStatements(permissions: readonly string[]) {
  const grouped: Record<string, string[]> = {};

  for (const permission of permissions) {
    const [resource, action] = permission.split(":");
    if (!resource || !action) continue;
    grouped[resource] = [...(grouped[resource] ?? []), action];
  }

  return grouped;
}

/** Papel desconhecido não concede nada. */
export function permissionsOf(catalog: RoleCatalog, role: string) {
  return [
    ...new Set(
      splitRoles(role).flatMap((name) =>
        Object.hasOwn(catalog, name) ? catalog[name] : [],
      ),
    ),
  ];
}

/**
 * Só se age sobre quem não tem mais poder que você: concede-se um papel, ou altera-se
 * quem o tem, apenas com todas as permissões dele. Generaliza "admin não toca owner" e
 * impede um papel personalizado com `member:update` de promover alguém a `admin`.
 */
export function canActOnRole(
  actorPermissions: readonly string[],
  catalog: RoleCatalog,
  role: string,
) {
  return permissionsOf(catalog, role).every((permission) =>
    actorPermissions.includes(permission),
  );
}
