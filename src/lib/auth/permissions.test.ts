import { describe, expect, it } from "vitest";
import {
  allPermissions,
  assignablePermissions,
  canActOnRole,
  permissionsOf,
  reservedPermissions,
  roleLabel,
  staticRoleCatalog,
  toStatements,
} from "@/lib/auth/permissions";
import { roleSchema } from "@/lib/schemas/roles";
import { inviteSchema } from "@/lib/schemas/team";
import { slugify } from "@/lib/schemas/tenant";

/** Cópia literal da matriz de `spec-tenant-rbac.md`: mudar um papel exige mudar aqui. */
const specMatrix: Record<string, [owner: boolean, admin: boolean, member: boolean]> = {
  "organization:update": [true, true, false],
  "organization:delete": [true, false, false],
  "member:create": [true, true, false],
  "member:update": [true, true, false],
  "member:delete": [true, true, false],
  "invitation:create": [true, true, false],
  "invitation:cancel": [true, true, false],
  "role:create": [true, false, false],
  "role:update": [true, false, false],
  "role:delete": [true, false, false],
  "billing:read": [true, true, false],
  "billing:manage": [true, false, false],
  "customer:read": [true, true, true],
  "customer:create": [true, true, true],
  "customer:update": [true, true, true],
  "customer:invite": [true, true, true],
  "customer:delete": [true, true, false],
  "settings:read": [true, true, true],
  "settings:update": [true, true, false],
  "audit:read": [true, true, false],
  "file:read": [true, true, true],
  "file:upload": [true, true, true],
  "file:delete": [true, true, false],
  "support:grant": [true, false, false],
  // docs/specs/whatsapp-canais/spec.md, "Permissões".
  "channel:read": [true, true, true],
  "channel:manage": [true, true, false],
  // docs/specs/crm-cadastro/spec.md, "Permissões": aplicar etiqueta é `customer:update`.
  "tag:manage": [true, true, false],
  "custom_field:manage": [true, true, false],
};

describe("catálogo de permissões", () => {
  it("a matriz da spec cobre o catálogo inteiro", () => {
    expect(Object.keys(specMatrix).sort()).toEqual([...allPermissions].sort());
  });

  it.each(Object.entries(specMatrix))("%s", (permission, [owner, admin, member]) => {
    expect(staticRoleCatalog.owner?.includes(permission)).toBe(owner);
    expect(staticRoleCatalog.admin?.includes(permission)).toBe(admin);
    expect(staticRoleCatalog.member?.includes(permission)).toBe(member);
  });

  it("o `ac` do plugin não aparece na lista plana", () => {
    expect(staticRoleCatalog.owner?.some((p) => p.startsWith("ac:"))).toBe(false);
  });

  it("nenhuma permissão reservada é atribuível nem está fora do owner", () => {
    for (const permission of reservedPermissions) {
      expect(assignablePermissions).not.toContain(permission);
      expect(staticRoleCatalog.admin).not.toContain(permission);
      expect(staticRoleCatalog.member).not.toContain(permission);
    }
  });
});

describe("permissionsOf", () => {
  const catalog = { ...staticRoleCatalog, recepcao: ["customer:read"] };

  it("une os papéis separados por vírgula", () => {
    expect(permissionsOf(catalog, "recepcao, member")).toEqual(
      expect.arrayContaining(["customer:read", "file:upload"]),
    );
  });

  it("papel desconhecido não concede nada", () => {
    expect(permissionsOf(catalog, "fantasma")).toEqual([]);
    expect(permissionsOf(catalog, "constructor")).toEqual([]);
  });
});

describe("canActOnRole", () => {
  const catalog = {
    ...staticRoleCatalog,
    gestor: ["member:update", "invitation:create"],
  };
  const admin = staticRoleCatalog.admin ?? [];
  const owner = staticRoleCatalog.owner ?? [];
  const gestor = catalog.gestor;

  it("owner age sobre todos", () => {
    for (const role of Object.keys(catalog)) {
      expect(canActOnRole(owner, catalog, role)).toBe(true);
    }
  });

  it("admin não age sobre owner, mas age sobre os demais", () => {
    expect(canActOnRole(admin, catalog, "owner")).toBe(false);
    expect(canActOnRole(admin, catalog, "admin")).toBe(true);
    expect(canActOnRole(admin, catalog, "gestor")).toBe(true);
  });

  it("papel personalizado não alcança papel com mais permissões", () => {
    expect(canActOnRole(gestor, catalog, "admin")).toBe(false);
    expect(canActOnRole(gestor, catalog, "member")).toBe(false);
    expect(canActOnRole(gestor, catalog, "gestor")).toBe(true);
  });

  it("no papel com vírgula, vale o conjunto", () => {
    expect(canActOnRole(admin, catalog, "member,owner")).toBe(false);
  });
});

describe("toStatements", () => {
  it("agrupa por recurso", () => {
    expect(toStatements(["customer:read", "customer:create", "file:read"])).toEqual({
      customer: ["read", "create"],
      file: ["read"],
    });
  });
});

describe("roleLabel", () => {
  it("traduz os papéis padrão e mantém os personalizados", () => {
    expect(roleLabel("owner")).toBe("Proprietário");
    expect(roleLabel("recepcao")).toBe("recepcao");
  });
});

describe("roleSchema", () => {
  const valid = { name: "recepcao", permissions: ["customer:read"] };

  it("aceita permissão atribuível e normaliza o nome", () => {
    const parsed = roleSchema.parse({ ...valid, name: " Recepcao " });
    expect(parsed.name).toBe("recepcao");
  });

  it("tira repetidas", () => {
    const parsed = roleSchema.parse({
      ...valid,
      permissions: ["customer:read", "customer:read"],
    });
    expect(parsed.permissions).toEqual(["customer:read"]);
  });

  it.each(reservedPermissions.map((permission) => [permission]))(
    "recusa %s",
    (permission) => {
      const result = roleSchema.safeParse({ ...valid, permissions: [permission] });
      expect(result.success).toBe(false);
    },
  );

  it.each([["owner"], ["com,virgula"], ["com espaco"], ["x"]])(
    "recusa o nome %s",
    (name) => {
      expect(roleSchema.safeParse({ ...valid, name }).success).toBe(false);
    },
  );
});

describe("inviteSchema", () => {
  it("recusa vírgula no papel: `member.role` a usa como separador", () => {
    const result = inviteSchema.safeParse({
      email: "a@b.com",
      role: "member,owner",
    });
    expect(result.success).toBe(false);
  });
});

describe("slugify", () => {
  it.each([
    ["Clínica São João", "clinica-sao-joao"],
    ["  ACME  Ltda. ", "acme-ltda"],
    ["---", ""],
  ])("%j vira %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("não termina em hífen ao cortar", () => {
    const slug = slugify(`${"a".repeat(47)} b`);
    expect(slug).toBe("a".repeat(47));
  });
});
