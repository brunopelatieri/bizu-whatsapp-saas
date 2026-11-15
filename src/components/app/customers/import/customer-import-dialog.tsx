import { useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Link2, Loader2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fetchGoogleSheetFile,
  postImportBatch,
  useImportQuota,
} from "@/components/app/customers/import/import-api";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api/client";
import { displayPhone } from "@/lib/phone/br";
import type { ImportRowResult } from "@/lib/schemas/customer-import";
import { IMPORT_COLUMNS } from "@/lib/spreadsheet/columns";
import { customerFieldsFromRow } from "@/lib/spreadsheet/customer-row";
import { GoogleSheetLinkError, parseGoogleSheetLink } from "@/lib/spreadsheet/google-sheets-link";
import { type ImportRun, planImport, runImport } from "@/lib/spreadsheet/import-plan";
import { readSpreadsheetFile } from "@/lib/spreadsheet/read-file";
import { buildTemplateCsv, TEMPLATE_FILENAME } from "@/lib/spreadsheet/template-file";
import {
  MAX_IMPORT_ROWS,
  MAX_SPREADSHEET_BYTES,
  SpreadsheetParseError,
  type SpreadsheetReadResult,
} from "@/lib/spreadsheet/types";
import { cn } from "@/lib/utils";

const PREVIEW_ROWS = 5;
/** A lista de rejeitadas mostra tantas linhas por vez; o resto aparece com "Mostrar mais". */
const REJECTED_PAGE = 200;

const STATUS_LABEL: Record<ImportRowResult["status"], string> = {
  created: "Criada",
  duplicate: "Já cadastrada",
  invalid: "Inválida",
  limit: "Sem vaga no plano",
};

const nf = new Intl.NumberFormat("pt-BR");

