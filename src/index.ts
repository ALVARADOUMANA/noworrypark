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

async function runReservationFlow(env: Env, dateOverride?: string): Promise<void> {
  const dateStr = dateOverride ?? targetDateStr(env);
  const lots = lotPriorityList(env);
  const maxAttempts = Number(env.PARSO_MAX_ATTEMPTS);
  const retryDelayMs = Number(env.PARSO_RETRY_DELAY_SECONDS) * 1000;

  try {
    const auth = await login(env);
    const vehicleId = await getVehicleId(env, auth);

    let confirmed: Awaited<ReturnType<typeof findReservation>> = null;
    const attemptsLog: string[] = [];

    outer: for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const lotId of lots) {
        const result = await attemptReservation(env, auth, lotId, vehicleId, dateStr);
        const label = lotLabel(env, lotId);
        const detail = result.success
          ? "aceptado por la API, confirmando..."
          : `rechazado${result.messages.length ? `: ${result.messages.join("; ")}` : " (sin espacio disponible o error)"}`;
        attemptsLog.push(`ronda ${attempt} · ${label} · ${detail}`);

        // Esperamos un poco antes de confirmar: la reserva es async en el backend.
        await sleep(1500);
        confirmed = await findReservation(env, auth, dateStr);

        if (confirmed && confirmed.status !== "REJECTED") {
          break outer;
        }
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }

    if (confirmed && confirmed.status !== "REJECTED") {
      await notifyTelegram(
        env,
        `✅ <b>Parqueo reservado</b>\n` +
          `Día: ${dateStr}\n` +
          `Lote: ${confirmed.parking_lot?.name ?? confirmed.id}\n` +
          `Estado: ${confirmed.status}\n` +
          `Placa: ${env.PARSO_PLATE}`
      );
    } else {
      const lotNames = lots.map((id) => lotLabel(env, id)).join(", ");
      await notifyTelegram(
        env,
        `❌ <b>No se logró reservar parqueo</b> para el ${dateStr}.\n` +
          `Se intentaron ${maxAttempts} rondas en: ${lotNames}.\n` +
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

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReservationFlow(env));
  },

  // Endpoint manual: GET /trigger?key=TU_MANUAL_TRIGGER_KEY[&date=YYYY-MM-DD]
  // Sin "date", reserva el día que se habilita hoy (hoy + PARSO_DAYS_AHEAD).
  // Con "date", reserva exactamente esa fecha, ignorando el cálculo de días.
  // No lo dejes público sin la key — cualquiera podría dispararte reservas.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.MANUAL_TRIGGER_KEY) {
        return new Response("No autorizado", { status: 401 });
      }
      const dateParam = url.searchParams.get("date") ?? undefined;
      if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return new Response("El parámetro date debe tener formato YYYY-MM-DD", { status: 400 });
      }
      ctx.waitUntil(runReservationFlow(env, dateParam));
      return new Response(
        `Disparado para ${dateParam ?? "la fecha calculada (hoy + PARSO_DAYS_AHEAD)"}. Revisá Telegram y \`wrangler tail\`.`
      );
    }
    return new Response(
      "NoWorryPark activo. Usá /trigger?key=...[&date=YYYY-MM-DD] para probar manualmente."
    );
  },
};