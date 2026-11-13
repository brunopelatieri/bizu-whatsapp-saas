import { InvitationsTable } from "@/components/app/team/invitations-table";
import { InviteForm } from "@/components/app/team/invite-form";
import { MembersTable } from "@/components/app/team/members-table";
import { useTeam } from "@/components/app/team/team-api";
import { Can } from "@/components/auth/can";
import { TenantPhoneReleaseCard } from "@/components/phone/phone-release-card";
import { Skeleton } from "@/components/ui/skeleton";

export function TeamPage() {
  const { data, isPending, isError, error, refetch } = useTeam();

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Equipe
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quem tem acesso a esta organização e o que cada pessoa pode fazer.
        </p>
      </div>

      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p className="text-destructive">{error.message}</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="font-medium text-primary hover:underline"
          >
            Tentar novamente
          </button>
        </div>
      ) : (
        <>
          <Can resource="invitation" action="create">
            <InviteForm roles={data.roles} />
          </Can>
          <MembersTable members={data.members} roles={data.roles} />
          <Can resource="phone" action="confirm">
            <TenantPhoneReleaseCard subject="user" />
          </Can>
          <Can resource="invitation" action="create">
            <InvitationsTable invitations={data.invitations} />
          </Can>
        </>
      )}
    </div>
  );
}