function downloadTemplate() {
  const blob = new Blob([buildTemplateCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = TEMPLATE_FILENAME;
  link.click();
  URL.revokeObjectURL(url);
}

function Counters({ items }: { items: [label: string, value: number][] }) {
  return (
    <p className="flex flex-wrap gap-x-2 text-sm" aria-live="polite">
      {items.map(([label, value], index) => (
        <span key={label}>
          {index > 0 ? <span className="mr-2 text-muted-foreground">·</span> : null}
          <span className="text-muted-foreground">{label} </span>
          <strong className="tabular-nums">{nf.format(value)}</strong>
        </span>
      ))}
    </p>
  );
}

function ColumnsReference() {
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Colunas da planilha</summary>
      <p className="mt-2 text-muted-foreground">
        A primeira linha é o cabeçalho. Colunas que o sistema não conhece são ignoradas, então a
        planilha pode ficar como já está.
      </p>
      <ul className="mt-2 space-y-2">
        {IMPORT_COLUMNS.map((column) => (
          <li key={column.key}>
            <code className="rounded bg-muted px-1">{column.header}</code>{" "}
            <span className="text-xs text-muted-foreground">
              {column.required ? "obrigatória" : "opcional"}
              {column.aliases.length > 0 ? ` · também aceita: ${column.aliases.join(", ")}` : ""}
            </span>
            <br />
            <span className="text-muted-foreground">{column.description}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground">
        Etiqueta que ainda não existe só é criada por quem gerencia etiquetas (até 100 por
        organização); para os demais ela é ignorada, e o aviso aparece no resultado. Telefone que já
        é de outro cliente é pulado: a ficha existente nunca é alterada.
      </p>
    </details>
  );
}

function RejectedList({ rows }: { rows: ImportRowResult[] }) {
  const [shown, setShown] = useState(REJECTED_PAGE);
  if (rows.length === 0) return null;

  return (
    <section aria-label="Linhas não importadas" className="space-y-2">
      <h3 className="text-sm font-medium">Não importadas ({nf.format(rows.length)})</h3>
      <div className="max-h-56 overflow-y-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Linha</TableHead>
              <TableHead className="w-36">Situação</TableHead>
              <TableHead>Motivo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, shown).map((row) => (
              <TableRow key={`${row.sourceRow}-${row.status}`}>
                <TableCell className="tabular-nums">{row.sourceRow}</TableCell>
                <TableCell>{STATUS_LABEL[row.status]}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">
                  {row.reason ?? "Entra quando o plano tiver vaga."}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > shown ? (
        <Button variant="outline" size="sm" onClick={() => setShown((n) => n + REJECTED_PAGE)}>
          Mostrar mais
        </Button>
      ) : null}
    </section>
  );
}

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "Muitos envios em pouco tempo. Aguarde alguns minutos e importe o arquivo de novo: o que já entrou é pulado como cadastrado.";
    }
    return error.message;
  }
  return "Não foi possível concluir. Importe o arquivo de novo: o que já entrou é pulado como cadastrado.";
}

export function CustomerImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef(false);

  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [sheets, setSheets] = useState<string[]>([]);
  const [table, setTable] = useState<SpreadsheetReadResult | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [finished, setFinished] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [fetchingLink, setFetchingLink] = useState(false);

  const quota = useImportQuota(!finished);
  const plan = useMemo(() => (table ? planImport(table.rows) : null), [table]);

  async function load(next: File, sheetName?: string) {
    setFile(next);
    setReading(true);
    setReadError(null);
    setTable(null);
    setRun(null);
    setFinished(false);

    try {
      const result = await readSpreadsheetFile(next, { sheetName });
      setTable(result);
      setSheets(result.sheetNames ?? []);
      setSheet(result.sheetName);
    } catch (error) {
      if (error instanceof SpreadsheetParseError) {
        setReadError(error.message);
        // Erro de uma aba (sem telefone, grande demais): a pessoa ainda pode escolher outra.
        setSheets(error.sheetNames ?? []);
        setSheet(sheetName ?? error.sheetNames?.[0]);
      } else {
        setReadError("Não consegui ler o arquivo.");
        setSheets([]);
      }
    } finally {
      setReading(false);
    }
  }

  /**
   * Planilha do Google (I3): o servidor baixa o CSV, e daqui em diante é o mesmo caminho do arquivo
   * enviado (`load`). O link é conferido aqui só para avisar na hora; o servidor confere de novo.
   */
  async function loadFromLink(event: React.FormEvent) {
    event.preventDefault();
    setLinkError(null);
    setReadError(null);

    try {
      parseGoogleSheetLink(link);
    } catch (error) {
      setLinkError(error instanceof GoogleSheetLinkError ? error.message : "Link inválido.");
      return;
    }

    setFetchingLink(true);
    try {
      await load(await fetchGoogleSheetFile(link.trim()));
    } catch (error) {
      setLinkError(
        error instanceof ApiError
          ? error.status === 429
            ? "Muitas buscas em pouco tempo. Aguarde alguns minutos, ou baixe a planilha em .csv e envie o arquivo."
            : error.message
          : "Não consegui buscar a planilha. Tente de novo.",
      );
    } finally {
      setFetchingLink(false);
    }
  }

  function reset() {
    setLinkError(null);
    setFile(null);
    setTable(null);
    setSheets([]);
    setSheet(undefined);
    setReadError(null);
    setRun(null);
    setFinished(false);
    if (input.current) input.current.value = "";
  }

  async function start() {
    if (!plan || plan.send.length === 0) return;

    cancel.current = false;
    setRunning(true);
    setRun(null);

    const result = await runImport(plan.send, postImportBatch, {
      onProgress: setRun,
      shouldStop: () => cancel.current,
    });

    setRun(result);
    setRunning(false);
    setFinished(true);
    await queryClient.invalidateQueries({ queryKey: ["customers"] });
    if (result.tags.created > 0) await queryClient.invalidateQueries({ queryKey: ["tags"] });

    const created = result.results.filter(({ status }) => status === "created").length;
    if (result.stopped === "error") toast.error(describeError(result.error));
    else if (created > 0) toast.success(`${nf.format(created)} clientes importados.`);
  }

  const outcome = useMemo(() => {
    if (!finished || !run || !plan) return null;

    const counts = { created: 0, duplicate: 0, invalid: 0, limit: 0 };
    let teamLinked = 0;
    for (const row of run.results) {
      counts[row.status] += 1;
      if (row.teamLinked) teamLinked += 1;
    }
    // O que o arquivo já trazia recusado (inválida e repetida) soma ao que o servidor recusou.
    counts.duplicate += plan.counts.duplicate;
    counts.invalid += plan.counts.invalid;

    const rejected = [
      ...plan.rejected,
      ...run.results.filter(({ status }) => status !== "created"),
    ].sort((a, b) => a.sourceRow - b.sourceRow);
    const notSent = plan.send.length - run.results.length;

    return { counts, teamLinked, rejected, notSent };
  }, [finished, run, plan]);

  const available = quota.data?.available ?? null;
  const overQuota = plan && available !== null && plan.counts.valid > available;
  const accept = ".csv,.xlsx";
  const progress = plan && run && plan.send.length > 0 ? run.results.length / plan.send.length : 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      {/* `minmax(0,1fr)`: sem isso a tabela (mais larga que a tela) estica a coluna do grid e o texto sai do diálogo. */}
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar clientes</DialogTitle>
          <DialogDescription>
            Envie uma planilha .csv ou Excel (.xlsx) de até {MAX_SPREADSHEET_BYTES / (1024 * 1024)}{" "}
            MB e {nf.format(MAX_IMPORT_ROWS)} linhas, ou cole o link de uma planilha do Google
            Planilhas. A planilha é lida aqui no seu navegador; só as linhas seguem para o sistema.
          </DialogDescription>
        </DialogHeader>

        {!table && !finished ? (
          <div className="space-y-3">
            <label
              className={cn(
                "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors focus-within:ring-2 focus-within:ring-ring",
                dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                // Com uma busca pelo link em andamento, o arquivo solto disputaria a prévia com ela.
                if (reading || fetchingLink) return;
                const dropped = event.dataTransfer.files[0];
                if (dropped) void load(dropped);
              }}
            >
              {reading ? (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="size-6 text-muted-foreground" />
              )}
              <span className="font-medium">
                {reading ? "Lendo o arquivo…" : "Solte o arquivo aqui ou clique para escolher"}
              </span>
              <span className="text-muted-foreground">.csv ou .xlsx</span>
              <input
                ref={input}
                type="file"
                accept={accept}
                className="sr-only"
                disabled={reading || fetchingLink}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (chosen) void load(chosen);
                }}
              />
            </label>

            {/* `noValidate`: a mensagem é a de `parseGoogleSheetLink`, não o balão do navegador. */}
            <form
              noValidate
              className="space-y-2 rounded-lg border p-3"
              onSubmit={(event) => void loadFromLink(event)}
            >
              <Label htmlFor="google-sheet-link" className="flex items-center gap-2">
                <Link2 className="size-4 text-muted-foreground" />
                Ou cole o link do Google Planilhas
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="google-sheet-link"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={link}
                  disabled={fetchingLink || reading}
                  aria-invalid={linkError ? true : undefined}
                  aria-describedby="google-sheet-link-help"
                  onChange={(event) => {
                    setLink(event.target.value);
                    setLinkError(null);
                  }}
                />
                <Button type="submit" variant="outline" disabled={fetchingLink || reading || link.trim() === ""}>
                  {fetchingLink ? <Loader2 className="size-4 animate-spin" /> : null}
                  {fetchingLink ? "Buscando…" : "Buscar planilha"}
                </Button>
              </div>
              <p id="google-sheet-link-help" className="text-xs text-muted-foreground">
                A planilha precisa estar compartilhada como "Qualquer pessoa com o link". Com a aba
                certa aberta, copie o endereço do navegador (ou use Compartilhar &gt; Copiar link
                para a primeira aba).
              </p>
              {linkError ? (
                <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {linkError}
                </p>
              ) : null}
            </form>

            {readError ? (
              <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {readError}
              </p>
            ) : null}

            {sheets.length > 1 && file ? (
              <SheetPicker
                sheets={sheets}
                value={sheet}
                onChange={(next) => void load(file, next)}
              />
            ) : null}

            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <Download className="size-4" />
              Baixar modelo de planilha
            </Button>
            <ColumnsReference />
          </div>
        ) : null}

        {table && plan && !finished ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <FileSpreadsheet className="size-4 text-muted-foreground" />
              <span className="font-medium break-all">{file?.name}</span>
              {sheets.length > 1 && file ? (
                <SheetPicker
                  sheets={sheets}
                  value={sheet}
                  disabled={running}
                  onChange={(next) => void load(file, next)}
                />
              ) : null}
            </div>

            <Counters
              items={[
                ["lidas", plan.counts.read],
                ["válidas", plan.counts.valid],
                ["duplicadas", plan.counts.duplicate],
                ["inválidas", plan.counts.invalid],
              ]}
            />

            {table.ignoredColumns.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Colunas ignoradas: {table.ignoredColumns.join(", ")}.
              </p>
            ) : null}

            {quota.data && quota.data.limit !== null ? (
              <p
                className={cn(
                  "rounded-lg p-3 text-sm",
                  overQuota ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-muted",
                )}
              >
                {overQuota
                  ? `Cabem ${nf.format(available ?? 0)} de ${nf.format(plan.counts.valid)} linhas: as primeiras entram, e as demais ficam de fora por causa do limite do plano (${nf.format(quota.data.limit)} clientes).`
                  : `Seu plano comporta mais ${nf.format(available ?? 0)} clientes (limite de ${nf.format(quota.data.limit)}).`}
              </p>
            ) : null}

            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Linha</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>E-mail</TableHead>
                    <TableHead>Etiquetas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.rows.slice(0, PREVIEW_ROWS).map((row) => {
                    const fields = customerFieldsFromRow(row);
                    return (
                      <TableRow key={row.sourceRow}>
                        <TableCell className="tabular-nums">{row.sourceRow}</TableCell>
                        <TableCell>{fields.name || "—"}</TableCell>
                        <TableCell>{displayPhone(row.phone) ?? "—"}</TableCell>
                        <TableCell>{row.email ?? "—"}</TableCell>
                        <TableCell>{row.tags.length > 0 ? row.tags.join(", ") : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Prévia das {Math.min(PREVIEW_ROWS, table.rows.length)} primeiras linhas.
            </p>

            {running ? (
              <div className="space-y-1">
                <div
                  role="progressbar"
                  aria-label="Progresso da importação"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                  className="h-2 overflow-hidden rounded bg-muted"
                >
                  <div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} />
                </div>
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {nf.format(run?.results.length ?? 0)} de {nf.format(plan.send.length)} linhas
                  enviadas…
                </p>
              </div>
            ) : null}

            <RejectedList rows={plan.rejected} />
          </div>
        ) : null}

        {finished && outcome && run ? (
          <div className="space-y-4">
            <Counters
              items={[
                ["importadas", outcome.counts.created],
                ["duplicadas", outcome.counts.duplicate],
                ["inválidas", outcome.counts.invalid],
                ["fora do limite", outcome.counts.limit],
              ]}
            />

            {run.stopped === "error" ? (
              <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {describeError(run.error)}
                {outcome.notSent > 0 ? ` ${nf.format(outcome.notSent)} linhas não foram enviadas.` : ""}
              </p>
            ) : null}
            {run.stopped === "canceled" ? (
              <p className="rounded-lg bg-muted p-3 text-sm">
                Importação cancelada. {nf.format(outcome.notSent)} linhas não foram enviadas; o que já
                entrou ficou.
              </p>
            ) : null}
            {outcome.counts.limit > 0 ? (
              <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                O limite de clientes do plano foi atingido. As {nf.format(outcome.counts.limit)} linhas
                de fora não foram ignoradas: mude de plano e importe o arquivo de novo (quem já
                entrou é pulado).
              </p>
            ) : null}
            {outcome.teamLinked > 0 ? (
              <p className="text-sm text-muted-foreground">
                {nf.format(outcome.teamLinked)} {outcome.teamLinked === 1 ? "ficha foi ligada" : "fichas foram ligadas"}{" "}
                a quem é da equipe e tem esse telefone confirmado.
              </p>
            ) : null}
            {run.tags.created > 0 ? (
              <p className="text-sm text-muted-foreground">
                {nf.format(run.tags.created)}{" "}
                {run.tags.created === 1 ? "etiqueta nova criada" : "etiquetas novas criadas"}.
              </p>
            ) : null}
            {run.tags.ignored > 0 ? (
              <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                {run.tags.ignoredReason === "no_permission"
                  ? `${nf.format(run.tags.ignored)} ${run.tags.ignored === 1 ? "etiqueta do arquivo não existe e foi ignorada" : "etiquetas do arquivo não existem e foram ignoradas"}: só quem gerencia etiquetas cria etiquetas novas.`
                  : `${nf.format(run.tags.ignored)} ${run.tags.ignored === 1 ? "etiqueta nova foi ignorada" : "etiquetas novas foram ignoradas"}: a organização já está no limite de etiquetas.`}
              </p>
            ) : null}

            <RejectedList rows={outcome.rejected} />
          </div>
        ) : null}

        <DialogFooter>
          {finished ? (
            <>
              <Button variant="outline" onClick={reset}>
                Importar outro arquivo
              </Button>
              <Button onClick={onClose}>Fechar</Button>
            </>
          ) : running ? (
            <Button variant="outline" onClick={() => (cancel.current = true)}>
              Cancelar
            </Button>
          ) : (
            <>
              {table ? (
                <Button variant="outline" onClick={reset}>
                  Trocar arquivo
                </Button>
              ) : (
                <Button variant="outline" onClick={onClose}>
                  Fechar
                </Button>
              )}
              {table && plan ? (
                <Button disabled={plan.send.length === 0} onClick={() => void start()}>
                  {plan.send.length === 0
                    ? "Nenhuma linha para importar"
                    : `Importar ${nf.format(plan.send.length)} ${plan.send.length === 1 ? "cliente" : "clientes"}`}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SheetPicker({
  sheets,
  value,
  disabled,
  onChange,
}: {
  sheets: string[];
  value: string | undefined;
  disabled?: boolean;
  onChange: (sheet: string) => void;
}) {
  const items = sheets.map((name) => ({ value: name, label: name }));

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Aba</span>
      <Select
        items={items}
        value={value ?? sheets[0]}
        disabled={disabled}
        onValueChange={(next) => next && onChange(next)}
      >
        <SelectTrigger aria-label="Aba da planilha" className="min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
