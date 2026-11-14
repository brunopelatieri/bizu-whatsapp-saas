import { useId, useState } from "react";
import { CHANNEL_KINDS } from "@/components/channels/channel-kinds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RetentionView } from "@/lib/inbox/retention";
import {
  type DimensionInfo,
  DIMENSIONS,
  describeLastRun,
  describePreview,
  draftFromPolicy,
  floorLabel,
  formatCount,
  inheritLabel,
  isDirty,
  type LimitDraft,
  type LimitMode,
  limitLabel,
  type PolicyDraft,
  platformSourceLabel,
  policyFromDraft,
  type RunRow,
  sourceLabel,
  stateNotice,
} from "@/lib/inbox/retention-format";
import type { RetentionRunResult } from "@/lib/inbox/retention-policy";
import type { RetentionPolicyInput } from "@/lib/schemas/retention";
import { cn } from "@/lib/utils";

/**
 * Peças da tela de retenção do `/admin` (bloco R, R3b). Só apresentação: quem busca e grava é
 * `retention-card.tsx`, sobre `/api/admin/retention/*`. O que vale e de onde vem chega pronto em
 * `RetentionView`; aqui nada recalcula a precedência.
 */

/** Estado da prévia, vindo de quem a busca. */
export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: RetentionRunResult };

/** O aviso de estado do servidor: desligada (nada se apaga) ou ligada (apaga sem volta). */
export function RetentionStateNotice({
  enabled,
  floorHours,
}: {
  enabled: boolean;
  floorHours: number;
}) {
  const notice = stateNotice(enabled, floorHours);

  return (
    <div
      role="status"
      data-retention-state={notice.tone}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        notice.tone === "on"
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-muted/50",
      )}
    >
      <p className="font-medium">{notice.title}</p>
      <p className="mt-0.5 text-muted-foreground">{notice.body}</p>
    </div>
  );
}

