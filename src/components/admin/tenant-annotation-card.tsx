import { useEffect, useMemo, useState } from "react";
import { useAdminMutation } from "@/components/admin/admin-api";
import { CustomFieldInput } from "@/components/crm/custom-field-input";
import { platformFieldsApi, useCustomFields } from "@/components/crm/custom-fields-api";
import { TagChip } from "@/components/crm/tag-chip";
import { TagPicker } from "@/components/crm/tag-picker";
import { platformTagsApi } from "@/components/crm/tags-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { displayCustomFieldValue, missingRequired } from "@/lib/crm/values";
import type { CustomFieldValues } from "@/lib/crm/values";

export type OrganizationAnnotation = {
  tags: Array<{ id: string; name: string; color: string }>;
  customFields: Record<string, unknown>;
};

/**
 * Anotação da plataforma sobre a organização (`PUT /api/admin/tenants/:id/profile`): etiquetas e
 * campos adicionais. É dado da plataforma: só `/admin` o mostra, e só o `platform_owner` o edita
 * (o suporte lê). A API confere o papel; `canWrite` só esconde os controles.
 */
export function TenantAnnotationCard({
  tenantId,
  annotation,
  canWrite,
}: {
  tenantId: string;
  annotation: OrganizationAnnotation;
  canWrite: boolean;
}) {
  const fields = useCustomFields("false", true, platformFieldsApi);
  const defs = useMemo(() => fields.data ?? [], [fields.data]);
  const save = useAdminMutation<OrganizationAnnotation>("Anotação salva.");

  const initialTagIds = useMemo(() => annotation.tags.map(({ id }) => id), [annotation.tags]);
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds);
  const [values, setValues] = useState<Record<string, unknown>>(annotation.customFields);
  const [error, setError] = useState<string | null>(null);

  // A anotação volta do servidor depois de salvar (ou de outra aba): o formulário a acompanha.
  useEffect(() => {
    setTagIds(initialTagIds);
    setValues(annotation.customFields);
  }, [initialTagIds, annotation.customFields]);

  const tagsChanged =
    JSON.stringify([...tagIds].sort()) !== JSON.stringify([...initialTagIds].sort());

  // Vazio vira `null` (remove), como no cliente; só os campos ativos que mudaram vão no corpo.
  const normalized = (value: unknown) =>
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
      ? null
      : value;
  const changedFields = Object.fromEntries(
    defs
      .filter(
        ({ id }) =>
          JSON.stringify(normalized(values[id])) !==
          JSON.stringify(normalized(annotation.customFields[id])),
      )
      .map(({ id }) => [id, normalized(values[id])]),
  );
  const fieldsChanged = Object.keys(changedFields).length > 0;
  const dirty = tagsChanged || fieldsChanged;

  function submit() {
    setError(null);

    // O `required` vale sobre o estado final, e só quando o corpo traz `customFields`: trocar só
    // etiquetas não depende de campo obrigatório vazio nem de as definições terem carregado.
    if (fieldsChanged) {
      const final = Object.fromEntries(
        defs.flatMap(({ id }) => {
          const value = normalized(values[id]);
          return value === null ? [] : [[id, value]];
        }),
      ) as CustomFieldValues;
      const missing = missingRequired(defs, final);
      if (missing.length > 0) {
        setError(`Preencha os campos obrigatórios: ${missing.join(", ")}.`);
        return;
      }
    }

    save.mutate({
      path: `/api/admin/tenants/${tenantId}/profile`,
      method: "PUT",
      body: {
        ...(tagsChanged ? { tagIds } : {}),
        ...(fieldsChanged ? { customFields: changedFields } : {}),
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Etiquetas e campos</CardTitle>
        <p className="text-sm text-muted-foreground">
          Anotação da plataforma sobre esta organização. O proprietário e a equipe nunca a veem.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-1.5">
          <Label>Etiquetas</Label>
          {canWrite ? (
            <TagPicker
              value={tagIds}
              onChange={setTagIds}
              api={platformTagsApi}
              canCreate={canWrite}
              disabled={save.isPending}
            />
          ) : annotation.tags.length === 0 ? (
            <p className="text-muted-foreground">Nenhuma etiqueta</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {annotation.tags.map((tag) => (
                <TagChip key={tag.id} name={tag.name} color={tag.color} />
              ))}
            </div>
          )}
        </div>

        {defs.length === 0 ? (
          <p className="text-muted-foreground">
            Nenhum campo cadastrado. Crie em Configurações, “Campos das organizações”.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {defs.map((def) => (
              <div key={def.id} className="grid gap-1.5">
                <Label htmlFor={`org-field-${def.id}`}>
                  {def.label}
                  {def.required ? " *" : ""}
                </Label>
                {canWrite ? (
                  <CustomFieldInput
                    id={`org-field-${def.id}`}
                    field={def}
                    value={values[def.id] ?? null}
                    onChange={(next) => setValues((current) => ({ ...current, [def.id]: next }))}
                  />
                ) : (
                  <p>{displayCustomFieldValue(def, annotation.customFields[def.id]) ?? "—"}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}

        {canWrite ? (
          <Button size="sm" disabled={save.isPending || !dirty} onClick={submit}>
            Salvar anotação
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
