import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api/client";

/**
 * Quem pediu a exclusão sem ter senha chega aqui pelo link do e-mail. A página só mostra o
 * botão: o token é consumido pelo clique (POST), nunca por abrir o link. Aparece em
 * `/portal/conta` e na tela "Confirme seu WhatsApp" do portal (T3-7).
 */
export function ConfirmDeletionCard({ token, onDone }: { token: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: () =>
      apiFetch("/api/portal/me/deletion/confirm", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: async () => {
      toast.success("Exclusão confirmada e agendada.");
      await queryClient.invalidateQueries({ queryKey: ["privacy", "deletion"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base">Confirmar a exclusão da sua conta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Depois de confirmar, seus dados serão anonimizados em 30 dias. Até lá você pode desistir
          nesta mesma página.
        </p>
        <div className="flex gap-2">
          <Button
            variant="destructive"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Confirmar exclusão
          </Button>
          <Button variant="outline" onClick={onDone}>
            Não excluir
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
