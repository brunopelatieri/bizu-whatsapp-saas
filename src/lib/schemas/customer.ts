import { z } from "zod";
import { tagFilterSchema, tagIdsSchema } from "@/lib/schemas/crm";
import { phoneSchema } from "@/lib/schemas/phone";
import { customerStatuses } from "@/lib/tenant/customer-constants";

/** Contratos de `/api/customers/*` e dos formulários de `/app/clientes`. */

export const CUSTOMER_PAGE_SIZE = 20;

export { phoneSchema };

/** Texto opcional: vazio vira `null`, ausente segue ausente (o PATCH não mexe). */
export const optionalText = (schema: z.ZodType<string, string>) =>
  schema
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

/** E-mail opcional do cliente: vazio vira `null`. Sem e-mail não há conta nem acesso. */
const optionalEmail = optionalText(
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "E-mail muito longo.")
    .refine((value) => value === "" || z.email().safeParse(value).success, "Informe um e-mail válido."),
);

// Sem `.default()`: em `partial()` ele preencheria o que o PATCH não mandou. O telefone é
// obrigatório (`phoneSchema`); o `PATCH partial()` pode omiti-lo, mas nunca apagá-lo.
export const customerSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome.").max(120, "Nome muito longo."),
  email: optionalEmail,
  phone: phoneSchema,
  document: optionalText(z.string().trim().max(30, "Documento muito longo.")),
  status: z.enum(customerStatuses).optional(),
  /** Substitui o conjunto de etiquetas do cliente. */
  tagIds: tagIdsSchema.optional(),
  notes: optionalText(z.string().trim().max(2000, "Observação muito longa.")),
});
export type CustomerInput = z.infer<typeof customerSchema>;
export type CustomerFormValues = z.input<typeof customerSchema>;

export const updateCustomerSchema = customerSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nada para alterar.",
  });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(customerStatuses).optional(),
  /** `tags=<id>,<id>`: clientes com qualquer uma delas. */
  tags: tagFilterSchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
export type CustomersQuery = z.infer<typeof customersQuerySchema>;
