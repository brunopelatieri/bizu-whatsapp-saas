import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  type Customer,
  useCustomerMutation,
} from "@/components/app/customers/customers-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PhoneField, toPhoneFieldValue } from "@/components/ui/phone-field";
import { Textarea } from "@/components/ui/textarea";
import { customerSchema } from "@/lib/schemas/customer";
import { TagPicker } from "@/components/crm/tag-picker";
import { ApiError } from "@/lib/api/client";

/** As etiquetas do cliente são ids, escolhidos no `TagPicker`. */
const formSchema = customerSchema.omit({ status: true, tagIds: true }).extend({
  tagIds: z.array(z.string()),
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

function toFormValues(customer?: Customer): FormInput {
  return {
    name: customer?.name ?? "",
    email: customer?.email ?? "",
    phone: toPhoneFieldValue(customer?.phoneNormalized),
    document: customer?.document ?? "",
    notes: customer?.notes ?? "",
    tagIds: customer?.tags.map(({ id }) => id) ?? [],
  };
}

type CustomerFormDialogProps = {
  open: boolean;
  /** Sem cliente, cria um novo. */
  customer?: Customer;
  onClose: () => void;
};

export function CustomerFormDialog({
  open,
  customer,
  onClose,
}: CustomerFormDialogProps) {
  const save = useCustomerMutation(
    customer ? "Cliente atualizado." : "Cliente cadastrado.",
  );
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(customer),
    mode: "onChange",
  });
  const { reset } = form;

  useEffect(() => {
    if (open) reset(toFormValues(customer));
  }, [open, customer, reset]);

  async function onSubmit(values: FormOutput) {
    await save
      .mutateAsync({
        path: customer ? `/api/customers/${customer.id}` : "/api/customers",
        method: customer ? "PATCH" : "POST",
        body: values,
      })
      .then(onClose)
      .catch((error: unknown) => {
        // Número de outro cliente: o erro vai para o campo, onde a pessoa corrige.
        if (error instanceof ApiError && error.code === "PHONE_IN_USE") {
          form.setError("phone", { message: error.message });
        }
      });
  }

  const emailChanging =
    customer?.hasPortalAccess && (form.watch("email") ?? "") !== (customer.email ?? "");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{customer ? "Editar cliente" : "Novo cliente"}</DialogTitle>
          <DialogDescription>
            Nome e telefone são obrigatórios. O e-mail é opcional, mas só quem tem e-mail pode receber acesso ao portal.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>E-mail</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} type="email" autoComplete="off" />
                  </FormControl>
                  {emailChanging ? (
                    <p className="text-xs text-muted-foreground">
                      Trocar o e-mail corta o acesso ao portal até um novo envio.
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Telefone / WhatsApp *</FormLabel>
                    <FormControl>
                      <PhoneField
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="document"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Documento</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="tagIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Etiquetas</FormLabel>
                  <FormControl>
                    <TagPicker value={field.value ?? []} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Observações</FormLabel>
                  <FormControl>
                    <Textarea {...field} value={field.value ?? ""} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting || !form.formState.isValid}
              >
                Salvar
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
