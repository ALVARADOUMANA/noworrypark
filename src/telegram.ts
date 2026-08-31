import type { Env } from "./parso";

export async function notifyTelegram(env: Env, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    // Si Telegram falla no queremos que se pierda el error del flujo principal en los logs.
    console.error("No se pudo notificar por Telegram:", err);
  }
}
