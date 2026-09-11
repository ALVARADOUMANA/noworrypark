import {
  Env,
  login,
  getVehicleId,
  targetDateStr,
  lotPriorityList,
  lotLabel,
  attemptReservation,
  findReservation,
  sleep,
} from "./parso";
import { notifyTelegram } from "./telegram";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_CHECK_CRON = "51 11 * * *";
const ROUTINE_CRON = "51 11 * * MON,WED";

function pendingKey(dateStr: string): string {
  return `pending:${dateStr}`;
}

async function runReservationFlow(env: Env, dateOverride?: string): Promise<void> {
  const dateStr = dateOverride ?? targetDateStr(env);
  const lots = lotPriorityList(env);
  const confirmPollAttempts = Number(env.PARSO_CONFIRM_POLL_ATTEMPTS);
  const confirmPollDelayMs = Number(env.PARSO_CONFIRM_POLL_DELAY_SECONDS) * 1000;

  try {
    const auth = await login(env);
    const vehicleId = await getVehicleId(env, auth);

    const attemptsLog: string[] = [];
    let finalStatus: "APPROVED" | "PENDING" | null = null;
    let finalLabel: string | null = null;

    for (const lotId of lots) {
      const label = lotLabel(env, lotId);
      const result = await attemptReservation(env, auth, lotId, vehicleId, dateStr);

      if (!result.success) {
        attemptsLog.push(
          `${label} · rechazado de inmediato${result.messages.length ? `: ${result.messages.join("; ")}` : " (sin espacio disponible o error)"}`
        );
        continue; // este lote no sirvió, probamos el siguiente
      }

      attemptsLog.push(`${label} · aceptado por la API, esperando confirmación...`);

      // Una vez que un lote fue aceptado, NO tocamos otro lote hasta saber con
      // certeza qué pasó — evita el bug de reservar dos lotes a la vez.
      let confirmed: Awaited<ReturnType<typeof findReservation>> = null;
      for (let i = 0; i < confirmPollAttempts; i++) {
        await sleep(confirmPollDelayMs);
        confirmed = await findReservation(env, auth, dateStr);
        if (confirmed && confirmed.status !== "PENDING") break;
      }

      if (confirmed && confirmed.status === "APPROVED") {
        attemptsLog.push(`${label} · confirmado como APPROVED`);
        finalStatus = "APPROVED";
        finalLabel = label;
        break; // listo, no se toca el siguiente lote
      }

      if (confirmed && confirmed.status === "REJECTED") {
        attemptsLog.push(`${label} · terminó rechazado tras confirmar`);
        continue; // este sí quedó descartado de verdad, ahora sí probamos el siguiente
      }

      // Se acabó el tiempo de espera y sigue sin resolver: nos detenemos acá.
      // No probamos el siguiente lote para no arriesgarnos a reservar doble.
      attemptsLog.push(`${label} · sigue sin confirmarse después de esperar`);
      finalStatus = "PENDING";
      finalLabel = label;
      break;
    }

    if (finalStatus === "APPROVED") {
      await notifyTelegram(
        env,
        `✅ <b>Parqueo reservado</b>\n` +
          `Día: ${dateStr}\n` +
          `Lote: ${finalLabel}\n` +
          `Placa: ${env.PARSO_PLATE}`
      );
    } else if (finalStatus === "PENDING") {
      await notifyTelegram(
        env,
        `⏳ <b>Quedó pendiente de confirmar</b>\n` +
          `Día: ${dateStr}\n` +
          `Lote: ${finalLabel}\n` +
          `La API lo aceptó pero no se confirmó a tiempo. Revisá la app para ver si se concretó ` +
          `antes de asumir que falló (no se intentó otro lote para no duplicar).`
      );
    } else {
      const lotNames = lots.map((id) => lotLabel(env, id)).join(", ");
      await notifyTelegram(
        env,
        `❌ <b>No se logró reservar parqueo</b> para el ${dateStr}.\n` +
          `Se intentó en: ${lotNames}, todos rechazados.\n` +
          `Probablemente ya no había cupo. Revisá la app manualmente.\n\n` +
          `Detalle:\n${attemptsLog.join("\n")}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error en el flujo de reserva:", message);
    await notifyTelegram(env, `⚠️ <b>Error corriendo el bot de parqueo</b>\n${message}`);
  }
}

/** Corre en el cron diario: ¿hoy+PARSO_DAYS_AHEAD coincide con alguna fecha agendada
 * a mano con /schedule? Si sí, la reserva y la borra de la lista. Si no, no hace nada
 * (silencioso a propósito, para no mandar ruido a Telegram todos los días). */
async function checkPendingDate(env: Env): Promise<void> {
  const target = targetDateStr(env);
  const key = pendingKey(target);
  const found = await env.PENDING_DATES.get(key);
  if (!found) return;
  await env.PENDING_DATES.delete(key); // se consume una sola vez, aunque el cron corra dos veces ese día
  await runReservationFlow(env, target);
}

/** Días entre "hoy" (UTC) y una fecha YYYY-MM-DD, usados para validar /schedule. */
function daysUntil(dateStr: string, now: Date): number {
  const target = new Date(`${dateStr}T00:00:00.000Z`);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === ROUTINE_CRON) {
      ctx.waitUntil(runReservationFlow(env));
    } else if (event.cron === DAILY_CHECK_CRON) {
      ctx.waitUntil(checkPendingDate(env));
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    // GET /trigger?key=...[&date=YYYY-MM-DD] — corre YA MISMO.
    // Sin "date": reserva hoy + PARSO_DAYS_AHEAD. Con "date": esa fecha exacta, ya.
    // Solo tiene sentido si esa fecha realmente está dentro de la ventana de reserva
    // de Parso en este momento — si no, probablemente falle.
    if (url.pathname === "/trigger") {
      if (!key || key !== env.MANUAL_TRIGGER_KEY) {
        return new Response("No autorizado", { status: 401 });
      }
      const dateParam = url.searchParams.get("date") ?? undefined;
      if (dateParam && !DATE_RE.test(dateParam)) {
        return new Response("El parámetro date debe tener formato YYYY-MM-DD", { status: 400 });
      }
      ctx.waitUntil(runReservationFlow(env, dateParam));
      return new Response(
        `Disparado para ${dateParam ?? "la fecha calculada (hoy + PARSO_DAYS_AHEAD)"}. Revisá Telegram y \`wrangler tail\`.`
      );
    }

    // GET /schedule?key=...&date=YYYY-MM-DD — AGENDA esa fecha. No reserva ahora:
    // guarda la fecha, y el cron diario la va a disparar solo, automáticamente,
    // el día exacto en que se abra la ventana (fecha - PARSO_DAYS_AHEAD, a las 5:51am CR).
    if (url.pathname === "/schedule") {
      if (!key || key !== env.MANUAL_TRIGGER_KEY) {
        return new Response("No autorizado", { status: 401 });
      }
      const dateParam = url.searchParams.get("date");
      if (!dateParam || !DATE_RE.test(dateParam)) {
        return new Response("Falta ?date=YYYY-MM-DD", { status: 400 });
      }

      const daysAhead = Number(env.PARSO_DAYS_AHEAD);
      const diff = daysUntil(dateParam, new Date());

      if (diff < daysAhead) {
        return new Response(
          `${dateParam} ya está (o pronto va a estar) dentro de la ventana de reserva ` +
            `de Parso — usá /trigger?key=...&date=${dateParam} para reservarlo directamente ` +
            `en vez de agendarlo.`,
          { status: 400 }
        );
      }

      // Se guarda por un poco más de lo necesario, por si acaso; se borra solo al usarse.
      const ttlSeconds = (diff + 2) * 24 * 60 * 60;
      await env.PENDING_DATES.put(pendingKey(dateParam), new Date().toISOString(), {
        expirationTtl: ttlSeconds,
      });

      const openDate = new Date(`${dateParam}T00:00:00.000Z`);
      openDate.setUTCDate(openDate.getUTCDate() - daysAhead);
      const openDateStr = openDate.toISOString().slice(0, 10);

      ctx.waitUntil(
        notifyTelegram(
          env,
          `🗓️ <b>Reserva agendada</b>\n` +
            `Día a reservar: ${dateParam}\n` +
            `Se va a disparar solo, una vez, el ${openDateStr} a las 5:51am hora Costa Rica.`
        )
      );

      return new Response(
        `Agendado. Va a intentar reservar el ${dateParam} automáticamente el ` +
          `${openDateStr} a las 5:51am hora Costa Rica.`
      );
    }

    return new Response(
      "NoWorryPark activo.\n" +
        "GET /trigger?key=...[&date=YYYY-MM-DD] — corre ya mismo.\n" +
        "GET /schedule?key=...&date=YYYY-MM-DD — agenda una fecha futura puntual."
    );
  },
};