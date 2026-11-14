import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { nameInitials } from "@/lib/auth/user-display";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

/**
 * Foto de perfil da equipe (SPEC `pre-producao`, bloco F), com as iniciais como reserva.
 *
 * Para a própria conta, a foto é `user.avatarUrl` de `GET /api/me` (com `?v=` do arquivo, que
 * renova o cache ao trocar). Para outra pessoa nenhuma rota devolve o endereço nem diz se há foto:
 * a tela tenta `GET /api/avatars/:userId`, que responde 404 sem foto (ou fora da organização), e o
 * `AvatarImage` cai nas iniciais. Sem o `?v=`, a troca de foto de um colega pode demorar até o
 * `max-age` de 5 minutos para aparecer.
 */
export function useAvatarSrc(userId: string | null | undefined) {
  const { user } = useAuth();

  if (!userId) return undefined;
  if (userId === user?.id) return user.avatarUrl ?? undefined;
  return `/api/avatars/${encodeURIComponent(userId)}`;
}

export function UserAvatar({
  userId,
  name,
  size,
  className,
  fallbackClassName,
}: {
  userId: string | null | undefined;
  name: string | null | undefined;
  size?: "default" | "sm" | "lg";
  className?: string;
  fallbackClassName?: string;
}) {
  const src = useAvatarSrc(userId);

  return (
    <Avatar size={size} className={className}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback
        className={cn("bg-primary/10 text-xs font-semibold text-primary", fallbackClassName)}
      >
        {nameInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
