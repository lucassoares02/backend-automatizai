# Prospector de leads de delivery — AutomatizAI

Script que varre o Google Maps (**Places API New**) por comerciantes de delivery de
alimentos perto de **Morada de Laranjeiras (Serra-ES)**, enriquece cada lead e gera um
**CSV** pronto para prospecção.

## O que o CSV traz

| Coluna | Origem |
|---|---|
| Nome, Categoria, Endereço, Telefone, Site, Nota, Nº avaliações | Google Places |
| Delivery | Flag oficial do Google (`delivery`) |
| WhatsApp (provável) | Heurística: celular BR (DDD + 9XXXXXXXX) |
| WhatsApp (verificado) | Só com `--verify-whatsapp` (Evolution API) |
| Tem iFood | Detectado pela URL do site (`sim` / `não detectado` / `desconhecido`) |
| Plataforma de pedido | iFood, Goomer, Anota AI, CardápioWeb, Aiqfome... (pela URL) |
| Cardápio online | `sim` / `talvez` / `não` |
| Distância (km) | Haversine a partir do centro |
| **Score** e **Por que é lead** | Priorização automática (ver abaixo) |

## Pré-requisito: habilitar a Places API (New)

A chave `GOOGLE_MAPS_API_KEY` (já no `.env`) precisa ter a **Places API (New)** habilitada:

1. [Google Cloud Console](https://console.cloud.google.com/) → seu projeto
2. **APIs & Services → Library** → busque **"Places API (New)"** → **Enable**
3. Garanta que o **billing** está ativo (há crédito grátis mensal; nesse volume o custo é baixo).
4. Se a chave tiver restrição de API, adicione a *Places API (New)* na lista permitida.

> Se aparecer erro `403`, quase sempre é a API não habilitada ou restrição de chave.

## Como rodar

A partir da pasta `api/`:

```bash
node tools/prospector.js                     # padrão: Morada de Laranjeiras, raio 8km
node tools/prospector.js --raio=10           # amplia o raio (máx 50km)
node tools/prospector.js --limite=200        # limita nº de leads no CSV
node tools/prospector.js --lat=-20.17 --lng=-40.25 --raio=6
node tools/prospector.js --out=./tools/leads.csv
node tools/prospector.js --verify-whatsapp   # valida WhatsApp de verdade (ver abaixo)
```

O CSV sai por padrão em `api/tools/leads-serra-AAAA-MM-DD.csv` (com BOM, abre certinho no Excel).

## Verificação real de WhatsApp (opcional)

Com `--verify-whatsapp` o script confirma cada número na **Evolution API** de vocês
(`/chat/whatsappNumbers/{instance}`). Requer no `.env`:

```
EVOLUTION_API_URL=...
TOKEN_EVOLUTION=...        # ou API_KEY_EVOLUTION
EVOLUTION_INSTANCE=nome-da-instancia   # <-- precisa adicionar
```

> ⚠️ Checar muitos números de uma vez pode sinalizar a conta de WhatsApp. O script já
> faz em lotes de 20 com pausa, mas use com moderação. Sem a flag, o CSV usa só a
> heurística (bem confiável para celulares).

## Como o Score prioriza os leads

Melhor lead p/ AutomatizAI = faz delivery, atende no WhatsApp e **ainda não tem canal
próprio de pedidos** (ou depende só do iFood):

| Sinal | Peso |
|---|---|
| Atende no WhatsApp | +3 |
| Faz delivery (flag Google) | +2 |
| Sem plataforma própria de pedidos | +2 |
| Depende do iFood (pitch: reduzir comissão) | +1 |
| Só divulga em Instagram/Linktree | +1 |
| Negócio ativo (≥30 avaliações) | +1 |
| Já usa plataforma própria (Goomer/Anota AI...) | −2 |
| Pouca presença (<5 avaliações) | −1 |

A coluna **"Por que é lead"** explica o motivo em texto pra facilitar a abordagem.

## Limitações honestas

- **iFood/cardápio** são inferidos pela URL do site do estabelecimento. Se o comércio
  está no iFood mas não linka no Google, virá como `não detectado`. Dá pra evoluir depois
  com uma consulta ativa ao marketplace do iFood.
- `locationBias` do Google é uma preferência, não um filtro rígido; por isso o script
  corta por distância real (haversine) ao raio informado.
