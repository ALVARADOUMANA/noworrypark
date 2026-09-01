export interface Env {
  PARSO_BASE_URL: string;
  PARSO_PLATE: string;
  PARSO_REASON: string;
  PARSO_ENTRY_TIME: string; // "HH:MM"
  PARSO_LOT_PRIORITY: string; // "1,80"
  PARSO_LOT_NAMES: string; // "1:Plaza Roble,80:RCC Roble"
  PARSO_DAYS_AHEAD: string;
  PARSO_MAX_ATTEMPTS: string;
  PARSO_RETRY_DELAY_SECONDS: string;

  PARSO_EMAIL: string;
  PARSO_PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  MANUAL_TRIGGER_KEY: string;
}

export interface AuthHeaders {
  "access-token": string;
  client: string;
  uid: string;
  "token-type": "Bearer";
}

const COMMON_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://app.corporateexperience.parso.co",
  referer: "https://app.corporateexperience.parso.co/",
};

export async function login(env: Env): Promise<AuthHeaders> {
  const res = await fetch(`${env.PARSO_BASE_URL}/api/auth/sign_in`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ email: env.PARSO_EMAIL, password: env.PARSO_PASSWORD }),
  });

  const accessToken = res.headers.get("access-token");
  const client = res.headers.get("client");
  const uid = res.headers.get("uid");

  if (!res.ok || !accessToken || !client || !uid) {
    const body = await res.text().catch(() => "");
    throw new Error(`Login falló (status ${res.status}): ${body.slice(0, 300)}`);
  }

  return { "access-token": accessToken, client, uid, "token-type": "Bearer" };
}

export async function getVehicleId(env: Env, auth: AuthHeaders): Promise<number> {
  const res = await fetch(`${env.PARSO_BASE_URL}/api/vehicles`, {
    headers: { ...COMMON_HEADERS, ...auth },
  });
  const data = (await res.json()) as {
    success: boolean;
    vehicles: { id: number; license_plate: string }[];
  };
  const match = data.vehicles?.find((v) => v.license_plate === env.PARSO_PLATE);
  if (!match) {
    throw new Error(
      `No se encontró la placa ${env.PARSO_PLATE} en /api/vehicles. Placas disponibles: ${data.vehicles
        ?.map((v) => v.license_plate)
        .join(", ")}`
    );
  }
  return match.id;
}

/** Fecha objetivo (YYYY-MM-DD) que se habilita hoy: hoy + PARSO_DAYS_AHEAD días. */
export function targetDateStr(env: Env, now: Date = new Date()): string {
  const daysAhead = Number(env.PARSO_DAYS_AHEAD);
  const target = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  // El Worker corre a las 11:56 UTC (5:56am CR), muy lejos de medianoche,
  // así que usar el componente de fecha en UTC es seguro acá.
  return target.toISOString().slice(0, 10);
}

export function lotPriorityList(env: Env): number[] {
  return env.PARSO_LOT_PRIORITY.split(",").map((s) => Number(s.trim()));
}

/** "1:Plaza Roble,80:RCC Roble" -> { 1: "Plaza Roble", 80: "RCC Roble" } */
export function lotNameMap(env: Env): Record<number, string> {
  const map: Record<number, string> = {};
  for (const pair of env.PARSO_LOT_NAMES.split(",")) {
    const [idStr, ...nameParts] = pair.split(":");
    const id = Number(idStr.trim());
    if (!Number.isNaN(id) && nameParts.length) map[id] = nameParts.join(":").trim();
  }
  return map;
}

export function lotLabel(env: Env, lotId: number): string {
  return lotNameMap(env)[lotId] ?? `lote ${lotId}`;
}

interface ReservationAttemptResult {
  lotId: number;
  httpOk: boolean;
  success: boolean;
  messages: string[];
  raw: unknown;
}

export async function attemptReservation(
  env: Env,
  auth: AuthHeaders,
  lotId: number,
  vehicleId: number,
  dateStr: string
): Promise<ReservationAttemptResult> {
  const res = await fetch(`${env.PARSO_BASE_URL}/api/parking_reservations/multiples`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      parking_reservation: {
        parking_lot_id: lotId,
        reason: env.PARSO_REASON,
        vehicle_id: vehicleId,
        entry_time: `${dateStr}T${env.PARSO_ENTRY_TIME}:00.000`,
      },
      dates: [dateStr],
    }),
  });
  const raw = (await res.json().catch(() => null)) as
    | { success?: boolean; messages?: string[] }
    | null;
  return {
    lotId,
    httpOk: res.ok,
    success: Boolean(raw?.success),
    messages: raw?.messages ?? [],
    raw,
  };
}

export interface ConfirmedReservation {
  id: number;
  status: string; // "APPROVED" | "PENDING" | "REJECTED" | ...
  parking_lot: { id: number; name: string };
  reservation_date: string;
}

/** Busca en /api/reservations una reserva para dateStr y devuelve su estado real. */
export async function findReservation(
  env: Env,
  auth: AuthHeaders,
  dateStr: string
): Promise<ConfirmedReservation | null> {
  const res = await fetch(`${env.PARSO_BASE_URL}/api/reservations`, {
    headers: { ...COMMON_HEADERS, ...auth },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { reservations?: ConfirmedReservation[] };
  return data.reservations?.find((r) => r.reservation_date === dateStr) ?? null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}