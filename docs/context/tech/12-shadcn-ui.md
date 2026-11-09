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
- `popover`
- `command`

---

