# NoWorryPark

Reserva automáticamente el parqueo en Parso (Plaza Roble, con fallback a RCC Roble) los
**lunes y miércoles a las 5:56am hora de Costa Rica**, apenas se habilita el día que cae
7 días después. Si logra reservar (o si falla del todo), te avisa por Telegram.

Por defecto prueba **una sola vez** cada parqueo de la lista (sin rondas de reintento) —
ajustable con `PARSO_MAX_ATTEMPTS` si más adelante querés que insista.

Corre en **Cloudflare Workers** (capa gratuita), no depende de que tu compu esté prendida.

## Cómo funciona

1. Se loguea contra la API de Parso (`/api/auth/sign_in`) y obtiene los tokens de sesión.
2. Busca el `vehicle_id` que corresponde a tu placa.
3. Intenta reservar en el primer parqueo de la lista de prioridad; si no consigue cupo
   confirmado, prueba el siguiente, y repite varias rondas con una pequeña pausa entre cada una.
4. Después de cada intento consulta `/api/reservations` para confirmar el estado real
   (la reserva es asíncrona: un `success: true` inicial no garantiza que quede aprobada).
5. Te manda un mensaje de Telegram con el resultado.

## Configuración (todo es parámetro, nada hardcodeado en la lógica)

Editá `wrangler.toml` → `[vars]` para ajustar sin tocar código:

| Variable | Qué es |
|---|---|
| `PARSO_PLATE` | Placa a usar (debe existir en tu cuenta de Parso) |
| `PARSO_REASON` | Motivo de la reserva |
| `PARSO_ENTRY_TIME` | Hora de entrada deseada, formato `HH:MM` |
| `PARSO_LOT_PRIORITY` | IDs de parqueo en orden de preferencia, ej. `"1,80"` (1 = Plaza Roble, 80 = RCC Roble) |
| `PARSO_DAYS_AHEAD` | Días hacia adelante que se habilitan hoy (7 en tu caso) |
| `PARSO_MAX_ATTEMPTS` / `PARSO_RETRY_DELAY_SECONDS` | Cuántas rondas de reintento y la espera entre cada una |

El cron (`[triggers]` en `wrangler.toml`) ya está puesto en `"56 11 * * 1,3"` =
lunes y miércoles 11:56 UTC = **5:56am Costa Rica** (CR no cambia de horario en el año,
así que este cron no se desajusta nunca).

## Setup inicial

```bash
npm install
npx wrangler login          # abre el navegador para autorizar tu cuenta Cloudflare
```

Guardá los datos sensibles como secretos (nunca van al repo):

```bash
npx wrangler secret put PARSO_EMAIL
npx wrangler secret put PARSO_PASSWORD
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put MANUAL_TRIGGER_KEY   # inventate una clave larga, es para probar manualmente
```

### Crear el bot de Telegram

1. Hablá con **@BotFather** en Telegram → `/newbot` → te da el `TELEGRAM_BOT_TOKEN`.
2. Mandale un mensaje cualquiera a tu bot nuevo (para "activar" el chat).
3. Conseguí tu `TELEGRAM_CHAT_ID` con:
   ```bash
   curl "https://api.telegram.org/bot<TU_TOKEN>/getUpdates"
   ```
   Buscá `"chat":{"id": ...}` en la respuesta — ese número es tu `TELEGRAM_CHAT_ID`.

## Probarlo ANTES de dejarlo automático

⚠️ Esto hace reservas **reales** contra tu cuenta. Probalo en un día que no te importe
perder o cambiar esa reserva después, no en el momento crítico.

Local (simula el cron sin desplegar):
```bash
npm run dev -- --test-scheduled
# en otra terminal:
curl "http://localhost:8787/__scheduled"
```

O ya desplegado, usando el endpoint manual protegido:
```bash
npx wrangler deploy
curl "https://noworrypark.<tu-subdominio>.workers.dev/trigger?key=TU_MANUAL_TRIGGER_KEY"
```

Mirá los logs en vivo con:
```bash
npx wrangler tail
```

## Deploy automático desde GitHub

El workflow en `.github/workflows/deploy.yml` despliega solo con cada push a `main`.
En tu repo de GitHub, agregá estos secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — creá uno en Cloudflare dashboard → My Profile → API Tokens
  (plantilla "Edit Cloudflare Workers" alcanza).
- `CLOUDFLARE_ACCOUNT_ID` — lo ves en el dashboard de Cloudflare, barra lateral derecha.

Los secretos del propio Worker (`PARSO_EMAIL`, etc.) se configuran una sola vez con
`wrangler secret put` como arriba — **no** hace falta repetirlos en cada deploy, quedan
guardados en Cloudflare.

## Notas / límites a tener en cuenta

- El plan gratuito de Cloudflare Workers tiene un límite de sub-requests por invocación
  (50) y de tiempo de CPU — el loop de reintentos aquí es liviano en CPU (la mayoría es
  espera de red), pero si en el futuro subís mucho `PARSO_MAX_ATTEMPTS` revisá los límites
  vigentes en la documentación de Cloudflare.
- Si Parso cambia su API (endpoints, headers) el bot se rompe silenciosamente salvo por
  la notificación de error a Telegram — por eso el bloque `catch` te avisa igual si algo
  falla, en vez de quedarse callado.
