# shadcn/ui

- **Escopo:** Configuração, componentes presentes e recomendados.
- **Specs relacionadas:** nenhuma citada
- **Paths do código:** `src/index.css`


## 12. shadcn/ui

Config: `components.json`

Detalhes:

- Style: `base-nova`.
- CSS: `src/index.css`.
- Base color: `neutral`.
- CSS variables habilitadas.
- Alias:
  - `@/components`
  - `@/components/ui`
  - `@/lib`
  - `@/lib/utils`
  - `@/hooks`
- Icon library: `lucide`.

Componente de formulário próprio: `phone-field.tsx` (`PhoneField`), campo de telefone com seletor
de país e máscara (`react-phone-number-input/min`), usado em todo formulário de pessoa; o valor que
sobe é o E.164 com `+` e quem valida é `phoneSchema` (`tech/28-crm-cadastro.md`).

Outro componente próprio: `components/auth/password-strength-meter.tsx` (`PasswordStrengthMeter`),
barra e checklist da política de senha, com tokens do tema (`bg-muted`, `text-chart-2` para regra
cumprida, `text-destructive`, `text-muted-foreground`); onde é usado está em `tech/08-auth.md`.

Componentes UI presentes:

- `avatar`
- `badge`
- `button`
- `card`
- `dialog`
- `dropdown-menu`
- `form`
- `input`
- `label`
- `popover`
- `select`
- `separator`
- `sheet`
- `skeleton`
- `table`
- `tabs`
- `textarea`
- `tooltip`
- `sonner`

Componentes recomendados para proximas etapas:

- `checkbox`
- `command`

`popover.tsx` (X3) é o `Popover` do Base UI no padrão dos outros (`Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverTitle`,
`PopoverDescription`): `PopoverContent` leva `side`, `align` e as props do `Popup` (`initialFocus`, `finalFocus`). Fecha com Escape e clicando fora.
O primeiro uso é o seletor de emoji do atendimento (`src/components/inbox/emoji-button.tsx`, `tech/30-caixa-de-entrada.md`).

---

