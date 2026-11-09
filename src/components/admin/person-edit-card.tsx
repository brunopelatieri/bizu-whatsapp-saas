import { type ReactNode, useState } from "react";
import { useAdminMutation } from "@/components/admin/admin-api";
import { Field } from "@/components/admin/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PhoneField, toPhoneFieldValue } from "@/components/ui/phone-field";
import { updateUserSchema } from "@/lib/schemas/admin";

/**
 * Nome, e-mail e telefone de uma pessoa (equipe ou portal). O telefone é obrigatório e se troca, nunca se apaga. Só manda o que mudou; o mesmo schema da API
 * valida aqui. `emailWarning` diz o que a troca de e-mail faz com o acesso.
 */
export function PersonEditCard({
  path,
  person,
  emailWarning,
}: {
  path: string;
  person: { name: string; email: string; phoneNormalized: string | null };
  emailWarning: ReactNode;
}) {
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email);
  const initialPhone = toPhoneFieldValue(person.phoneNormalized);
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | null>(null);
  const save = useAdminMutation("Dados salvos.");
  const emailChanged = email.trim().toLowerCase() !== person.email;

  function submit() {
    const parsed = updateUserSchema.safeParse({
      ...(name.trim() !== person.name ? { name } : {}),
      ...(emailChanged ? { email } : {}),
      ...(phone !== initialPhone ? { phone } : {}),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Confira os campos.");
      return;
    }

    setError(null);
    save.mutate({ path, method: "PATCH", body: parsed.data });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Editar</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label="Nome">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="E-mail">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                maxLength={254}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field label="Telefone / WhatsApp">
            {(id) => <PhoneField id={id} value={phone} onChange={setPhone} />}
          </Field>
          {emailChanged ? (
            <p className="text-xs text-amber-700 dark:text-amber-400 sm:col-span-2">
              {emailWarning}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              Salvar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
