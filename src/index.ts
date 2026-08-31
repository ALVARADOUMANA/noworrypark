import {
  Env,
  login,
  getVehicleId,
  targetDateStr,
  lotPriorityList,
  attemptReservation,
  findReservation,
  sleep,
} from "./parso";
import { notifyTelegram } from "./telegram";

async function runReservationFlow(env: Env): Promise<void> {
  const dateStr = targetDateStr(env);
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
        attemptsLog.push(
          `intento ${attempt} · lote ${lotId} · http ${result.httpOk ? "ok" : "error"}`
        );

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
      await notifyTelegram(
        env,
        `❌ <b>No se logró reservar parqueo</b> para el ${dateStr}.\n` +
          `Se intentaron ${maxAttempts} rondas en los lotes [${lots.join(", ")}].\n` +
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

  // Endpoint manual para pruebas: GET /trigger?key=TU_MANUAL_TRIGGER_KEY
  // No lo dejes público sin la key — cualquiera podría dispararte reservas.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.MANUAL_TRIGGER_KEY) {
        return new Response("No autorizado", { status: 401 });
      }
      ctx.waitUntil(runReservationFlow(env));
      return new Response("Disparado. Revisá Telegram y `wrangler tail` para ver el resultado.");
    }
    return new Response("NoWorryPark activo. Usá /trigger?key=... para probar manualmente.");
  },
};
