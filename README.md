# NoWorryPark

Reserva automáticamente el parqueo en Parso (Plaza Roble, fallback RCC Roble) los
**lunes y miércoles a las 5:56am hora de Costa Rica**, para el día que cae 7 días
después. Notifica el resultado por Telegram. Corre en Cloudflare Workers, sin
depender de ninguna compu prendida.

**Cuentas usadas:**
- Cloudflare: `clavitooo.01@gmail.com`
- GitHub: `pablo.alvarado.umana@est.una.ac.cr`

## Cómo se desplegó

1. Repo en GitHub con este código (TypeScript + `wrangler.toml`).
2. Cloudflare API Token creado en esa cuenta (My Profile → API Tokens, plantilla
   "Edit Cloudflare Workers") + Account ID (dashboard → Workers & Pages).
3. Esos dos, como secrets del repo en GitHub (Settings → Secrets and variables →
   Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. Secretos propios del bot guardados directo en Cloudflare (no en GitHub, no en el
   repo): `npx wrangler secret put NOMBRE`, uno por uno:
   `PARSO_EMAIL`, `PARSO_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `MANUAL_TRIGGER_KEY`.
5. Cada `git push` a `main` dispara `.github/workflows/deploy.yml`, que hace
   `wrangler deploy` solo.

Para redeployar manualmente desde tu compu: `npx wrangler login` → `npx wrangler deploy`.

## Cambiar placa, horario, parqueos, etc.

Todo vive en `wrangler.toml` → `[vars]`, sin tocar código:

| Variable | Qué es |
|---|---|
| `PARSO_PLATE` | Placa a usar |
| `PARSO_REASON` | Motivo de la reserva |
| `PARSO_ENTRY_TIME` | Hora de entrada, `HH:MM` |
| `PARSO_LOT_PRIORITY` | IDs de parqueo en orden de preferencia (`1`=Plaza Roble, `80`=RCC Roble) |
| `PARSO_DAYS_AHEAD` | Días hacia adelante que se habilitan hoy (7) |
| `PARSO_MAX_ATTEMPTS` / `PARSO_RETRY_DELAY_SECONDS` | Rondas de reintento (1 = sin reintentos) |
| `[triggers] crons` | Horario del cron, en UTC (CR no tiene horario de verano, siempre UTC-6) |

Después de editar, hacé commit + push — el deploy es automático.

## Probar manualmente

⚠️ Hace una reserva **real** contra tu cuenta — no lo corras el mismo día en que ya
corrió el cron automático, o vas a recibir dos notificaciones (no es un bug).

- **Desde GitHub** (sin terminal): pestaña Actions → "Disparar NoWorryPark
  manualmente" → Run workflow. Requiere los secrets `NOWORRYPARK_URL` (la URL de
  `wrangler deploy`, sin `/` al final) y `MANUAL_TRIGGER_KEY` (mismo valor que el de
  Cloudflare) agregados en el repo.
- **Desde tu terminal**: `curl "https://noworrypark.<subdominio>.workers.dev/trigger?key=TU_CLAVE"`
- **Logs en vivo**: `npx wrangler tail`

## Notas

- Plan gratuito de Cloudflare: límite de 50 sub-requests por invocación; el loop de
  reintentos es liviano en CPU (mayormente espera de red), pero revisá los límites
  vigentes si subís mucho `PARSO_MAX_ATTEMPTS`.
- Si Parso cambia su API, el bot lo va a notificar por Telegram como error en vez de
  fallar en silencio.