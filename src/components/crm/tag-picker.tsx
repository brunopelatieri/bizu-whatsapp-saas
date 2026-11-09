import { Tags } from "lucide-react";
import { useState } from "react";
import { useCan } from "@/components/auth/can";
import { TagChip } from "@/components/crm/tag-chip";
import { type Tag, useTagMutation, useTags } from "@/components/crm/tags-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CUSTOMER_TAG_LIMIT, DEFAULT_TAG_COLOR } from "@/lib/crm/constants";

/**
 * Etiquetas de um cliente: chips e um painel com busca e caixas de seleção. Controlado por
 * ids; quem usa decide quando gravar (o formulário no envio, o detalhe na hora). O painel
 * abre ali mesmo, sem diálogo: o seletor vive dentro de formulários que já são diálogos.
 * "Criar" só aparece para quem tem `tag:manage` e já marca a etiqueta nova.
 */
export function TagPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const tags = useTags();
  const create = useTagMutation();
  const can = useCan();

  const all = tags.data ?? [];
  const selected = all.filter(({ id }) => value.includes(id));
  const term = search.trim().toLowerCase();
  const visible = term ? all.filter(({ name }) => name.toLowerCase().includes(term)) : all;
  const canCreate =
    can("tag", "manage") && term.length > 0 && !all.some(({ name }) => name.toLowerCase() === term);

  function toggle(tag: Tag) {
    if (value.includes(tag.id)) {
      onChange(value.filter((id) => id !== tag.id));
    } else if (value.length < CUSTOMER_TAG_LIMIT) {
      onChange([...value, tag.id]);
    }
  }

  async function createAndSelect() {
    const created = await create
      .mutateAsync({
        path: "/api/tags",
        method: "POST",
        body: { name: search.trim(), color: DEFAULT_TAG_COLOR },
      })
      .catch(() => undefined);

    if (created?.tag) {
      onChange([...value, created.tag.id]);
      setSearch("");
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.length === 0 ? (
          <span className="text-sm text-muted-foreground">Nenhuma etiqueta</span>
        ) : (
          selected.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Tags className="size-3.5" />
          {open ? "Fechar" : "Etiquetas"}
        </Button>
      </div>

      {open ? (
        <div className="grid gap-2 rounded-lg border border-border p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Enter aqui não pode enviar o formulário que contém o seletor.
              if (event.key === "Enter") {
                event.preventDefault();
                if (canCreate) void createAndSelect();
              }
            }}
            placeholder="Buscar ou criar etiqueta"
            aria-label="Buscar etiqueta"
            maxLength={40}
          />
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {tags.isPending ? (
              <p className="py-3 text-center text-sm text-muted-foreground">Carregando…</p>
            ) : visible.length === 0 && !canCreate ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                {all.length === 0 ? "Nenhuma etiqueta ainda" : "Nenhuma etiqueta encontrada"}
              </p>
            ) : (
              visible.map((tag) => (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(tag.id)}
                    onChange={() => toggle(tag)}
                  />
                  <TagChip name={tag.name} color={tag.color} />
                </label>
              ))
            )}
          </div>
          {canCreate ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={create.isPending}
              onClick={createAndSelect}
            >
              Criar “{search.trim()}”
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Até {CUSTOMER_TAG_LIMIT} etiquetas por cliente.
          </p>
        </div>
      ) : null}
    </div>
  );
}
