import type { AuthUser } from "@/lib/auth/types";

export function getUserDisplayName(user: AuthUser | null): string {
  const name = user?.name.trim();
  if (name) return name;

  const emailPrefix = user?.email.split("@")[0];
  return emailPrefix ?? "Usuário";
}

export function getUserInitials(user: AuthUser | null): string {
  const name = user?.name.trim();
  if (name) return nameInitials(name);

  return user?.email.slice(0, 2).toUpperCase() ?? "??";
}

/** As iniciais de um nome qualquer (membro, quem atende): reserva da foto de perfil. */
export function nameInitials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length >= 2) return `${parts[0]?.[0]}${parts.at(-1)?.[0]}`.toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}
