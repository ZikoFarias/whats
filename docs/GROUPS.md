# Módulo de grupos

Tudo fica em **Dashboard → Groups**, na API `/api/groups/{sessionId}/...` e nas ferramentas MCP de grupos.

Depois de atualizar, rode `npm run db:push`: o módulo cria tabelas novas.

## Abas do painel

| Aba | O que faz |
|---|---|
| **Grupos** | Lista com busca, tags, filtro "sou admin", ordenação por tamanho/atividade. Selecione vários para enviar, marcar tag ou remover uma pessoa de todos. Clique num grupo para ver detalhes, membros (ativos, saíram, mais ativos), pedidos de entrada, envio individual e analytics. |
| **Disparos** | Envio para os selecionados, para todos ou por tag. Aceita mídia, menção a todos, agendamento e sequência de várias mensagens com horários diferentes. Usa a mesma fila de campanhas do broadcast (pausar, retomar, cancelar). |
| **Automações** | Regras "quando → então". Gatilhos: entrada, saída, mensagem (contém, regex, link, convite, flood), horário (cron). Ações: enviar, responder, apagar, advertir (remove ao atingir o máximo), remover, fechar/abrir o grupo, avisar sistema externo (webhook `group.automation`). Há modelos prontos: boas-vindas, anti-link, anti-flood, palavrões, fechar à noite, alerta de lead. |
| **Links inteligentes** | Um link `/g/endereço` que leva cada pessoa ao próximo grupo com vaga e cria um grupo novo quando todos lotam. Mostra cliques por grupo e por origem (`?utm_source=`). |
| **Analytics** | Comparativo entre grupos: membros, crescimento, mensagens, e os melhores horários para postar. |

## Variáveis nas mensagens de automação

`{{nome}}` `{{mencao}}` `{{grupo}}` `{{membros}}` `{{advertencias}}` `{{max}}` `{{data}}` `{{hora}}`

## Principais endpoints

```
GET    /api/groups/{s}?view=summary            lista com tags, papel, atividade
POST   /api/groups/{s}/sync                     ressincroniza com o WhatsApp
POST   /api/groups/{s}/broadcast                disparo/sequência para grupos
POST   /api/groups/{s}/{jid}/send               mensagem para um grupo
GET    /api/groups/{s}/{jid}/info               detalhes + membros
PATCH  /api/groups/{s}/{jid}/info               tags e notas internas
POST   /api/groups/{s}/{jid}/manage             configurações e membros
GET/POST /api/groups/{s}/{jid}/requests         pedidos de entrada
POST   /api/groups/{s}/bulk-members             adicionar/remover em vários grupos
GET/POST /api/groups/{s}/automations            regras
GET/POST /api/groups/{s}/links                  links inteligentes
GET    /api/groups/{s}/analytics                comparativo
GET    /api/groups/{s}/{jid}/analytics          analytics de um grupo
```

## Webhooks novos

`group.joined`, `group.join_request` e `group.automation` (disparado pela ação "avisar sistema").

## Observações

- Disparos para grupos não sofrem o bloqueio 463 de "novas conversas" e, por padrão, ignoram a janela de horário comercial.
- Mudar configurações, membros, pedidos ou links exige que o número seja admin do grupo.
- O primeiro sync não gera eventos de "entrou"; o histórico de entradas e saídas começa a partir dele.
