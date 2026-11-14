import { useQueryClient } from "@tanstack/react-query";
import type { Customer } from "@/components/app/customers/customers-api";
import { useCan } from "@/components/auth/can";
import { PhoneChangeSection } from "@/components/phone/phone-change-section";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api/client";
import { formatPhoneForDisplay } from "@/lib/phone/br";
import { useAuth } from "@/providers/auth-provider";

/**
 * Troca do telefone de uma ficha de cliente pela equipe (SPEC `pre-producao`, "Troca de telefone
 * pelo pedido", TC-5): `POST` e `DELETE /api/customers/:id/phone-change` (`customer:update`), com a
 * troca aberta em `phoneChange` de `GET /api/customers/:id`. A ficha segue com o número atual até
 * o cliente confirmar o link no portal ou quem tem `phone:confirm` liberar na fila de clientes.
 */

/** 409 `PHONE_IN_USE`: o número é de outra ficha da organização (a equipe vê a lista, então pode saber). */
function inUseNotice(error: unknown) {
  if (!(error instanceof ApiError) || error.code !== "PHONE_IN_USE") return null;

  const name = typeof error.details.name === "string" ? error.details.name : null;
  return name
    ? `Este número já é do cliente ${name}. Informe outro.`
    : "Este número já é de outro cliente desta organização. Informe outro.";
}

export function CustomerPhoneChangeCard({ customer }: { customer: Customer }) {
  const can = useCan();
  const { tenant } = useAuth();
  const queryClient = useQueryClient();
  const path = `/api/customers/${customer.id}/phone-change`;
  const reload = () => queryClient.invalidateQueries({ queryKey: ["customers", tenant?.id] });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Trocar o telefone</CardTitle>
      </CardHeader>
      <CardContent>
        <PhoneChangeSection
          audience="customer"
          current={
            customer.phoneNormalized ? formatPhoneForDisplay(customer.phoneNormalized) : "não informado"
          }
          change={customer.phoneChange ?? null}
          disabled={!can("customer", "update")}
          disabledReason="Você não tem permissão para trocar o telefone de clientes."
          inUseNotice={inUseNotice}
          onRequest={async (phone) => {
            await apiFetch(path, { method: "POST", body: JSON.stringify({ phone }) });
            await reload();
          }}
          onCancel={async () => {
            await apiFetch(path, { method: "DELETE" });
            await reload();
          }}
        />
      </CardContent>
    </Card>
  );
}
