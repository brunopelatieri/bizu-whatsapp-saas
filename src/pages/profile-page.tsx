import { PageTitle } from "@/components/admin/query-state";
import { ChangeEmailCard } from "@/components/auth/change-email-card";
import { TeamPhoneChange } from "@/components/phone/team-phone-change";
import { AvatarCard } from "@/components/profile/avatar-card";
import { NameCard } from "@/components/profile/name-card";
import { PasswordCard } from "@/components/profile/password-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/providers/auth-provider";

/**
 * "Perfil" da própria conta da equipe (SPEC `pre-producao`, bloco F, F2): o mesmo componente em
 * `/app/perfil` e `/admin/perfil`, para owner, admins, membros e equipe da plataforma. Foto e nome
 * pelas rotas do perfil (`/api/me`), e-mail pelo `ChangeEmailCard`, telefone pela troca pelo pedido
 * e senha pelo `change-password`. Na personificação a API recusa toda escrita, e a tela só mostra.
 */
export function ProfilePage() {
  const { user } = useAuth();

  return (
    <div className="max-w-2xl space-y-6">
      <PageTitle
        title="Perfil"
        description="Sua foto, nome, e-mail, telefone e senha."
      />
      {user?.impersonatedBy ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          Você está no acesso de suporte: o perfil desta conta só pode ser lido.
        </p>
      ) : null}
      <AvatarCard />
      <NameCard />
      <ChangeEmailCard />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Telefone (WhatsApp)</CardTitle>
        </CardHeader>
        <CardContent>
          <TeamPhoneChange />
        </CardContent>
      </Card>
      <PasswordCard />
    </div>
  );
}
