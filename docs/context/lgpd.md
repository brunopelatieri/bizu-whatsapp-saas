# LGPD: retenção, base legal e encarregado

- **Escopo:** Quanto tempo cada dado é guardado, por quê, quem apaga e como o titular exerce os direitos.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-seguranca.md` (seção LGPD)
- **Paths do código:** `src/jobs/maintenance.ts`, `src/lib/lgpd/`, `src/lib/legal/`, `src/lib/billing/settings.ts`

Mecânica (consentimento, exportação, exclusão, arquivos): `tech/27-lgpd-arquivos.md`. Este arquivo é só a política.

## Tabela de retenção

| Dado | Onde | Prazo | Quem apaga | Base legal |
|---|---|---|---|---|
| Sessões (equipe e portal) | `session`, `portal_session` | até expirar (7 dias) | `maintenance.prune` | Execução de contrato (manter o login) |
| Tokens de verificação e reset | `verification`, `portal_verification` | até expirar | `maintenance.prune` | Execução de contrato |
| Eventos de pagamento já tratados | `payment_event` | 90 dias | `maintenance.prune` (`processed`, `ignored`, `duplicate`) | Execução de contrato; o pendente ou falho fica para reprocessar |
| Avisos de canal de WhatsApp já tratados | `channel_event` | 30 dias | `maintenance.prune` (`processed`, `ignored`, `failed`) | Execução de contrato; o `raw` tem telefone, nome e texto de mensagem e só existe para reprocessar; o pendente fica; apagar o canal ou a organização o apaga em cascata |
| Registro de e-mail enviado | `email_message` | 180 dias | `maintenance.prune` | Legítimo interesse (diagnóstico de entrega); só hash do destinatário, nunca o corpo |
| Auditoria | `audit_log` | `platform_setting.audit_retention_days` (padrão **365**, mínimo 30) | `maintenance.prune` | Legítimo interesse (segurança e suporte); só ids e enums, sem texto livre |
| Exportação de dados | `data_export` e o zip no armazenamento | **7 dias** (arquivo) e mais 7 (registro) | `maintenance.prune` | Atender o titular |
| Buckets de rate limit | `rate_limit_bucket` | 1 dia | `maintenance.prune` | Legítimo interesse (segurança) |
| Faturas | `invoice` | **5 anos**, fixo (sem configuração nem job), anonimizadas se a organização for excluída | não há job: guarda por obrigação fiscal | Obrigação legal |
| Prova de consentimento | `consent_log` | enquanto durar a relação e o prazo de defesa; sem nome nem e-mail (só id e hash de IP) | não é apagado pela exclusão | Exercício regular de direitos |
| Pedido de exclusão e de exportação | `deletion_request`, `data_export` | `deletion_request` fica como registro da execução | — | Prestação de contas |
| Conta de equipe, do portal e organização (inclui o **telefone**, obrigatório, e o e-mail, opcional no cliente) | `user`, `portal_user`, `customer`, `organization` ... | até o pedido de exclusão + 30 dias de carência | job `lgpd.delete` (anonimiza) | Execução de contrato; depois, direito do titular |
| Anotação da plataforma sobre a organização (etiquetas e campos, `crm-cadastro` A4) | `organization_tag`, `organization_profile` | até a exclusão da organização | apagada em `anonymizeTenant` (`lgpd.delete`); **fora da exportação do owner**, que nunca a vê (é dado da plataforma, não do titular; texto livre de campo pode citar pessoas, daí a limpeza) | Legítimo interesse (gestão da base de clientes da plataforma) |
| Arquivos do tenant | `file` e armazenamento | até o tenant apagar ou a organização ser excluída | tenant / `lgpd.delete` | Execução de contrato |
| Logs da aplicação | stdout (JSON) | definido por quem opera (Docker, Loki, ...) | operação | Legítimo interesse; sem dado pessoal (redact) |
| Backups | volume `backups` | `BACKUP_KEEP_DAYS` (padrão 14) | `backup.sh` | Legítimo interesse (continuidade); cifrados com `age` |

Observações:

- **Backup e exclusão:** um backup antigo ainda contém quem foi anonimizado depois. É aceitável porque o prazo é curto, o arquivo é cifrado e quem restaura precisa **reaplicar as exclusões** executadas desde o backup (consulte `deletion_request` com `status = 'executed'` e rode `executeDeletion` ou o job). Documentado em `tech/14-deploy.md`.
- **Logs:** nenhuma linha leva cookie, e-mail, documento, senha nem token (`src/lib/logger.ts`). O prazo de retenção dos logs é da infraestrutura (rotação do Docker ou do coletor).
- Mudar um prazo é mudar o código ou a configuração **e esta tabela**, no mesmo trabalho. O texto de `src/lib/legal/privacidade.md` repete os prazos para o titular: mantenha os dois iguais e suba `LEGAL_VERSIONS` se o texto mudar de sentido.

## Direitos do titular e canais

| Direito (LGPD, art. 18) | Como |
|---|---|
| Confirmação e acesso | `/app/configuracoes/privacidade` (equipe) e `/portal/conta` (cliente): exportação em zip, link por e-mail |
| Correção | Perfil em `/app/configuracoes`, `/portal/conta` |
| Eliminação | Excluir a conta, com 30 dias de carência (`DELETE /api/me`, `DELETE /api/portal/me`); o proprietário pode excluir a organização (`DELETE /api/tenant`) |
| Revogação do consentimento | Marketing: `/app/configuracoes/privacidade`; termos: encerrando a conta |
| Portabilidade | O zip da exportação é JSON |
| Outros pedidos e dúvidas | Encarregado (DPO), pelo e-mail em `platform_setting.dpo_email` |

## Encarregado (DPO)

- O e-mail do encarregado é `platform_setting.dpo_email`, editado por `platform_owner` em `/admin/configuracoes`. Aparece nas páginas `/legal/termos` e `/legal/privacidade`. Vazio, as páginas mostram "[e-mail do encarregado ainda não informado]": **preencha antes de ir ao ar**.
- O controlador (razão social, CNPJ, endereço) é texto de `src/lib/legal/termos.md` e `privacidade.md`, entre colchetes. Os dois textos são modelos: peça revisão jurídica.

## Quando o template vira produto

1. Preencher controlador e encarregado; revisar os textos com um advogado.
2. Conferir esta tabela contra o que o produto realmente guarda (o telefone é dado pessoal obrigatório: a anonimização zera `phone`, `phone_normalized` e `phone_key`, e nunca vai para log nem auditoria; campos novos em `customer` (os campos adicionais, `customer.custom_fields`, são exportados com rótulo e valor e zerados na anonimização), novas tabelas com dado pessoal entram na exportação e na anonimização: `src/lib/lgpd/export.ts` e `deletion.ts`).
3. Configurar o backup cifrado e testar a restauração (`tech/14-deploy.md`).
