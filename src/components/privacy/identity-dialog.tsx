import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type IdentityValues = { password?: string; totp?: string };

/**
 * Confirmação de ação sem volta: pede a senha e, com 2FA, o código. A verificação é do
 * servidor (`confirmIdentity`); aqui só se coleta. A senha é opcional para quem não tem
 * (cliente do portal que entrou por link): o servidor então confirma por e-mail.
 */
export function IdentityDialog({
  open,
  title,
  description,
  confirmLabel,
  needsTotp = false,
  needsPassword = true,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  needsTotp?: boolean;
  needsPassword?: boolean;
  pending: boolean;
  onConfirm: (values: IdentityValues) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");

  const ready = (!needsPassword || password.length > 0) && (!needsTotp || totp.length === 6);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;

    onConfirm({
      ...(needsPassword ? { password } : {}),
      ...(needsTotp ? { totp } : {}),
    });
  }

  function cancel() {
    setPassword("");
    setTotp("");
    onCancel();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {needsPassword ? (
            <div className="grid gap-1.5">
              <Label htmlFor="identity-password">Sua senha</Label>
              <Input
                id="identity-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : null}

          {needsTotp ? (
            <div className="grid gap-1.5">
              <Label htmlFor="identity-totp">Código do aplicativo autenticador</Label>
              <Input
                id="identity-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={totp}
                onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={!ready || pending}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