function RunList({ rows }: { rows: RunRow[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd className="font-medium tabular-nums">{formatCount(row.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Uma das três opções de um limite: herdar, sem limite ou um número. */
function LimitField({
  info,
  draft,
  defaultValue,
  error,
  disabled,
  onChange,
}: {
  info: DimensionInfo;
  draft: LimitDraft;
  defaultValue: number | null;
  error?: string;
  disabled: boolean;
  onChange: (next: LimitDraft) => void;
}) {
  const name = useId();
  const numberId = useId();
  const errorId = useId();

  const options: Array<{ mode: LimitMode; label: string }> = [
    { mode: "inherit", label: inheritLabel(info, defaultValue) },
    { mode: "unlimited", label: "Sem limite" },
    { mode: "number", label: "Definir um valor" },
  ];

  return (
    <fieldset className="grid gap-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">{info.label}</legend>
      {options.map((option) => (
        <div key={option.mode} className="grid gap-1.5">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={option.mode}
              checked={draft.mode === option.mode}
              onChange={() => onChange({ ...draft, mode: option.mode })}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>{option.label}</span>
          </label>
          {option.mode === "number" ? (
            <div className="ml-6 flex items-center gap-1.5">
              <Input
                id={numberId}
                type="number"
                inputMode="numeric"
                min={1}
                max={info.max}
                step={1}
                value={draft.value}
                disabled={draft.mode !== "number"}
                aria-label={`${info.label}: valor`}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => onChange({ mode: "number", value: event.target.value })}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">{info.unit}</span>
            </div>
          ) : null}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        {info.hint} Máximo {formatCount(info.max)}.
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function PreviewBlock({
  preview,
  batchLimit,
  dirty,
  platform,
  onPreview,
}: {
  preview: PreviewState;
  batchLimit: number;
  dirty: boolean;
  platform: boolean;
  onPreview: () => void;
}) {
  const summary = preview.status === "ready" ? describePreview(preview.result, batchLimit) : null;

  return (
    <div className="grid gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">Prévia</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onPreview}
          disabled={preview.status === "loading"}
        >
          {preview.status === "idle" ? "Ver prévia" : "Atualizar prévia"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {platform
          ? "Não apaga nada. Usa os padrões do sistema."
          : "Não apaga nada. Usa a política já gravada, não o que está digitado e ainda não foi salvo."}
        {dirty ? " Há alterações não salvas: salve para a prévia considerá-las." : ""}
      </p>
      {preview.status === "loading" ? <p className="text-muted-foreground">Calculando…</p> : null}
      {preview.status === "error" ? (
        <p role="alert" className="text-destructive">
          {preview.message}
        </p>
      ) : null}
      {summary ? (
        <div className="grid gap-2">
          <p>{summary.headline}</p>
          <RunList rows={summary.rows} />
          <p className="text-muted-foreground">{summary.totals}</p>
          {summary.truncatedNote ? (
            <p className="text-muted-foreground">{summary.truncatedNote}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LimitSummary({
  info,
  view,
  platform,
}: {
  info: DimensionInfo;
  view: RetentionView;
  platform: boolean;
}) {
  const source = view.sources[info.key];

  return (
    <div className="grid gap-0.5 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{info.label}</p>
      <p className="font-medium">{limitLabel(info, view.effective[info.key])}</p>
      <p className="text-xs text-muted-foreground">
        {platform ? platformSourceLabel(source) : sourceLabel(source)}
      </p>
    </div>
  );
}

/**
 * Um tipo de canal de um escopo: o que vale (e de onde vem), o piso, a última limpeza, o
 * formulário (só com `canWrite`) e a prévia. Na plataforma não há linha de política: só leitura.
 */
export function RetentionScope({
  view,
  canWrite,
  platform = false,
  saving = false,
  preview,
  onSave,
  onPreview,
}: {
  view: RetentionView;
  canWrite: boolean;
  platform?: boolean;
  saving?: boolean;
  preview: PreviewState;
  onSave: (policy: RetentionPolicyInput) => void;
  onPreview: () => void;
}) {
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromPolicy(view.policy));
  const [errors, setErrors] = useState<Partial<Record<DimensionInfo["key"], string>>>({});
  const editable = canWrite && !platform;
  const dirty = editable && isDirty(draft, view.policy);
  const lastRun = describeLastRun(view.lastRun);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = policyFromDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSave(result.policy);
  }

  return (
    <section
      aria-label={CHANNEL_KINDS[view.channelType].label}
      className="grid gap-4 rounded-xl border p-4"
    >
      <h3 className="text-sm font-semibold">{CHANNEL_KINDS[view.channelType].label}</h3>

      <div className="grid gap-2 sm:grid-cols-3">
        {DIMENSIONS.map((info) => (
          <LimitSummary key={info.key} info={info} view={view} platform={platform} />
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Piso de idade: {floorLabel(view.floorHours)}. Nenhuma mensagem mais nova que isto é
        apagada, qualquer que seja a política.
      </p>

      <div className="grid gap-1 text-sm">
        <h4 className="font-medium">Última limpeza</h4>
        <p>{lastRun.headline}</p>
        {view.lastRun ? <RunList rows={lastRun.rows} /> : null}
        {lastRun.totals ? <p className="text-muted-foreground">{lastRun.totals}</p> : null}
        {lastRun.truncatedNote ? (
          <p className="text-muted-foreground">{lastRun.truncatedNote}</p>
        ) : null}
      </div>

      {editable ? (
        <form onSubmit={submit} className="grid gap-4 border-t pt-4" noValidate>
          <h4 className="text-sm font-medium">Política desta organização</h4>
          <div className="grid gap-4 md:grid-cols-3">
            {DIMENSIONS.map((info) => (
              <LimitField
                key={info.key}
                info={info}
                draft={draft[info.key]}
                defaultValue={view.defaults[info.key]}
                error={errors[info.key]}
                disabled={saving}
                onChange={(next) => {
                  setDraft((current) => ({ ...current, [info.key]: next }));
                  // O erro era do valor anterior: some ao editar.
                  setErrors((current) => ({ ...current, [info.key]: undefined }));
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || !dirty}>
              Salvar política
            </Button>
            {dirty ? (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setDraft(draftFromPolicy(view.policy));
                  setErrors({});
                }}
              >
                Descartar alterações
              </Button>
            ) : null}
          </div>
        </form>
      ) : platform ? (
        <p className="text-xs text-muted-foreground">
          A plataforma usa só os padrões do sistema, definidos no servidor. Não há o que editar
          aqui.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Só o proprietário da plataforma altera esta política.
        </p>
      )}

      <PreviewBlock
        preview={preview}
        batchLimit={view.batchLimit}
        dirty={dirty}
        platform={platform}
        onPreview={onPreview}
      />
    </section>
  );
}
