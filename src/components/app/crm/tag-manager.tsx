import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/admin/query-state";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { TagChip } from "@/components/crm/tag-chip";
import { TagColorPicker } from "@/components/crm/tag-color-picker";
import {
  type Tag,
  type TagsApi,
  tenantTagsApi,
  useTagMutation,
  useTags,
} from "@/components/crm/tags-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DEFAULT_TAG_COLOR, TAG_LIMIT, TAG_NAME_MAX } from "@/lib/crm/constants";

/** Nome e cor, com a prévia do chip. Usado para criar e para editar. */
function TagFields({
  name,
  color,
  onName,
  onColor,
}: {
  name: string;
  color: string;
  onName: (value: string) => void;
  onColor: (value: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <Input
        value={name}
        onChange={(event) => onName(event.target.value)}
        placeholder="Nome da etiqueta"
        aria-label="Nome da etiqueta"
        maxLength={TAG_NAME_MAX}
      />
      <TagColorPicker value={color} onChange={onColor} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        Prévia:
        <span className="rounded-md bg-white p-1.5 dark:bg-transparent">
          <TagChip name={name.trim() || "Etiqueta"} color={color} />
        </span>
        <span className="hidden rounded-md bg-neutral-950 p-1.5 dark:hidden sm:inline">
          <TagChip name={name.trim() || "Etiqueta"} color={color} />
        </span>
      </div>
    </div>
  );
}

/**
 * Catálogo de etiquetas (`/app/configuracoes/etiquetas` e `/admin/configuracoes/etiquetas`): criar
 * em linha, editar em diálogo e excluir com a contagem de afetados. A API do escopo vem por
 * `api` (tenant por padrão) e é quem confere a permissão; `readOnly` só esconde os botões.
 */
export function TagManager({
  api = tenantTagsApi,
  readOnly = false,
}: {
  api?: TagsApi;
  readOnly?: boolean;
}) {
  const tags = useTags(true, api);
  const save = useTagMutation(undefined, api);
  const remove = useTagMutation("Etiqueta excluída.", api);
  const usageLabel = (usage: number) =>
    `${usage} ${usage === 1 ? api.subject.one : api.subject.many}`;
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(DEFAULT_TAG_COLOR);
  const [deleting, setDeleting] = useState<Tag | null>(null);

  function startEdit(tag: Tag) {
    setEditing(tag);
    setEditName(tag.name);
    setEditColor(tag.color);
  }

  async function create() {
    const done = await save
      .mutateAsync({ path: api.path, method: "POST", body: { name, color } })
      .then(() => true)
      .catch(() => false);
    if (done) {
      setName("");
      setColor(DEFAULT_TAG_COLOR);
    }
  }

  async function update() {
    if (!editing) return;
    await save
      .mutateAsync({
        path: `${api.path}/${editing.id}`,
        method: "PATCH",
        body: { name: editName, color: editColor },
      })
      .then(() => setEditing(null))
      .catch(() => undefined);
  }

  return (
    <div className="space-y-6">
      {readOnly ? null : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nova etiqueta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <TagFields name={name} color={color} onName={setName} onColor={setColor} />
            <Button
              disabled={save.isPending || name.trim().length === 0}
              onClick={create}
            >
              Criar etiqueta
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Etiquetas{tags.data ? ` (${tags.data.length}/${TAG_LIMIT})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState {...tags}>
            {tags.data && tags.data.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nenhuma etiqueta ainda
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {tags.data?.map((tag) => (
                  <li key={tag.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <TagChip name={tag.name} color={tag.color} />
                      <span className="text-xs text-muted-foreground">
                        {usageLabel(tag.usage)}
                      </span>
                    </div>
                    <div className={readOnly ? "hidden" : "flex gap-1"}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Editar ${tag.name}`}
                        onClick={() => startEdit(tag)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Excluir ${tag.name}`}
                        onClick={() => setDeleting(tag)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar etiqueta</DialogTitle>
            <DialogDescription>
              Renomear ou trocar a cor vale para todos os que a usam.
            </DialogDescription>
          </DialogHeader>
          <TagFields
            name={editName}
            color={editColor}
            onName={setEditName}
            onColor={setEditColor}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={save.isPending || editName.trim().length === 0} onClick={update}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={`Excluir “${deleting?.name ?? ""}”?`}
        description={
          deleting && deleting.usage > 0
            ? `Ela será tirada de ${usageLabel(deleting.usage)}. Isso não pode ser desfeito.`
            : `Nenhum ${api.subject.one} usa esta etiqueta. Isso não pode ser desfeito.`
        }
        confirmLabel="Excluir"
        pending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove
            .mutateAsync({ path: `${api.path}/${deleting.id}`, method: "DELETE" })
            .then(() => setDeleting(null))
            .catch(() => undefined);
        }}
      />
    </div>
  );
}
