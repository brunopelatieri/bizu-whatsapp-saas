import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { AvatarCropDialog } from "@/components/profile/avatar-crop-dialog";
import { UserAvatar } from "@/components/profile/user-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api/client";
import { getUserDisplayName } from "@/lib/auth/user-display";
import { AVATAR_ACCEPTED_TYPES, checkPickedFile, PICK_ERROR_MESSAGES } from "@/lib/profile/avatar-crop";
import { useAuth } from "@/providers/auth-provider";

/** Uma mensagem para cada recusa da foto (`POST /api/me/avatar`): tipo, tamanho, personificação. */
export function avatarErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Não foi possível enviar a foto.";
  }

  switch (error.status) {
    case 415:
      return "Tipo de imagem não aceito. Use PNG, JPEG ou WebP.";
    case 413:
      return "A foto passou do tamanho que o sistema aceita. Escolha uma imagem mais simples ou menor.";
    case 403:
      return error.code === "IMPERSONATION_BLOCKED"
        ? "Durante o acesso de suporte não é possível trocar a foto."
        : error.message;
    case 429:
      return "Muitos envios seguidos. Tente de novo em alguns minutos.";
    default:
      return error.message;
  }
}

/** Foto de perfil: escolher, recortar em quadrado de 256 px no navegador, enviar e remover. */
export function AvatarCard() {
  const { user, reloadAccount } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const readOnly = Boolean(user?.impersonatedBy);
  const name = getUserDisplayName(user);

  const upload = useMutation({
    mutationFn: (blob: Blob) => {
      const body = new FormData();
      body.append("file", blob, blob.type === "image/webp" ? "foto.webp" : "foto.png");
      return apiFetch("/api/me/avatar", { method: "POST", body });
    },
    onSuccess: async () => {
      toast.success("Foto atualizada.");
      setPicked(null);
      await reloadAccount();
    },
    onError: (error) => toast.error(avatarErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => apiFetch("/api/me/avatar", { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Foto removida.");
      await reloadAccount();
    },
    onError: (error) => toast.error(avatarErrorMessage(error)),
  });

  const onUnreadable = useCallback((message: string) => {
    toast.error(message);
    setPicked(null);
  }, []);

  function onPick(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file) return;

    const problem = checkPickedFile(file);
    if (problem) {
      toast.error(PICK_ERROR_MESSAGES[problem]);
      return;
    }
    setPicked(file);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Foto</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar
            userId={user?.id}
            name={name}
            className="size-20"
            fallbackClassName="text-xl"
          />
          {readOnly ? (
            <p className="text-muted-foreground">
              Durante o acesso de suporte a foto não pode ser alterada.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input
                ref={input}
                type="file"
                accept={AVATAR_ACCEPTED_TYPES.join(",")}
                className="sr-only"
                aria-label="Escolher a foto de perfil"
                tabIndex={-1}
                onChange={(event) => onPick(event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                disabled={upload.isPending || remove.isPending}
                onClick={() => input.current?.click()}
              >
                {user?.avatarUrl ? "Trocar a foto" : "Escolher a foto"}
              </Button>
              {user?.avatarUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={upload.isPending || remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" /> : null}
                  Remover a foto
                </Button>
              ) : null}
            </div>
          )}
        </div>
        <p className="text-muted-foreground">
          PNG, JPEG ou WebP. A foto aparece para quem divide uma organização com você e para a equipe
          da plataforma. Sem foto, aparecem suas iniciais.
        </p>
      </CardContent>

      <AvatarCropDialog
        file={picked}
        pending={upload.isPending}
        onCancel={() => setPicked(null)}
        onConfirm={(blob) => upload.mutate(blob)}
        onUnreadable={onUnreadable}
      />
    </Card>
  );
}
