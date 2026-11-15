import { useState } from "react";
import { useAdminMutation, useAdminQuery } from "@/components/admin/admin-api";
import {
  type PreviewState,
  RetentionScope,
  RetentionStateNotice,
} from "@/components/admin/retention-scope";
import { QueryState } from "@/components/admin/query-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RetentionView } from "@/lib/inbox/retention";
import type { RetentionRunResult } from "@/lib/inbox/retention-policy";
import type { RetentionPolicyInput } from "@/lib/schemas/retention";

/**
 * Retenção de mensagens no `/admin` (bloco R, R3b), sobre `/api/admin/retention/*`. A tela só lê e
 * grava pela API: quem decide é o servidor (`GET` para a equipe da plataforma, `PUT` só para o
 * `platform_owner`, fora da personificação). `canWrite` apenas esconde o formulário. Nada aqui
 * apaga: a prévia é `GET` e a limpeza de verdade só roda no job diário, com a retenção ligada.
 */

type ScopesResponse = { scopes: RetentionView[] };

/** Um tipo de canal: busca a prévia sob demanda e grava a política (só quando é de uma organização). */
function ScopeWithActions({
  view,
  base,
  platform,
  canWrite,
}: {
  view: RetentionView;
  /** `/api/admin/retention/tenants/:id` ou `/api/admin/retention/platform`. */
  base: string;
  platform: boolean;
  canWrite: boolean;
}) {
  const [asked, setAsked] = useState(false);
  const preview = useAdminQuery<{ preview: RetentionRunResult }>(
    `${base}/${view.channelType}/preview`,
    undefined,
    asked,
  );
  const save = useAdminMutation("Política de retenção salva.");

  let state: PreviewState = { status: "idle" };
  if (asked) {
    if (preview.isFetching) state = { status: "loading" };
    else if (preview.isError) state = { status: "error", message: preview.error.message };
    else if (preview.data) {
      state = { status: "ready", result: preview.data.preview };
    }
  }

  return (
    <RetentionScope
      // A política volta do servidor depois de salvar: o formulário recomeça dela.
      key={`${view.channelType}:${view.policyUpdatedAt ?? "-"}:${JSON.stringify(view.policy)}`}
      view={view}
      canWrite={canWrite}
      platform={platform}
      saving={save.isPending}
      preview={state}
      onPreview={() => {
        if (asked) void preview.refetch();
        else setAsked(true);
      }}
      onSave={(policy: RetentionPolicyInput) =>
        save.mutate({
          path: `${base}/${view.channelType}`,
          method: "PUT",
          body: policy,
        })
      }
    />
  );
}

function RetentionBody({
  base,
  platform,
  canWrite,
}: {
  base: string;
  platform: boolean;
  canWrite: boolean;
}) {
  const query = useAdminQuery<ScopesResponse>(base);
  const scopes = query.data?.scopes ?? [];
  const first = scopes[0];

  return (
    <QueryState {...query}>
      {first ? (
        <div className="grid gap-4">
          <RetentionStateNotice enabled={first.enabled} floorHours={first.floorHours} />
          {scopes.map((view) => (
            <ScopeWithActions
              key={view.channelType}
              view={view}
              base={base}
              platform={platform}
              canWrite={canWrite}
            />
          ))}
        </div>
      ) : null}
    </QueryState>
  );
}

/** Na página de detalhe de uma organização: política por tipo de canal, prévia e última limpeza. */
export function TenantRetentionCard({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retenção de mensagens</CardTitle>
        <p className="text-sm text-muted-foreground">
          Quanto do atendimento por WhatsApp desta organização é guardado. Cada limite pode herdar
          o padrão do sistema, ficar sem limite ou ter um valor próprio.
        </p>
      </CardHeader>
      <CardContent>
        <RetentionBody
          base={`/api/admin/retention/tenants/${tenantId}`}
          platform={false}
          canWrite={canWrite}
        />
      </CardContent>
    </Card>
  );
}

/** Em `/admin/configuracoes`: o que vale para o atendimento da própria plataforma. Só leitura. */
export function PlatformRetentionCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retenção de mensagens da plataforma</CardTitle>
        <p className="text-sm text-muted-foreground">
          O que vale para o atendimento da própria plataforma: só os padrões do sistema. Cada
          organização tem a sua política na página dela.
        </p>
      </CardHeader>
      <CardContent>
        <RetentionBody base="/api/admin/retention/platform" platform canWrite={false} />
      </CardContent>
    </Card>
  );
}
