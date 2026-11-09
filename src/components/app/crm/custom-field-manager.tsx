import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/admin/query-state";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import {
  type CustomField,
  type CustomFieldsApi,
  tenantFieldsApi,
  useCustomFieldMutation,
  useCustomFields,
} from "@/components/crm/custom-fields-api";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CUSTOM_FIELD_KEY_MAX,
  CUSTOM_FIELD_LABEL_MAX,
  CUSTOM_FIELD_LIMIT,
  CUSTOM_FIELD_OPTION_LIMIT,
  CUSTOM_FIELD_TYPE_LABELS,
  type CustomFieldType,
  customFieldTypes,
  listFieldTypes,
} from "@/lib/crm/constants";
import { slugifyKey } from "@/lib/crm/values";
import { customFieldSchema } from "@/lib/schemas/crm";

type DraftOption = { value?: string; label: string };

type Draft = {
  /** Sem `id`, cria; com `id`, edita (tipo e chave ficam travados). */
  id?: string;
  label: string;
  key: string;
  keyTouched: boolean;
  type: CustomFieldType;
  options: DraftOption[];
  required: boolean;
};

const TYPE_ITEMS = customFieldTypes.map((type) => ({
  value: type,
  label: CUSTOM_FIELD_TYPE_LABELS[type],
}));

const emptyDraft = (): Draft => ({
  label: "",
  key: "",
  keyTouched: false,
  type: "text",
  options: [],
  required: false,
});

const draftOf = (field: CustomField): Draft => ({
  id: field.id,
  label: field.label,
  key: field.key,
  keyTouched: true,
  type: field.type,
  options: field.options.map((option) => ({ ...option })),
  required: field.required,
});

function FieldDialog({
  api,
  draft,
  onChange,
  onClose,
  pending,
  onSave,
  error,
}: {
  api: CustomFieldsApi;
  draft: Draft | null;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  pending: boolean;
  onSave: () => void;
  error: string | null;
}) {
  if (!draft) return null;

  const editing = draft.id !== undefined;
  const isList = listFieldTypes.includes(draft.type);

  function setOption(index: number, label: string) {
    if (!draft) return;
    onChange({
      ...draft,
      options: draft.options.map((option, n) => (n === index ? { ...option, label } : option)),
    });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Editar campo" : "Novo campo"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "O tipo e a chave não mudam depois de criados."
              : `Aparece no cadastro de todos os ${api.subject.many}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="field-label">Nome do campo</Label>
            <Input
              id="field-label"
              value={draft.label}
              maxLength={CUSTOM_FIELD_LABEL_MAX}
              onChange={(event) =>
                onChange({
                  ...draft,
                  label: event.target.value,
                  key: draft.keyTouched || editing ? draft.key : slugifyKey(event.target.value),
                })
              }
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="field-type">Tipo</Label>
            <Select
              items={TYPE_ITEMS}
              value={draft.type}
              disabled={editing}
              onValueChange={(next) =>
                next && onChange({ ...draft, type: next as CustomFieldType, options: [] })
              }
            >
              <SelectTrigger id="field-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="field-key">Chave</Label>
            <Input
              id="field-key"
              value={draft.key}
              maxLength={CUSTOM_FIELD_KEY_MAX}
              disabled={editing}
              onChange={(event) =>
                onChange({
                  ...draft,
                  key: event.target.value.toLowerCase(),
                  keyTouched: true,
                })
              }
              placeholder="gerada do nome"
            />
            <p className="text-xs text-muted-foreground">
              Identifica o campo em importações e integrações. Letras minúsculas, números e _.
            </p>
          </div>

          {isList ? (
            <div className="grid gap-2">
              <Label>Opções</Label>
              {draft.options.map((option, index) => (
                <div key={option.value ?? `novo-${index}`} className="flex items-center gap-2">
                  <Input
                    value={option.label}
                    aria-label={`Opção ${index + 1}`}
                    maxLength={CUSTOM_FIELD_LABEL_MAX}
                    onChange={(event) => setOption(index, event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remover opção ${index + 1}`}
                    onClick={() =>
                      onChange({ ...draft, options: draft.options.filter((_, n) => n !== index) })
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draft.options.length >= CUSTOM_FIELD_OPTION_LIMIT}
                  onClick={() => onChange({ ...draft, options: [...draft.options, { label: "" }] })}
                >
                  <Plus className="size-3.5" />
                  Adicionar opção
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Renomear uma opção vale para quem já a escolheu. Tirar uma opção em uso não é permitido.
              </p>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(event) => onChange({ ...draft, required: event.target.checked })}
            />
            Obrigatório no {api.subject.form}
          </label>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={pending || draft.label.trim().length === 0} onClick={onSave}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  api,
  readOnly,
  field,
  index,
  total,
  busy,
  onEdit,
  onMove,
  onArchive,
  onDelete,
}: {
  api: CustomFieldsApi;
  readOnly: boolean;
  field: CustomField;
  index: number;
  total: number;
  busy: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archived = field.archived;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{field.label}</span>
          <Badge variant="secondary">{CUSTOM_FIELD_TYPE_LABELS[field.type]}</Badge>
          {field.required ? <Badge variant="outline">Obrigatório</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <code>{field.key}</code> ·{" "}
          {field.usage === 1 ? `1 ${api.subject.one}` : `${field.usage} ${api.subject.many}`}
        </p>
      </div>
      <div className={readOnly ? "hidden" : "flex gap-1"}>
        {archived ? null : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Subir ${field.label}`}
              disabled={busy || index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Descer ${field.label}`}
              disabled={busy || index === total - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={`Editar ${field.label}`} onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${archived ? "Reativar" : "Arquivar"} ${field.label}`}
          disabled={busy}
          onClick={onArchive}
        >
          {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Excluir ${field.label}`}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}

/**
 * Catálogo de campos adicionais (`/app/configuracoes/campos` e `/admin/configuracoes/campos`):
 * lista ordenável, diálogo de criar e editar, arquivar (reversível) e excluir digitando a `key`
 * (apaga o valor de todos os cadastros). A API do escopo vem por `api` (cliente do tenant por
 * padrão) e é quem confere a permissão; `readOnly` só esconde os botões.
 */
export function CustomFieldManager({
  api = tenantFieldsApi,
  readOnly = false,
}: {
  api?: CustomFieldsApi;
  readOnly?: boolean;
}) {
  const fields = useCustomFields("all", true, api);
  const save = useCustomFieldMutation(undefined, api);
  const order = useCustomFieldMutation(undefined, api);
  const archive = useCustomFieldMutation(undefined, api);
  const remove = useCustomFieldMutation("Campo excluído.", api);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CustomField | null>(null);
  const [confirmKey, setConfirmKey] = useState("");

  const active = (fields.data ?? []).filter(({ archived }) => !archived);
  const archivedFields = (fields.data ?? []).filter(({ archived }) => archived);
  const full = active.length >= CUSTOM_FIELD_LIMIT;

  function openDraft(next: Draft | null) {
    setFormError(null);
    setDraft(next);
  }

  async function submit() {
    if (!draft) return;

    const options = isListDraft(draft)
      ? draft.options.map(({ value, label }) => ({ ...(value ? { value } : {}), label }))
      : undefined;

    if (draft.id) {
      // Tipo e chave não vão: o servidor não os aceita no PATCH.
      const parsed = customFieldSchema.safeParse({
        entity: api.entity,
        label: draft.label,
        type: draft.type,
        options,
        required: draft.required,
      });
      if (!parsed.success) return setFormError(parsed.error.issues[0]?.message ?? "Dados inválidos.");

      await save
        .mutateAsync({
          path: `${api.path}/${draft.id}`,
          method: "PATCH",
          body: {
            label: parsed.data.label,
            required: draft.required,
            ...(options ? { options } : {}),
          },
        })
        .then(() => openDraft(null))
        .catch((error: Error) => setFormError(error.message));
      return;
    }

    const parsed = customFieldSchema.safeParse({
      entity: api.entity,
      label: draft.label,
      ...(draft.key ? { key: draft.key } : {}),
      type: draft.type,
      options,
      required: draft.required,
    });
    if (!parsed.success) return setFormError(parsed.error.issues[0]?.message ?? "Dados inválidos.");

    await save
      .mutateAsync({ path: api.path, method: "POST", body: parsed.data })
      .then(() => openDraft(null))
      .catch((error: Error) => setFormError(error.message));
  }

  function move(index: number, direction: -1 | 1) {
    const ids = active.map(({ id }) => id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];

    order.mutate({
      path: `${api.path}/order`,
      method: "PUT",
      body: { entity: api.entity, ids },
    });
  }

  function toggleArchive(field: CustomField) {
    archive.mutate({
      path: `${api.path}/${field.id}`,
      method: "PATCH",
      body: { archived: !field.archived },
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">
            Campos ativos{fields.data ? ` (${active.length}/${CUSTOM_FIELD_LIMIT})` : ""}
          </CardTitle>
          {readOnly ? null : (
            <Button size="sm" disabled={full} onClick={() => openDraft(emptyDraft())}>
              <Plus className="size-3.5" />
              Novo campo
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <QueryState {...fields}>
            {full ? (
              <p className="pb-2 text-xs text-muted-foreground">
                Limite de {CUSTOM_FIELD_LIMIT} campos ativos. Arquive um campo para liberar vaga.
              </p>
            ) : null}
            {active.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nenhum campo adicional ainda
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {active.map((field, index) => (
                  <FieldRow
                    key={field.id}
                    api={api}
                    readOnly={readOnly}
                    field={field}
                    index={index}
                    total={active.length}
                    busy={order.isPending || archive.isPending}
                    onEdit={() => openDraft(draftOf(field))}
                    onMove={(direction) => move(index, direction)}
                    onArchive={() => toggleArchive(field)}
                    onDelete={() => {
                      setConfirmKey("");
                      setDeleting(field);
                    }}
                  />
                ))}
              </ul>
            )}
          </QueryState>
        </CardContent>
      </Card>

      {archivedFields.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Arquivados ({archivedFields.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="pb-2 text-xs text-muted-foreground">
              Somem do formulário, mas os valores ficam guardados. Reativar devolve o campo.
            </p>
            <ul className="divide-y divide-border">
              {archivedFields.map((field, index) => (
                <FieldRow
                  key={field.id}
                  api={api}
                  readOnly={readOnly}
                  field={field}
                  index={index}
                  total={archivedFields.length}
                  busy={archive.isPending}
                  onEdit={() => openDraft(draftOf(field))}
                  onMove={() => undefined}
                  onArchive={() => toggleArchive(field)}
                  onDelete={() => {
                    setConfirmKey("");
                    setDeleting(field);
                  }}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <FieldDialog
        api={api}
        draft={draft}
        onChange={setDraft}
        onClose={() => openDraft(null)}
        pending={save.isPending}
        onSave={submit}
        error={formError}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Excluir “${deleting?.label ?? ""}”?`}
        description={
          deleting ? (
            <span className="grid gap-3">
              <span>
                {deleting.usage > 0
                  ? `O valor será apagado de ${deleting.usage} ${deleting.usage === 1 ? api.subject.one : api.subject.many}.`
                  : `Nenhum ${api.subject.one} tem valor neste campo.`}{" "}
                Isso não pode ser desfeito. Para apenas esconder o campo, arquive.
              </span>
              <span className="grid gap-1.5">
                <Label htmlFor="confirm-key">
                  Digite <code>{deleting.key}</code> para confirmar
                </Label>
                <Input
                  id="confirm-key"
                  value={confirmKey}
                  onChange={(event) => setConfirmKey(event.target.value)}
                  autoComplete="off"
                />
              </span>
            </span>
          ) : null
        }
        confirmLabel="Excluir"
        pending={remove.isPending || confirmKey.trim() !== deleting?.key}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove
            .mutateAsync({
              path: `${api.path}/${deleting.id}`,
              method: "DELETE",
              body: { confirm: confirmKey },
            })
            .then(() => setDeleting(null))
            .catch(() => undefined);
        }}
      />
    </div>
  );
}

function isListDraft(draft: Draft) {
  return listFieldTypes.includes(draft.type);
}
